import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  canonicalPath,
  DELEGATE_TREES,
  exec,
  gitProbeEnv,
  isWithin,
} from "./fsx.ts";
import {
  createAgentSession,
  defineTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  CHILD_TOOLS,
  DELEGATE_TOOL_NAMES,
  expandTools,
  isWriter,
  SUBAGENT_FRAMING,
  type ProfileCatalog,
} from "./profiles.ts";
import { configPathOf, configuredModelFor, type DelegateConfig } from "./config.ts";
import {
  partitionExtensionLoadFailures,
  resolveProviderExtensionPaths,
  type ProviderExtensionCache,
} from "./provider-extensions.ts";
import { resumeTagOf } from "./format.ts";
import { resolveDependencyGraph } from "./graph.ts";
import type { TaskInput } from "./validation.ts";
import type { ResolvedTask, Workspace } from "./types.ts";

/**
 * The parent session's ModelRuntime. `ExtensionContext` exposes only the
 * ModelRegistry facade; the wrapped runtime is the same object the parent
 * streams through, and subagents must share it so runtime-registered
 * providers (and their auth) apply to child sessions. The field is
 * TypeScript-private; the guard proves the grabbed value is the real
 * `ModelRuntime` class — not merely present — so an upstream reshuffle
 * fails loudly here instead of mis-wiring child sessions. Tracked upstream
 * as earendil-works/pi#8791 (expose the model runtime to extensions); when
 * it lands, delete the grab. Patching pi-coding-agent locally via
 * patchedDependencies was deliberately rejected: patch rot on every Pi
 * release outweighs one loud, contained failure.
 */
export function parentModelRuntime(ctx: ExtensionContext): ModelRuntime {
  const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown })
    .runtime;
  if (!(runtime instanceof ModelRuntime)) {
    throw new Error(
      "delegate cannot reach the parent session's model runtime; subagent dispatch is unavailable.",
    );
  }
  return runtime;
}

/** Everything task resolution and child construction need from the host. */
/** The parent's user-authored prompt inputs, captured at each turn start. */
export interface ParentPromptInputs {
  readonly customPrompt: string | undefined;
  readonly appendSystemPrompt: string | undefined;
  /** An extension force-replaced the parent's prompt wholesale. */
  readonly forced: boolean;
}

/**
 * Source for the parent's prompt inputs. `inputs()` returns the latest
 * captured values (undefined before the first turn — impossible during a
 * dispatch, but defensive); `warnForcedInheritanceSkip()` logs once per
 * extension instance when composition must skip inheritance because the
 * parent's prompt was force-replaced.
 */
export interface ParentPromptService {
  inputs(): ParentPromptInputs | undefined;
  warnForcedInheritanceSkip(): void;
}

export interface HostEnvironment {
  readonly ctx: ExtensionContext;
  readonly modelRuntime: ModelRuntime;
  readonly agentDir: string;
  readonly getActiveTools: () => readonly string[];
  readonly parentPrompt: ParentPromptService;
}

/**
 * Assemble the host environment from an already-resolved agent directory:
 * the dispatch pipeline resolves the agent dir once (its fallback warning
 * needs the provenance) and threads it here, so no path re-derives it.
 */
export function hostEnvironment(
  ctx: ExtensionContext,
  agentDir: string,
  getActiveTools: () => readonly string[],
  parentPrompt: ParentPromptService,
): HostEnvironment {
  return {
    ctx,
    modelRuntime: parentModelRuntime(ctx),
    agentDir,
    getActiveTools,
    parentPrompt,
  };
}

// Probes fail fast and produce tiny output; the shared exec takes explicit
// limits so the per-use divergence from snapshot-sized traffic stays visible.
const PROBE_EXEC = { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 } as const;

/** Probe failure carrying Git's stderr for fail-closed classification. */
class GitProbeError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * The scopes a task's writes can reach. Inside a Git worktree the top-level
 * is the reservation root (writes anywhere in it overlap); outside Git the
 * cwd itself is. An external `core.worktree` can put the top-level outside
 * the physical cwd — then the cwd stays reachable and is a second root.
 *
 * Fails closed: only Git's explicit "not a repository" permits the cwd-only
 * fallback. Git being unavailable, erroring, or returning an empty root is
 * ambiguous scope — an error, not a narrower reservation. The probe runs
 * with all `GIT_*` inherited redirects scrubbed so a polluted environment
 * cannot shrink the discovered scope.
 */
