// #122 public-tool regression: all source/runtime files here are synthetic.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
} from "./pi-boundary.ts";

const source = process.env.DIAGNOSTIC_SOURCE_FIXTURE!;
const primary = join(
  process.env.DIAGNOSTIC_PI_FIXTURE!,
  "delegate-diagnostics",
);
const fallback = join(
  process.env.TMPDIR!,
  `pi-delegate-diagnostics-${process.getuid?.()}-${process.pid}`,
);
const destination = process.argv[2] === "fallback" ? fallback : primary;
const sentinel = "SYNTHETIC_DIAGNOSTIC_RECORD_" + randomUUID();
// Public process boundary race probe: another PID's namespace is created only
// after file discovery, immediately before the first private-index git add.
const realGit = Bun.which("git")!;
const shim = join(dirname(source), "git-shim");
const raceMarker = join(dirname(source), "race-fired");
mkdirSync(shim, { mode: 0o700 });
const quote = (value: string): string =>
  "'" + value.replaceAll("'", "'\\''") + "'";
writeFileSync(
  join(shim, "git"),
  `#!/bin/sh
if [ -n "$GIT_INDEX_FILE" ] && [ "$1" = add ] && [ ! -e ${quote(raceMarker)} ]; then
  mkdir -p -m 700 "$DIAGNOSTIC_SOURCE_FIXTURE/temp/pi-delegate-diagnostics-123-789"
  printf '%s\\n' "$DIAGNOSTIC_RACE_SENTINEL" > "$DIAGNOSTIC_SOURCE_FIXTURE/temp/pi-delegate-diagnostics-123-789/789.jsonl"
  touch ${quote(raceMarker)}
fi
exec ${quote(realGit)} "$@"
`,
  { mode: 0o700 },
);
process.env.PATH = `${shim}:${process.env.PATH}`;
process.env.DIAGNOSTIC_RACE_SENTINEL = sentinel;
const git = (...args: string[]): string =>
  execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};
mkdirSync(source, { recursive: true, mode: 0o700 });
assert(
  getAgentDir() === process.env.DIAGNOSTIC_PI_FIXTURE,
  "Not using synthetic default Pi directory",
);
mkdirSync(process.env.DIAGNOSTIC_PI_FIXTURE!, { recursive: true, mode: 0o700 });
mkdirSync(process.env.TMPDIR!, { recursive: true, mode: 0o700 });
if (destination === fallback)
  writeFileSync(primary, "SYNTHETIC_BLOCKED_PRIMARY", { mode: 0o600 });
git("init", "-q");
git("config", "user.email", "fixture@example.invalid");
git("config", "user.name", "Fixture");
git("config", "filter.fixture.clean", "sed s/WORKTREE/CLEAN/g");
const trackedOdd = ":(exclude)literal\nname*.txt";
const untrackedOdd = "untracked\n[odd].txt";
// On POSIX the backslashes are filename characters, not runtime directories.
const backslashName = "prefix\\delegate-diagnostics\\notes.txt";
writeFileSync(join(source, backslashName), "ORDINARY_POSIX_FILENAME");
writeFileSync(join(source, trackedOdd), "ORIGINAL");
writeFileSync(join(source, "deleted.txt"), "DELETE_CONTROL");
writeFileSync(join(source, "filtered.txt"), "WORKTREE");
writeFileSync(join(source, ".gitattributes"), "filtered.txt filter=fixture\n");
writeFileSync(join(source, "ordinary.txt"), "ORDINARY_SOURCE");
writeFileSync(
  join(source, "delegate-diagnostics.md"),
  "ORDINARY_DIAGNOSTIC_GUIDE",
);
mkdirSync(join(source, "pi-delegate-diagnostics-guide"));
writeFileSync(
  join(source, "pi-delegate-diagnostics-guide", "source.txt"),
  "ORDINARY_GUIDE_DIRECTORY",
);
git(
  "--literal-pathspecs",
  "add",
  "ordinary.txt",
  "delegate-diagnostics.md",
  "pi-delegate-diagnostics-guide",
  trackedOdd,
  backslashName,
  "deleted.txt",
  "filtered.txt",
  ".gitattributes",
);
git("commit", "-qm", "synthetic source");
writeFileSync(join(source, trackedOdd), "DIRTY");
writeFileSync(join(source, untrackedOdd), "UNTRACKED");
rmSync(join(source, "deleted.txt"));

