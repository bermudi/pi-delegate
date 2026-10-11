import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";

const PROTOTYPE_NAMES = [
  "constructor",
  "toString",
  "__proto__",
  "ordinary-unknown",
] as const;

const PROFILE_BODY = "Prototype-named profile fixture.";
const PROFILE_DESCRIPTION = "prototype-name fixture";

const globalDir = (session: TestSession): string => join(session.cwd, "agents");

function writeProfile(
  dir: string,
  filename: string,
  frontmatter: string,
  body: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n${body}\n`);
}

function systemPromptText(message: unknown): string {
  const sys = message as
    | { content?: unknown; sections?: Record<string, unknown> }
    | undefined;
  if (!sys) return "";
  const content =
    typeof sys.content === "string" ? sys.content : JSON.stringify(sys.content ?? "");
  return [
    content,
    ...Object.values(sys.sections ?? {}).map((s) => String(s)),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

async function waitFor(probe: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !probe(); i++) await Bun.sleep(20);
  expect(probe(), `${what} (timed out waiting)`).toBeTrue();
}

async function installNamedParentProvider(
  session: TestSession,
  provider: string,
): Promise<FauxProviderHandle> {
  const faux = fauxProvider({
    provider,
    models: [{ id: "faux-1", reasoning: true }],
  });
  const runtime = (session.session as AgentSession).modelRuntime;
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(provider, "test-key");
  const model = runtime.getModel(provider, "faux-1");
  if (!model) {
    throw new Error(`faux model '${provider}/faux-1' did not register`);
  }
  await (session.session as AgentSession).setModel(model);
  return faux;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  const step: FauxResponseFactory = async () => {
    await promise;
    return fauxAssistantMessage("OK");
  };
  return { release, step };
}

describe("prototype-named external keys regression (#139)", () => {
  let session: TestSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  for (const name of PROTOTYPE_NAMES) {
    test(
      `an unknown agent '${name}' rejects with the enumerated names, not a TypeError`,
      async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        subagents.respond([fauxAssistantMessage("OK")]);

        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "report", agent: name }],
        });

        expect(result.isError).toBe(true);
        expect(result.text).toContain(`unknown agent '${name}'`);
        expect(result.text).toContain("Known agents:");
        expect(result.text).not.toMatch(/TypeError|not iterable/);
        expect(subagents.state.callCount).toBe(0);
      },
    );

    test(
      `a global profile named '${name}' runs on the parent model`,
      async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        writeProfile(
          globalDir(session),
          `${name}.md`,
          [
            `name: ${name}`,
            `description: ${PROFILE_DESCRIPTION}`,
            "tools: ro",
          ].join("\n"),
          PROFILE_BODY,
        );

        const help = await callDelegate(session, {
          async: false,
          tasks: [],
        });
        expect(help.isError).toBe(false);
        expect(help.text).toContain(`\`${name}\``);
        expect(help.text).not.toContain("model `undefined`");
        expect(help.text).not.toContain(`(\`models.${name}\`)`);
        expect(subagents.state.callCount).toBe(0);
        expect(subagents.alt.state.callCount).toBe(0);

        let seenPrompt: unknown;
        subagents.respond([
          (context) => {
            seenPrompt = systemPromptText(
              context.messages.find((m) => m.role === "system"),
            );
            return fauxAssistantMessage("OK");
          },
        ]);

        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "report", agent: name }],
        });

        expect(result.isError).toBe(false);
        expect(result.text).toContain("OK");
        expect(seenPrompt).toEqual(expect.stringContaining(PROFILE_BODY));
        expect(subagents.state.callCount).toBe(1);
        expect(subagents.alt.state.callCount).toBe(0);
      },
    );

    test(
      `a delegate.json models pin for '${name}' routes to the pinned model`,
      async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        writeProfile(
          globalDir(session),
          `${name}.md`,
          [
            `name: ${name}`,
            `description: ${PROFILE_DESCRIPTION}`,
            "tools: ro",
          ].join("\n"),
          PROFILE_BODY,
        );
        configureDelegate(session, {
          models: Object.fromEntries([[name, subagents.alt.spec]]),
        });

        const help = await callDelegate(session, {
          async: false,
          tasks: [],
        });
        expect(help.isError).toBe(false);
        expect(help.text).toContain(`model \`${subagents.alt.spec}\``);
        expect(help.text).toContain(`(\`models.${name}\`)`);

        subagents.alt.respond([fauxAssistantMessage("OK")]);

        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "report", agent: name }],
        });

        expect(result.isError).toBe(false);
        expect(result.text).toContain("OK");
        expect(subagents.alt.state.callCount).toBe(1);
        expect(subagents.state.callCount).toBe(0);
      },
    );

    test(
      `a modelsByParent pin for '${name}' wins over the unscoped models entry`,
      async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        writeProfile(
          globalDir(session),
          `${name}.md`,
          [
            `name: ${name}`,
            `description: ${PROFILE_DESCRIPTION}`,
            "tools: ro",
          ].join("\n"),
          PROFILE_BODY,
        );
        configureDelegate(session, {
          models: Object.fromEntries([[name, subagents.spec]]),
          modelsByParent: Object.fromEntries([
            [subagents.spec, Object.fromEntries([[name, subagents.alt.spec]])],
          ]),
        });

        const help = await callDelegate(session, {
          async: false,
          tasks: [],
        });
        expect(help.isError).toBe(false);
        expect(help.text).toContain(`model \`${subagents.alt.spec}\``);
        expect(help.text).toContain(
          `(\`modelsByParent.${subagents.spec}.${name}\`)`,
        );

        subagents.alt.respond([fauxAssistantMessage("OK")]);

        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "report", agent: name }],
        });

        expect(result.isError).toBe(false);
        expect(result.text).toContain("OK");
        expect(subagents.alt.state.callCount).toBe(1);
        expect(subagents.state.callCount).toBe(0);
      },
    );

    test(
      `a profile with tools '${name}' is skipped while sibling profiles still run`,
      async () => {
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        writeProfile(
          globalDir(session),
          "good.md",
          [
            "name: good",
            `description: ${PROFILE_DESCRIPTION}`,
            "tools: ro",
          ].join("\n"),
          PROFILE_BODY,
        );
        writeProfile(
          globalDir(session),
          `${name}.md`,
          [
            `name: ${name}`,
            `description: ${PROFILE_DESCRIPTION}`,
            `tools: ${name}`,
          ].join("\n"),
          PROFILE_BODY,
        );
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
          subagents.respond([
            fauxAssistantMessage("OK"),
            fauxAssistantMessage("OK"),
          ]);
          const result = await callDelegate(session, {
            async: false,
            tasks: [{ prompt: "report", agent: "good" }, { prompt: "report" }],
          });

          expect(result.isError).toBe(false);
          expect(result.text).not.toMatch(/TypeError|not iterable/);
          expect(subagents.state.callCount).toBe(2);
          expect(
            warn.mock.calls.some((call) =>
              String(call[0]).includes(`${name}.md`),
            ),
          ).toBe(true);

          const rejected = await callDelegate(session, {
            async: false,
            tasks: [{ prompt: "report", agent: name }],
          });
          expect(rejected.isError).toBe(true);
          expect(rejected.text).toContain(`unknown agent '${name}'`);
          expect(rejected.text).toContain("Known agents:");
        } finally {
          warn.mockRestore();
        }
      },
    );
  }

  for (const name of ["constructor", "toString", "__proto__"] as const) {
    test(
      `two explore tasks on provider '${name}' run concurrently under the global bound`,
      async () => {
        session = await openDelegateBoundary();
        const faux = await installNamedParentProvider(session, name);
        configureDelegate(session, { maxConcurrent: 2 });
        const held = gate();
        faux.setResponses([held.step, held.step]);

        const pending = callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "report", agent: "explore" },
            { prompt: "report", agent: "explore" },
          ],
        });
        const settled = pending.then(
          (result) => result,
          () => undefined,
        );
        try {
          await waitFor(
            () => faux.state.callCount === 2,
            `two '${name}' provider calls started under the global bound`,
          );
        } finally {
          held.release();
        }
        const result = await settled;
        expect(result?.isError).toBe(false);
        expect(result?.text).toContain("OK");
      },
    );

    test(
      `concurrency.providers {${name}:1} serializes same-provider tasks`,
      async () => {
        session = await openDelegateBoundary();
        const faux = await installNamedParentProvider(session, name);
        configureDelegate(session, {
          maxConcurrent: 4,
          concurrency: {
            providers: Object.fromEntries([[name, 1]]),
          },
        });
        const held = gate();
        faux.setResponses([held.step, held.step]);

        const pending = callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "report", agent: "explore" },
            { prompt: "report", agent: "explore" },
          ],
        });
        const settled = pending.then(
          (result) => result,
          () => undefined,
        );
        try {
          await waitFor(
            () => faux.state.callCount === 1,
            `first '${name}' provider call started`,
          );
          await Bun.sleep(150);
          expect(faux.state.callCount).toBe(1);
        } finally {
          held.release();
        }
        const result = await settled;
        expect(result?.isError).toBe(false);
        expect(faux.state.callCount).toBe(2);
      },
    );

    test(
      `concurrency.models {${name}/faux-1:1} overrides the provider bound of 2`,
      async () => {
        session = await openDelegateBoundary();
        const faux = await installNamedParentProvider(session, name);
        configureDelegate(session, {
          maxConcurrent: 4,
          concurrency: {
            providers: Object.fromEntries([[name, 2]]),
            models: Object.fromEntries([[`${name}/faux-1`, 1]]),
          },
        });
        const held = gate();
        faux.setResponses([held.step, held.step]);

        const pending = callDelegate(session, {
          async: false,
          tasks: [
            { prompt: "report", agent: "explore" },
            { prompt: "report", agent: "explore" },
          ],
        });
        const settled = pending.then(
          (result) => result,
          () => undefined,
        );
        try {
          await waitFor(
            () => faux.state.callCount === 1,
            `first '${name}' provider call started`,
          );
          await Bun.sleep(150);
          expect(faux.state.callCount).toBe(1);
        } finally {
          held.release();
        }
        const result = await settled;
        expect(result?.isError).toBe(false);
        expect(faux.state.callCount).toBe(2);
      },
    );
  }
});