export async function writeRootsOf(cwd: string): Promise<readonly string[]> {
  const physicalCwd = canonicalPath(cwd);
  let top: string;
  try {
    top = (
      await exec("git", ["-C", physicalCwd, "rev-parse", "--show-toplevel"], {
        ...PROBE_EXEC,
        env: gitProbeEnv(),
        errorClass: GitProbeError,
      })
    ).stdout.trim();
  } catch (error) {
    const stderr = error instanceof GitProbeError ? error.stderr.trim() : "";
    if (/not a git repository/i.test(stderr)) {
      return [physicalCwd];
    }
    const detail =
      stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Could not safely determine the Git scope for '${physicalCwd}': ${detail}. ` +
        `Refusing to admit shared-write tasks with an ambiguous write scope.`,
    );
  }
  if (!top) {
    throw new Error(
      `Could not safely determine the Git scope for '${physicalCwd}': git returned an empty repository root. ` +
        `Refusing to admit shared-write tasks with an ambiguous write scope.`,
    );
  }
  const root = canonicalPath(top);
  return isWithin(root, physicalCwd) ? [root] : [root, physicalCwd];
}

const GLOBAL_CONTEXT_FILES = new Set([
  "agents.override.md",
  "agents.md",
  "claude.override.md",
  "claude.md",
]);

/** User-global harness instructions are not inherited by subagents. */
function isGlobalContextFile(filePath: string, agentDir: string): boolean {
  const resolved = resolve(filePath);
  for (const root of [resolve(agentDir), resolve(homedir(), ".agents")]) {
    if (GLOBAL_CONTEXT_FILES.has(relative(root, resolved).toLowerCase()))
      return true;
  }
  return false;
}

/**
 * Resolve a task `cwd` against the parent cwd, with v1 tilde parity: a
 * bare `~` or `~/`-prefixed path expands against the home directory
 * first (tilde paths ignore the parent cwd, like absolute paths). Other
 * tilde-prefixed inputs like `~user` do not expand and resolve relative
 * to `base`.
 */
function resolveTaskCwd(input: string, base: string): string {
  const expanded =
    input === "~" || input.startsWith("~/")
      ? join(homedir(), input.slice(1))
      : input;
  return resolve(base, expanded);
}

function resolveModel(
  spec: string,
  env: HostEnvironment,
): Model<Api> | undefined {
  // Lookups go through the public ModelRegistry facade; the private runtime
  // grab (env.modelRuntime) exists solely to hand child sessions the parent's
  // runtime so registered providers and auth carry over.
  const registry = env.ctx.modelRegistry;
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const exact = registry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (exact) return exact;
  }
  const wanted = spec.toLowerCase();
  for (const model of registry.getAvailable()) {
    if (
      `${model.provider}/${model.id}`.toLowerCase() === wanted ||
      model.id.toLowerCase() === wanted
    ) {
      return model;
    }
  }
  return undefined;
}

const RESUME_DEFAULT_PROMPT =
  "Continue from where you left off. Pick up the task and keep going.";

/**
 * Resolve validated task inputs into executable tasks: agent profile, model,
 * tools, absolute cwd, and the shared-write reservation roots. Everything
 * that can fail is resolved here, before admission and before execution.
 *
 * Model and effort policy: callers select neither. A named agent runs on
 * the pin configured for it under "modelsByParent" (when the parent matches)
 * or "models" in the user-global delegate.json — the pin's `:effort` sets
 * the child's thinking level; everything else — inline tasks, the `default`
 * profile, and unpinned named agents — mirrors the parent's model at the
 * parent's thinking level, and a bare pin to a different model runs at that
 * model's default. The model registry knowing a reference is not
 * authorization — only the user's configuration is.
 */
export async function resolveTasks(
  tasks: readonly TaskInput[],
  env: HostEnvironment,
  config: DelegateConfig,
  catalog: ProfileCatalog,
): Promise<ResolvedTask[]> {
  let parentActive: string[] = [];
  // Explicit `default` mirrors
  // the parent's active tools; an omitted agent is an inline task with the
  // standard tool set. web_search passes the mirror filter so a parent
  // that has it (through its own provider extension) can hand it to a
  // child whose provider resolved an extension allowlist — tasks without
  // one strip it per-task below.
  if (tasks.some((task) => task.agent === "default" && task.tools === undefined)) {
    try {
      parentActive = env
        .getActiveTools()
        .filter((name) => (CHILD_TOOLS as readonly string[]).includes(name) || name === "web_search");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message =
        `Cannot resolve default-profile parent tools: ${detail}. ` +
        `Restore the parent tool inventory or supply explicit tools for every default-profile task.`;
      console.error(`[delegate] ${message}`, error);
      throw new Error(message, { cause: error });
    }
  }

  // The graph was validated in validation.ts; resolution re-derives the
  // same ids to attach dependency indexes and phases to each task.
  const graph = resolveDependencyGraph(tasks);

  // #59: provider-extension resolution + verification runs at dispatch —
  // a required-source failure rejects the whole call before any child
  // starts. The map is the dispatch-scoped absence/verification cache:
  // `getInstalledPath` can spawn `npm root -g`, so a fan-out shares one
  // probe per (provider, cwd) instead of one per task.
  const extensionCache: ProviderExtensionCache = new Map();
  // Load probes (below, per task) dedupe on resolution identity: the
  // cache returns the same object for every task sharing a provider+cwd,
  // so each distinct resolution loads exactly once per dispatch — and a
  // failure's error names the provider whose allowlist required it.
  const probedExtensions = new Set<
    NonNullable<ResolvedTask["providerExtensions"]>
  >();

  const resolved: ResolvedTask[] = [];
  for (const [index, task] of tasks.entries()) {
    const where = `tasks[${index}]${task.id ? ` (id '${task.id}')` : ""}`;
    const agent = task.agent;
    const profile = agent ? catalog.profiles.get(agent) : undefined;
    if (agent && !profile) {
      throw new Error(
        `${where}: unknown agent '${agent}'. Known agents: ${[...catalog.profiles.keys()].join(", ")}.`,
      );
    }

    // Model selection is user-only and inheritance-first: a named agent uses
    // its delegate.json pin (parent-scoped wins over unscoped), else its
    // profile's frontmatter `model`, else the parent's model; inline/default
    // tasks always mirror the parent. Caller-supplied model and thinking
    // fields were rejected in validation.
    const parentModel = env.ctx.model as Model<Api> | undefined;
    const parentKey =
      parentModel === undefined
        ? undefined
        : `${parentModel.provider}/${parentModel.id}`.toLowerCase();
    // Config pins resolve against the exact built-in or authored profile name.
    const agentName = agent ?? "default";
    const assignment = configuredModelFor(agent, parentKey, config);
    const modelRef = assignment?.ref ?? profile?.modelPin;
    const model =
      modelRef !== undefined ? resolveModel(modelRef, env) : parentModel;
    if (!model) {
      throw new Error(
        assignment
          ? `${where}: ${assignment.origin} is configured as '${assignment.ref}' in ${configPathOf(env.agentDir)} but is not available in this session's model registry.`
          : modelRef !== undefined
            ? `${where}: agent profile ${profile?.source ?? `'${agentName}'`} pins model '${modelRef}' but it is not available in this session's model registry.`
            : agentName === "default"
              ? `${where}: no parent model is selected — inline/default tasks inherit it and are not configurable otherwise.`
              : `${where}: no model is configured for agent '${agentName}' and no parent model is selected; add models.${agentName} under "models" in ${configPathOf(env.agentDir)}.`,
      );
    }
    // Effort: the pin's :effort wins; else the profile default; else the
    // parent's live level when the child runs the parent's model; else the
    // model's own default.
    // Case-insensitive on purpose, like config matching: a host-set parent
    // model whose provider/id casing differs from the registry's must not
    // cost the child the parent's live effort level.
    const runsParentModel =
      parentModel !== undefined &&
      model.provider.toLowerCase() === parentModel.provider.toLowerCase() &&
      model.id.toLowerCase() === parentModel.id.toLowerCase();
    const thinking =
      assignment?.thinking ??
      profile?.thinking ??
      (runsParentModel ? env.ctx.thinkingLevel : undefined);

    const cwd = task.cwd ? resolveTaskCwd(task.cwd, env.ctx.cwd) : env.ctx.cwd;
    if (!existsSync(cwd)) {
      throw new Error(`${where}: cwd does not exist: '${cwd}'.`);
    }

    // #59: provider-scoped extension resolution runs against the task's
    // RESOLVED provider — after model pins and profile frontmatter — and
    // the task's own cwd. A required-source failure here rejects the
    // whole dispatch before any child starts; shipped best-effort
    // defaults that miss degrade silently to an empty path set.
    let providerExtensions: ResolvedTask["providerExtensions"];
    try {
      providerExtensions = await resolveProviderExtensionPaths(
        model.provider,
        cwd,
        env.agentDir,
        config,
        extensionCache,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${where}: ${detail}`, { cause: error });
    }
    const hasProviderExtensions =
      providerExtensions !== undefined && providerExtensions.paths.size > 0;
    let tools: string[] | string;
    if (task.tools !== undefined) {
      tools = expandTools(task.tools, {
        providerExtensions: hasProviderExtensions,
      });
    } else if (agent === "default") {
      tools = parentActive;
    } else if (profile?.tools) {
      tools = [...profile.tools];
    } else {
      tools = expandTools(undefined);
    }
    if (typeof tools === "string") {
      throw new Error(`${where}: ${tools}`);
    }
    // #45 belt: no inventory source may surface the delegate family to a
    // child — expandTools strips it on entry and the parent mirror never
    // carries it; this is the structural backstop over profile inventories.
    tools = tools.filter((tool) => !DELEGATE_TOOL_NAMES.has(tool));
    if (!hasProviderExtensions) {
      // A mirrored or authored web_search without a supplying provider
      // extension could never activate — strip it so the task's declared
      // inventory stays honest (it was never loadable anyway).
      tools = tools.filter((tool) => tool !== "web_search");
    }

    const workspace: Workspace = task.workspace ?? "shared";
    if (workspace === "scratch" && !isWriter(tools)) {
      throw new Error(
        `${where}: workspace "scratch" copies the tree for a task whose tools are all read-only — the copy buys nothing. Omit workspace to run in the source tree, or add write-capable tools.`,
      );
    }
    const reserves =
      (workspace === "shared" && isWriter(tools)) || workspace === "isolated";

    const prompt = task.prompt ?? (task.resumeFrom ? RESUME_DEFAULT_PROMPT : "");

    // Child base prompt (SPEC "Child base prompt"). Authored text — an
    // explicit task systemPrompt or a Markdown profile body — is used
    // verbatim with nothing appended. Everything else (inline tasks and
    // built-in profiles) composes: the parent's user-authored prompt inputs
    // (custom base prompt replacing the stock prefix, plus user-appended
    // text), the built-in role line, and the fixed framing. Extension-
    // contributed sections, guidelines, and tool documentation are never
    // inherited — the structured prompt inputs expose only the user-authored
    // fields here, and the child session builds tool docs from its own
    // inventory. A force-replaced parent prompt disables inheritance.
    const authoredPrompt = task.systemPrompt ?? profile?.systemPrompt;
    let systemPrompt: string | undefined;
    const promptAppend: string[] = [];
    if (authoredPrompt !== undefined) {
      systemPrompt = authoredPrompt;
    } else {
      const parentInputs = env.parentPrompt.inputs();
      if (parentInputs?.forced) {
        env.parentPrompt.warnForcedInheritanceSkip();
      } else if (parentInputs !== undefined) {
        if (parentInputs.customPrompt?.trim()) systemPrompt = parentInputs.customPrompt;
        const parentAppend = parentInputs.appendSystemPrompt?.trim()
          ? parentInputs.appendSystemPrompt
          : undefined;
        if (parentAppend !== undefined) promptAppend.push(parentAppend);
      }
      const role = profile?.role;
      if (role !== undefined) promptAppend.push(role);
      promptAppend.push(SUBAGENT_FRAMING);
    }

    // Display identity for a resume: the tag derives from the path the
    // caller wrote (before admission canonicalizes it), so every view
    // agrees and symlink aliases read identically. An omitted agent label
    // carries the resume identity itself (`resume:<tag>`), mirroring v1.
    const resumeTag =
      task.resumeFrom !== undefined ? resumeTagOf(task.resumeFrom) : undefined;

    const resolvedTask = {
      index,
      id: task.id ?? `task-${index + 1}`,
      prompt,
      agent:
        agent ??
        (resumeTag !== undefined ? `resume:${resumeTag}` : "inline"),
      aliasedFrom: undefined,
      normalizedFrom: undefined,
      description: task.description,
      cwd: canonicalPath(cwd),
      model,
      thinking,
      tools,
      providerExtensions,
      systemPrompt,
      appendSystemPrompt: promptAppend,
      sessionId: task.sessionId,
      resumeFrom: task.resumeFrom,
      resumeTag,
      deadlineMs: task.deadlineMs,
      workspace,
      writeRoots: reserves ? await writeRootsOf(cwd) : undefined,
      dependsOn: graph.deps[index]!,
      phase: graph.phases[index]!,
    } satisfies ResolvedTask;
    resolved.push(resolvedTask);

    // #59 fail-closed probe: a required root that fails to LOAD (not
    // merely to resolve or verify) must also reject the whole dispatch
    // before any child starts — "delegation stopped" is a whole-call
    // rejection, not a per-task outcome that lets siblings begin. The
    // probe uses the same loader the attempt will build, so the checked
    // configuration is the run configuration. runTask still reloads per
    // attempt for session-state isolation and to catch a root that
    // changed between resolve and run. Resolutions whose roots are all
    // best-effort skip the probe — their load failures degrade silently
    // per #59 and the attempt path owns them.
    if (
      providerExtensions !== undefined &&
      !probedExtensions.has(providerExtensions) &&
      [...providerExtensions.paths].some(
        (root) => !providerExtensions.bestEffortPaths.has(root),
      )
    ) {
      probedExtensions.add(providerExtensions);
      try {
        await loadSubagentResources(resolvedTask, env);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${where}: ${detail}`, { cause: error });
      }
    }
  }
  return resolved;
}