const session = await openDelegateBoundary();
try {
  const engine = process.env.DIAGNOSTIC_ENGINE_FIXTURE!;
  assert(
    engine !== getAgentDir(),
    "Engine and diagnostic bases accidentally agree",
  );
  mkdirSync(engine, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(engine, "delegate.json"),
    JSON.stringify({ surface: "full", telemetry: { enabled: true } }),
  );
  mkdirSync(join(engine, "delegate-usage.db")); // Operational error through registered dispatch.
  const host = session.session as AgentSession;
  host.sessionManager.getSessionDir = () =>
    join(engine, "sessions", "--fixture--");
  await host.extensionRunner.emit({ type: "session_start", reason: "reload" });
  assert(
    existsSync(join(destination, `${process.pid}.jsonl`)),
    "Actual diagnostic destination not used",
  );
  appendFileSync(
    join(destination, `${process.pid}.jsonl`),
    JSON.stringify({ synthetic: sentinel }) + "\n",
  );
  const prior = join(source, "nested", "pi-delegate-diagnostics-123-456");
  mkdirSync(prior, { recursive: true, mode: 0o700 });
  writeFileSync(join(prior, "456.jsonl"), sentinel);
  symlinkSync(destination, join(source, "runtime-alias"));
  // Also cover read-tree seeded runtime entries without storing the new sentinel
  // in HEAD: the private baseline must drop existing tracked namespace entries.
  mkdirSync(join(source, "tracked", "delegate-diagnostics"), {
    recursive: true,
  });
  writeFileSync(
    join(source, "tracked", "delegate-diagnostics", "old.jsonl"),
    "SYNTHETIC_OLD_RUNTIME",
  );
  git("add", "tracked/delegate-diagnostics/old.jsonl");
  git("commit", "-qm", "synthetic tracked runtime");
  appendFileSync(
    join(source, "tracked", "delegate-diagnostics", "old.jsonl"),
    sentinel,
  );

  const model = await installSubagentModel(session);
  for (const workspace of ["isolated", "scratch"]) {
    // Inspect the worker's actual copy and mutate only synthetic source runtime
    // records during its shell window. This must be neither drift nor attribution.
    const filterExpectation = workspace === "isolated" ? "CLEAN" : "WORKTREE";
    const probe = `grep -q ORDINARY_POSIX_FILENAME ${quote(backslashName)} && grep -q DIRTY ${quote(trackedOdd)} && test -f ${quote(untrackedOdd)} && test ! -e deleted.txt && grep -q ${filterExpectation} filtered.txt && test -f ordinary.txt && test -f delegate-diagnostics.md && test -f pi-delegate-diagnostics-guide/source.txt && test ! -e runtime-alias && test ! -e tracked/delegate-diagnostics && test ! -e nested/pi-delegate-diagnostics-123-456 && test ! -e home/.pi/agent/delegate-diagnostics && test ! -e temp/pi-delegate-diagnostics-${process.getuid?.()}-${process.pid} && test ! -e temp/pi-delegate-diagnostics-123-789 && printf COPY_OMITS_RUNTIME`;
    let observedTools: { isError: boolean; content: unknown }[] = [];
    const control = `escape-${workspace}.txt`;
    const finish: FauxResponseFactory = (context) => {
      observedTools = context.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => ({
          isError: message.isError,
          content: message.content,
        }));
      return fauxAssistantMessage("WORKSPACE_DONE");
    };
    model.respond([
      fauxAssistantMessage([fauxToolCall("bash", { command: probe })]),
      fauxAssistantMessage([
        fauxToolCall("bash", {
          command: `printf '%s\\n' '${sentinel}_DURING_RUN' >> '${join(destination, `${process.pid}.jsonl`)}'; printf CONTROL > '${join(source, control)}'`,
        }),
      ]),
      finish,
    ]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [
        {
          prompt: "synthetic copy probe",
          cwd: source,
          workspace,
          tools: ["bash"],
        },
      ],
    });
    assert(!result.isError, `${workspace} dispatch failed: ${result.text}`);
    assert(existsSync(raceMarker), "Private-index git race shim never fired");
    const outcomes = objectOf(result.details).results as Record<
      string,
      unknown
    >[];
    const outcome = outcomes[0]!;
    assert(
      !(JSON.stringify(outcome.attributedFiles) ?? "").includes("diagnostics"),
      "Runtime logs leaked into attribution",
    );
    const drift = objectOf(outcome.integration).sourceDrift;
    assert(
      JSON.stringify(drift) === JSON.stringify([control]),
      "Drift must name only the ordinary escape control: " +
        JSON.stringify(drift),
    );
    // The model's summary is not proof: inspect actual tool responses in the
    // provider-visible conversation (disposable workspace transcripts are RAM).
    assert(
      observedTools.length === 2,
      "Worker did not execute both fixture shell commands",
    );
    assert(
      observedTools.every((message) => !message.isError),
      "Worker copy retained runtime trees",
    );
    assert(
      JSON.stringify(observedTools[0]!.content).includes("COPY_OMITS_RUNTIME"),
      "Copy omission probe failed",
    );
    // Scan ALL blobs, including unreachable private baseline objects. A clean
    // working tree/index alone would miss the privacy leak in the object DB.
    for (const line of git(
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype)",
    )
      .trim()
      .split("\n")) {
      const [oid, kind] = line.split(" ");
      if (kind === "blob")
        assert(
          !git("cat-file", "blob", oid!).includes(sentinel),
          "Diagnostic record entered source Git object DB (" +
            workspace +
            "): " +
            git("cat-file", "blob", oid!).slice(0, 400),
        );
    }
  }
  // Shared Git evidence must exclude runtime edits too, not just workspace drift.
  model.respond([
    fauxAssistantMessage([
      fauxToolCall("bash", {
        command: `printf '%s\\n' '${sentinel}_SHARED' >> '${join(destination, `${process.pid}.jsonl`)}'; printf CONTROL > shared-control.txt; printf POSIX_CHANGED > ${quote(backslashName)}`,
      }),
    ]),
    fauxAssistantMessage("SHARED_DONE"),
  ]);
  const shared = await callDelegate(session, {
    async: false,
    tasks: [
      { prompt: "synthetic shared evidence", cwd: source, tools: ["bash"] },
    ],
  });
  assert(!shared.isError, "Shared evidence failed");
  const sharedOutcome = (
    objectOf(shared.details).results as Record<string, unknown>[]
  )[0]!;
  assert(
    JSON.stringify(sharedOutcome.attributedFiles) ===
      JSON.stringify([
        join(source, backslashName),
        join(source, "shared-control.txt"),
      ]),
    "Shared evidence must name only ordinary source, including literal backslashes: " +
      JSON.stringify(sharedOutcome.attributedFiles),
  );
  assert(readdirSync(destination).length > 0, "Fixture never created logs");
  console.log("DIAGNOSTIC_WORKSPACE_OK");
} finally {
  session.dispose();
}
