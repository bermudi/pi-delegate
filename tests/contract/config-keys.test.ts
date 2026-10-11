import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestSession } from "@marcfargas/pi-test-harness";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  callDelegate,
  configureDelegate,
  installSubagentModel,
  openDelegateBoundary,
} from "../support/pi-boundary.ts";
import { diagnosticRecords } from "../support/diagnostic-records.ts";

/**
 * SPEC.md "Unknown configuration keys" (#136, owner-approved): unknown
 * top-level delegate.json keys warn once per changed file content through
 * the DiagnosticSink — never reject an otherwise valid configuration,
 * never echo values, and stay silent on the manual-only profile path.
 * The event names the ignored keys up front; the record's context always
 * carries the complete ignored list and the recognized set, so clipping
 * the event never drops either list. The `surface` removal rejection is
 * pinned in surface.test.ts and is not re-covered here.
 */
describe("unknown delegate.json keys", () => {
  const sessions: TestSession[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });
  const open = async (): Promise<TestSession> => {
    const session = await openDelegateBoundary();
    sessions.push(session);
    return session;
  };

  const RECOGNIZED = [
    "maxConcurrent",
    "concurrency",
    "stallTimeoutMs",
    "models",
    "modelsByParent",
    "telemetry",
    "output",
    "providerExtensions",
    "sessions",
  ];

  const warningsOf = (calls: readonly (readonly unknown[])[]) =>
    diagnosticRecords(calls).filter(
      (record) =>
        record.level === "warn" &&
        record.event.includes("delegate.json") &&
        record.event.includes("unknown"),
    );

  test("an unknown key beside a valid config warns once naming the key and the recognized set, and still dispatches", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, {
      maxConcurrent: 4,
      telemtry: "SECRET-CONFIG-VALUE",
    });
    subagents.respond([
      fauxAssistantMessage("RUN-ONE"),
      fauxAssistantMessage("RUN-TWO"),
    ]);
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "run one" }],
      });
      expect(first.isError).toBe(false);
      expect(first.text).toContain("RUN-ONE");
      expect(subagents.state.callCount).toBe(1);

      const records = warningsOf(warns.mock.calls);
      expect(records.length).toBe(1);
      const [record] = records;
      expect(record?.event).toContain("telemtry");
      // The event shows what fits in the skim view; the record's context
      // always carries the complete ignored list and recognized set.
      expect(record?.context.keys).toBe("telemtry");
      for (const key of RECOGNIZED) {
        expect(record?.context.recognized).toContain(key);
      }
      expect(record?.context.path).toBe(join(session.cwd, "delegate.json"));
      // Key names only — never configuration values or the file body.
      expect(record?.event).not.toContain("SECRET-CONFIG-VALUE");
      expect(JSON.stringify(record)).not.toContain("SECRET-CONFIG-VALUE");

      // The warning is operator-facing: nothing reaches the tool result.
      expect(first.text).not.toContain("telemtry");
      expect(first.text).not.toContain("unknown");
      expect(first.details).not.toMatchObject({
        diagnosticWarning: expect.anything(),
      });

      // Re-reading unchanged content does not repeat the warning.
      const second = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "run two" }],
      });
      expect(second.isError).toBe(false);
      expect(second.text).toContain("RUN-TWO");
      expect(warningsOf(warns.mock.calls).length).toBe(1);
    } finally {
      warns.mockRestore();
    }
  });

  test("changed file content warns again; removing the key warns nothing further", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { maxConcurrent: 4, telemtry: 1 });
    subagents.respond([
      fauxAssistantMessage("RUN-ONE"),
      fauxAssistantMessage("RUN-TWO"),
      fauxAssistantMessage("RUN-THREE"),
    ]);
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dispatch = async () =>
        callDelegate(session, {
          async: false,
          tasks: [{ prompt: "work" }],
        });
      expect((await dispatch()).isError).toBe(false);
      expect(warningsOf(warns.mock.calls).length).toBe(1);

      // A different file body — same typo, edited value — is new content.
      configureDelegate(session, { maxConcurrent: 6 });
      expect((await dispatch()).isError).toBe(false);
      expect(warningsOf(warns.mock.calls).length).toBe(2);

      // Correcting the config ends the warnings.
      writeFileSync(
        join(session.cwd, "delegate.json"),
        JSON.stringify({ maxConcurrent: 6 }),
      );
      expect((await dispatch()).isError).toBe(false);
      expect(warningsOf(warns.mock.calls).length).toBe(2);
      expect(subagents.state.callCount).toBe(3);
    } finally {
      warns.mockRestore();
    }
  });

  test("prototype-named unknown keys warn without crashing and dispatch proceeds", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    // Raw JSON text: an object literal's "__proto__" entry never survives
    // as an own property — the file must carry it literally.
    writeFileSync(
      join(session.cwd, "delegate.json"),
      '{ "__proto__": "polluted?", "constructor": "made up", "maxConcurrent": 4 }',
    );
    subagents.respond([fauxAssistantMessage("PROTO-RUN")]);
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "work" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("PROTO-RUN");
      const records = warningsOf(warns.mock.calls);
      expect(records.length).toBe(1);
      expect(records[0]?.event).toContain("__proto__");
      expect(records[0]?.event).toContain("constructor");
    } finally {
      warns.mockRestore();
    }
  });

  test("the manual's profile-discovery load stays silent and does not consume the warn-once fingerprint", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { telemtry: "x" });
    // A custom profile makes the manual trailer read delegate.json for pin
    // display — the one manual-path config load that must stay silent.
    mkdirSync(join(session.cwd, "agents"));
    writeFileSync(
      join(session.cwd, "agents", "scribe.md"),
      "---\nname: scribe\ndescription: authored scribe\ntools: read\n---\nSCRIBE-BODY\n",
    );
    subagents.respond([fauxAssistantMessage("DISPATCH-RUN")]);
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manual = await callDelegate(session, { tasks: [] });
      expect(manual.isError).toBe(false);
      expect(manual.text).toContain("scribe");
      expect(warningsOf(warns.mock.calls).length).toBe(0);

      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "work" }],
      });
      expect(result.isError).toBe(false);
      expect(warningsOf(warns.mock.calls).length).toBe(1);
    } finally {
      warns.mockRestore();
    }
  });

  test("different configuration paths warn independently within one extension instance", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    const dirA = mkdtempSync(join(tmpdir(), "delegate-agentdir-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "delegate-agentdir-b-"));
    writeFileSync(
      join(dirA, "delegate.json"),
      JSON.stringify({ maxConcurrent: 4, telemtry: "a" }),
    );
    writeFileSync(
      join(dirB, "delegate.json"),
      JSON.stringify({ maxConcurrent: 4, telemtry: "b" }),
    );
    subagents.respond([
      fauxAssistantMessage("RUN-A"),
      fauxAssistantMessage("RUN-B"),
      fauxAssistantMessage("RUN-A2"),
    ]);
    const previous = process.env.DELEGATE_AGENT_DIR;
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = async () =>
      callDelegate(session, {
        async: false,
        tasks: [{ prompt: "work" }],
      });
    try {
      process.env.DELEGATE_AGENT_DIR = dirA;
      expect((await dispatch()).isError).toBe(false);
      process.env.DELEGATE_AGENT_DIR = dirB;
      expect((await dispatch()).isError).toBe(false);
      process.env.DELEGATE_AGENT_DIR = dirA;
      expect((await dispatch()).isError).toBe(false);

      const records = warningsOf(warns.mock.calls);
      expect(records.length).toBe(2);
      const paths = records.map((record) => record.context.path).sort();
      expect(paths).toEqual([
        join(dirA, "delegate.json"),
        join(dirB, "delegate.json"),
      ]);
    } finally {
      warns.mockRestore();
      if (previous === undefined) delete process.env.DELEGATE_AGENT_DIR;
      else process.env.DELEGATE_AGENT_DIR = previous;
    }
  });

  test("a long unknown-key list clips only the event's skim view — the record still names every key and the full recognized set", async () => {
    const session = await open();
    const subagents = await installSubagentModel(session);
    // Reviewer finding: three short stale keys already overflowed the
    // sink's 192-char event bound when the recognized set rode inside it.
    const ignored = [
      "anotherStaleOption",
      "concurrencyLimit",
      "deadlineMs",
      "experimentalFlag",
      "maxConcurrencyLimit",
      "staleOption",
      "tokenBudget",
    ];
    configureDelegate(session, {
      maxConcurrent: 4,
      ...Object.fromEntries(ignored.map((key) => [key, 1])),
    });
    subagents.respond([fauxAssistantMessage("LONG-LIST-RUN")]);
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "work" }],
      });
      expect(result.isError).toBe(false);
      const [record] = warningsOf(warns.mock.calls);
      expect(record).toBeDefined();
      expect(record?.event.length).toBeLessThanOrEqual(192);
      expect(record?.context.keys).toBe(ignored.join(", "));
      for (const key of RECOGNIZED) {
        expect(record?.context.recognized).toContain(key);
      }
    } finally {
      warns.mockRestore();
    }
  });

  test("an unknown key never rescues a broken config — malformed values still reject at load", async () => {
    // The #136 override covers unknown KEYS only; recognized-value
    // validation is unchanged (SPEC-V2): a bad maxConcurrent fails the
    // whole call and the unknown sibling warns on the next valid load.
    const session = await open();
    const subagents = await installSubagentModel(session);
    configureDelegate(session, { maxConcurrent: 0, telemtry: "x" });
    const warns = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rejected = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "work" }],
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.text).toContain("maxConcurrent");
      expect(subagents.state.callCount).toBe(0);
      // The throw propagates before any warning is considered: a config
      // that fails to load emits no unknown-key diagnostic.
      expect(warningsOf(warns.mock.calls).length).toBe(0);

      // Repaired, the same content warns on the next successful load.
      subagents.respond([fauxAssistantMessage("REPAIRED-RUN")]);
      configureDelegate(session, { maxConcurrent: 2 });
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "work" }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("REPAIRED-RUN");
      expect(warningsOf(warns.mock.calls).length).toBe(1);
    } finally {
      warns.mockRestore();
    }
  });
});