/**
 * Create a subagent session for one resolved task. Subagents are headless
 * workers: no extensions, no user-global context files. One-shot scratch
 * and isolated tasks use an in-memory transcript — a discarded filesystem
 * must not advertise a resumable conversation. Shared-workspace one-shots
 * and `sessionId` tasks get a durable file under
 * `<agentDir>/delegate-sessions/` (a `resumeFrom` transcript already is
 * one): a failed fresh run leaves its transcript on disk as the recovery
 * record `resumeFrom` can continue. The session streams through the
 * parent session's model runtime so provider registrations and auth are
 * inherited.
 */
export async function createSubagentSession(
  task: ResolvedTask,
  env: HostEnvironment,
  resourceLoader: DefaultResourceLoader,
  askParent: (question: string, signal: AbortSignal) => Promise<string>,
  /**
   * A pooled session's own transcript reloading after an idle unload
   * (#46) — distinct from `task.resumeFrom` (caller-requested resume into
   * a fresh task). Checkout already proved the frozen configuration
   * matches; the open continues the same conversation transparently.
   */
  resumeFile?: string,
): Promise<AgentSession> {
  const reopen = resumeFile ?? task.resumeFrom;
  const sessionManager =
    reopen !== undefined
      ? SessionManager.open(reopen)
      : task.sessionId !== undefined || task.workspace === "shared"
        ? SessionManager.create(
            task.cwd,
            join(env.agentDir, DELEGATE_TREES.sessions),
          )
        : SessionManager.inMemory(task.cwd);
  // Pi's default per-turn retry (three attempts with a two-second backoff)
  // runs before Delegate can inspect the final error. In particular it would
  // immediately retry a provider-supplied hour-long reset window. This is
  // an in-memory child setting, not the parent's/global settings; Delegate
  // owns bounded, side-effect-aware whole-task retry instead.
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setRetryEnabled(false);
  const { session } = await createAgentSession({
    cwd: task.cwd,
    agentDir: env.agentDir,
    modelRuntime: env.modelRuntime,
    model: task.model,
    thinkingLevel: task.thinking,
    tools: [...task.tools, "ask_parent"],
    customTools: [
      defineTool({
        name: "ask_parent",
        label: "Ask Parent",
        description: "Ask the parent a question and wait for its explicit answer. Use as the only tool call in this turn; it is available only on async tickets.",
        parameters: Type.Object({ question: Type.String({ minLength: 1 }) }),
        execute: async (_id, params, signal) => ({
          content: [{ type: "text" as const, text: await askParent(params.question, signal ?? new AbortController().signal) }],
          details: {},
        }),
      }),
    ],
    sessionManager,
    settingsManager,
    resourceLoader,
  });
  return session;
}

/**
 * A resource loader for one task: no extensions beyond the verified
 * provider-extension roots (subagents must not inherit the parent's
 * interactive extension inventory — including this tool), no user-global
 * context files; project context under the task cwd is kept.
 *
 * `noExtensions` stays on even with `additionalExtensionPaths`: in Pi
 * 0.87 the flag only excludes the user/project extension inventory —
 * CLI/additional paths still resolve and load — so the child receives
 * exactly the allowlisted roots and nothing else.
 */
export function createSubagentResourceLoader(
  task: ResolvedTask,
  env: HostEnvironment,
  additionalExtensionPaths?: readonly string[],
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: task.cwd,
    agentDir: env.agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    ...(additionalExtensionPaths !== undefined &&
      additionalExtensionPaths.length > 0
      ? { additionalExtensionPaths: [...additionalExtensionPaths] }
      : {}),
    agentsFilesOverride: ({ agentsFiles }) => ({
      agentsFiles: agentsFiles.filter(
        ({ path }) => !isGlobalContextFile(path, env.agentDir),
      ),
    }),
    ...(task.systemPrompt !== undefined
      ? { systemPrompt: task.systemPrompt }
      : {}),
    ...(task.appendSystemPrompt.length > 0
      ? { appendSystemPrompt: [...task.appendSystemPrompt] }
      : {}),
  });
}

/**
 * Build and load one task's resource loader, retrying without any
 * best-effort provider-extension root that failed to load (v1 host.ts
 * `loadChildResources`; the roots were resolved and verified at dispatch
 * by `resolveProviderExtensionPaths` — this is only the load step).
 *
 * A dropped default leaves the subagent extension-free on Pi's native
 * compaction — silently, per the drop-site rationale in
 * `provider-extensions.ts`. User-configured roots still fail closed.
 *
 * Loop invariant: Pi's `reload()` never *throws* for an extension's own
 * failure — its loader wraps module import and factory invocation in
 * try/catch and returns them as `extensionsResult.errors` (verified in
 * pi 0.87, core/extensions/loader.js). A reload() throw is therefore
 * environmental (settings reload, package resolution) and not
 * attributable to any supplied root; letting it propagate is correct
 * even when best-effort roots are present.
 *
 * Extension-bearing loaders are never shared or pooled: the extension
 * runtime binds mutable per-session state, so every attempt builds a
 * fresh loader.
 */
export async function loadSubagentResources(
  task: ResolvedTask,
  env: HostEnvironment,
): Promise<DefaultResourceLoader> {
  const providerExtensions = task.providerExtensions;
  let extensionPaths = [...(providerExtensions?.paths ?? [])];
  for (;;) {
    const resourceLoader = createSubagentResourceLoader(
      task,
      env,
      extensionPaths,
    );
    await resourceLoader.reload();

    const extensionsResult = resourceLoader.getExtensions();
    const { fatalCount, droppableRoots } = partitionExtensionLoadFailures({
      extensionPaths,
      loadedExtensionPaths: extensionsResult.extensions.map(
        (extension) => extension.resolvedPath || extension.path,
      ),
      extensionErrors: extensionsResult.errors,
      bestEffortRoots: providerExtensions?.bestEffortPaths ?? new Set(),
    });
    if (fatalCount > 0) {
      const providerName =
        task.model.provider.trim() || "the selected provider";
      throw new Error(
        `Failed to load ${fatalCount} allowlisted provider extension(s) for ${providerName}; delegation stopped instead of running without the required integration.`,
      );
    }

    if (droppableRoots.length > 0) {
      extensionPaths = extensionPaths.filter(
        (root) => !droppableRoots.includes(root),
      );
      continue;
    }

    return resourceLoader;
  }
}
