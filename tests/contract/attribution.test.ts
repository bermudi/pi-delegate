import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { TestSession } from "@marcfargas/pi-test-harness";
import {
  callDelegate,
  callDelegateTicket,
  installSubagentModel,
  objectOf,
  openDelegateBoundary,
  ticketIdOf,
} from "../support/pi-boundary.ts";

/**
 * SPEC v3 "Observability — Completion evidence": a settled task's record
 * carries the file changes attributed to it — paths observed in write/edit
 * tool calls (bash marks the evidence uncertain and names no path); the
 * inline result, delivered wake, and ticket views show each task's
 * attributed files beside its claim; `details.attributedFiles` carries
 * them machine-readably; overlap is reported once, naming the file and
 * both tasks. Evidence, not confinement.
 */
describe("completion evidence — file attribution (SPEC v3 Observability)", () => {
  const sessions: TestSession[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });

  async function openAt(agentDir?: string): Promise<TestSession> {
    const session = await openDelegateBoundary();
    sessions.push(session);
    if (agentDir) {
      (session.session as AgentSession).sessionManager.getSessionDir =
        () => join(agentDir, "sessions", "--test--");
    }
    return session;
  }

  type AttributedEntry = { taskId: string; files: string[]; uncertain: boolean };

  function attributedOf(details: unknown): AttributedEntry[] {
    const entries = objectOf(details, "details").attributedFiles;
    if (!Array.isArray(entries)) {
      throw new Error(`details.attributedFiles is not an array: ${typeof entries}`);
    }
    return entries as AttributedEntry[];
  }

  test("a write call attributes its path, resolved against the task cwd, deduplicated", async () => {
    // Contract: SPEC "Completion evidence" — paths observed in write/edit
    // tool calls; inline result shows `files:` beside the task's claim;
    // details.attributedFiles carries the machine-readable record.
    const session = await openAt();
    mkdirSync(join(session.cwd, "src"));
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "src/out.txt", content: "ONE" }),
        fauxToolCall("write", { path: "src/out.txt", content: "TWO" }),
        fauxToolCall("write", { path: "other.txt", content: "X" }),
      ]),
      fauxAssistantMessage("WROTE-IT"),
    ]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "write files" }],
    });
    expect(result.isError).toBe(false);
    // Display relativizes to the task cwd (the session's temp dir).
    expect(result.text).toContain("files: src/out.txt, other.txt");
    expect(result.text).not.toContain("uncertain");
    const attributed = attributedOf(result.details);
    expect(attributed).toHaveLength(1);
    expect(attributed[0]!.files).toEqual([
      join(session.cwd, "src/out.txt"),
      join(session.cwd, "other.txt"),
    ]);
    expect(attributed[0]!.uncertain).toBe(false);
    // The machine record is the full TaskOutcome as well.
    const outcomes = objectOf(result.details).results as { attributedFiles?: string[] }[];
    expect(outcomes[0]!.attributedFiles).toEqual(attributed[0]!.files);
  });

  test("an edit call attributes its path; a path escaping the cwd renders absolute", async () => {
    // Contract: SPEC "Completion evidence" — edit is observed the same as
    // write; display only relativizes inside the task cwd, never hides an
    // out-of-root path.
    const session = await openAt();
    writeFileSync(join(session.cwd, "editme.txt"), "OLD CONTENT");
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("edit", {
          path: "editme.txt",
          edits: [{ oldText: "OLD", newText: "NEW" }],
        }),
      ]),
      fauxAssistantMessage("EDITED"),
    ]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "edit the file" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: editme.txt");
    expect(attributedOf(result.details)[0]!.files).toEqual([
      join(session.cwd, "editme.txt"),
    ]);
  });

  test("a task cwd scopes both the write tool and the attribution display", async () => {
    // Contract: SPEC "Completion evidence" — relative paths resolve
    // against the task cwd, not the dispatch cwd.
    const session = await openAt();
    const subdir = join(session.cwd, "scoped");
    mkdirSync(subdir);
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "inside.txt", content: "S" }),
        fauxToolCall("write", { path: "../escaped.txt", content: "E" }),
      ]),
      fauxAssistantMessage("DONE"),
    ]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "write inside and outside", cwd: subdir }],
    });
    expect(result.isError).toBe(false);
    // inside.txt relativizes to the task cwd; the escape stays absolute —
    // evidence is never hidden.
    expect(result.text).toContain("files: inside.txt");
    expect(result.text).toContain(join(session.cwd, "escaped.txt"));
    expect(attributedOf(result.details)[0]!.files).toEqual([
      join(subdir, "inside.txt"),
      join(session.cwd, "escaped.txt"),
    ]);
  });

  test("a bash call marks the task uncertain and attributes no path; bash output is never parsed", async () => {
    // Contract: SPEC "Completion evidence" — "changes sourced from bash
    // marked uncertain"; the brief forbids parsing bash output for paths,
    // so a bash call writes evidence only as the uncertainty flag.
    const session = await openAt();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        // The command names a path — attribution must not extract it.
        fauxToolCall("bash", { command: "echo seeded > bashmade.txt" }),
      ]),
      fauxAssistantMessage("RAN-IT"),
    ]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "run a shell command" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: uncertain (bash)");
    expect(result.text).not.toContain("bashmade.txt");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([]);
    expect(attributed[0]!.uncertain).toBe(true);
  });

  test("write + bash evidence compose: observed paths plus the uncertainty mark", async () => {
    // Contract: SPEC "Completion evidence" — a task that both edited and
    // shelled reports the paths it claimed and that more may exist.
    const session = await openAt();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "known.txt", content: "K" }),
        fauxToolCall("bash", { command: "true" }),
      ]),
      fauxAssistantMessage("DONE"),
    ]);
    const result = await callDelegate(session, {
      tasks: [{ prompt: "write and shell" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: known.txt");
    expect(result.text).toContain("uncertain (bash)");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([join(session.cwd, "known.txt")]);
    expect(attributed[0]!.uncertain).toBe(true);
  });

  test("two tasks attributed the same file produce one overlap line naming the path and both ids", async () => {
    // Contract: SPEC "Completion evidence" — "when two tasks in one batch
    // are attributed the same file, the result says so". Same-call shared
    // writers serialize (admission keeps them ordered), and the overlap is
    // still reported — evidence is not suppressed by ordering.
    const session = await openAt();
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "shared.txt", content: "A" }),
      ]),
      fauxAssistantMessage("FIRST-DONE"),
      fauxAssistantMessage([
        fauxToolCall("write", { path: "shared.txt", content: "B" }),
      ]),
      fauxAssistantMessage("SECOND-DONE"),
    ]);
    const result = await callDelegate(session, {
      tasks: [
        { prompt: "write shared file first" },
        { prompt: "write shared file second" },
      ],
      async: false,
    });
    expect(result.isError).toBe(false);
    const abs = join(session.cwd, "shared.txt");
    const overlap = result.text
      .split("\n")
      .filter((line) => line.startsWith("overlap:"));
    expect(overlap).toHaveLength(1);
    expect(overlap[0]).toContain(abs);
    expect(overlap[0]).toContain("task-1");
    expect(overlap[0]).toContain("task-2");
    expect(result.text).toContain("files: shared.txt");
  });

  test("a ticket view and the delivered wake show attributed files beside the task's claim", async () => {
    // Contract: SPEC "Completion evidence" — the delivered wake and ticket
    // views show each task's attributed files; poll/wait details carry
    // details.attributedFiles.
    const session = await openAt();
    const host = session.session as AgentSession;
    const sends = spyOn(host, "sendCustomMessage");
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "deliverable.md", content: "D" }),
      ]),
      fauxAssistantMessage("TICKET-OUTPUT"),
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "write a deliverable" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    const waited = await callDelegateTicket(session, {
      action: "wait",
      ticket,
      timeoutMs: 5000,
    });
    expect(waited.text).toContain("files: deliverable.md");
    const attributed = attributedOf(waited.details);
    expect(attributed.find((e) => e.taskId === "task-1")!.files).toEqual([
      join(session.cwd, "deliverable.md"),
    ]);
    // The delivered wake renders the same view: the files line rides it.
    const end = Date.now() + 2000;
    while (sends.mock.calls.length === 0 && Date.now() < end) {
      await Bun.sleep(5);
    }
    expect(sends).toHaveBeenCalled();
    expect(String(sends.mock.calls[0]![0].content)).toContain("files: deliverable.md");
  });

  test("a running task's poll row shows attribution observed so far", async () => {
    // Contract: SPEC "Completion evidence" — ticket views show attributed
    // files beside the task's claim; a live row reports observed-so-far
    // evidence, not only settled evidence.
    const session = await openAt();
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "progress.txt", content: "P" }),
      ]),
      async () => {
        await gate;
        return fauxAssistantMessage("FINISHED");
      },
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "write then think" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      // Poll until the write has been observed in-flight.
      const end = Date.now() + 3000;
      let poll;
      for (;;) {
        poll = await callDelegateTicket(session, { action: "poll", ticket });
        if (poll.text.includes("files: progress.txt")) break;
        if (Date.now() > end) throw new Error(`no live attribution in: ${poll.text}`);
        await Bun.sleep(10);
      }
      // And the machine half reports observed-so-far evidence too.
      const live = attributedOf(poll.details).find((e) => e.taskId === "task-1");
      expect(live?.files).toEqual([join(session.cwd, "progress.txt")]);
    } finally {
      release();
      await callDelegateTicket(session, { action: "wait", ticket, timeoutMs: 5000 });
    }
  });

  test("a cancel preview shows task states, never file attribution", async () => {
    // Contract: SPEC "Completion evidence" scopes attribution to results —
    // the cancel preview is not a result view and names no files lines.
    const session = await openAt();
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "preview-free.txt", content: "P" }),
      ]),
      async () => {
        await gate;
        return fauxAssistantMessage("TOO-LATE");
      },
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "write then stall" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      const end = Date.now() + 3000;
      for (;;) {
        const poll = await callDelegateTicket(session, { action: "poll", ticket });
        if (poll.text.includes("files: preview-free.txt")) break;
        if (Date.now() > end) throw new Error("write never attributed");
        await Bun.sleep(10);
      }
      const preview = await callDelegateTicket(session, { action: "cancel", ticket });
      expect(preview.text).not.toContain("files:");
      expect(preview.text).not.toContain("overlap:");
      await callDelegateTicket(session, { action: "cancel", ticket, force: true });
    } finally {
      release();
    }
  });

  test("a cold-recovered ticket renders its recorded attribution unchanged", async () => {
    // Contract: SPEC "Completion evidence" — the settled record carries
    // the attribution, so a fresh boundary reads it from the journal and
    // renders the same files line.
    const first = await openAt();
    const model = await installSubagentModel(first);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("write", { path: "cold.txt", content: "C" }),
        fauxToolCall("bash", { command: "true" }),
      ]),
      fauxAssistantMessage("COLD-OUTPUT"),
    ]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "write and shell" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(first, { action: "wait", ticket, timeoutMs: 5000 });

    const next = await openAt(first.cwd);
    const polled = await callDelegateTicket(next, { action: "poll", ticket });
    expect(polled.text).toContain("files: cold.txt");
    expect(polled.text).toContain("uncertain (bash)");
    const attributed = attributedOf(polled.details);
    expect(attributed).toHaveLength(1);
    expect(attributed[0]!.files).toEqual([join(first.cwd, "cold.txt")]);
    expect(attributed[0]!.uncertain).toBe(true);
  });

  test("a journal record written before attribution parses and renders without a files line", async () => {
    // Contract: SPEC "Completion evidence" — old journal records stay
    // parseable; absent fields render absent evidence, never an error.
    const first = await openAt();
    const model = await installSubagentModel(first);
    model.respond([fauxAssistantMessage("PLAIN-OUTPUT")]);
    const dispatched = await callDelegate(first, {
      tasks: [{ prompt: "plain report" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    await callDelegateTicket(first, { action: "wait", ticket, timeoutMs: 5000 });
    // Strip the new fields to simulate a pre-attribution record (which
    // also predates the optional task cwd field).
    const path = join(first.cwd, "delegate-tickets", `${ticket}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8")) as {
      tasks: { cwd?: string }[];
      outcomes: ({ attributedFiles?: string[]; uncertainFiles?: boolean } | null)[];
    };
    delete saved.tasks[0]!.cwd;
    delete saved.outcomes[0]!.attributedFiles;
    delete saved.outcomes[0]!.uncertainFiles;
    writeFileSync(path, JSON.stringify(saved));

    const next = await openAt(first.cwd);
    const polled = await callDelegateTicket(next, { action: "poll", ticket });
    expect(polled.isError).toBe(false);
    expect(polled.text).toContain("PLAIN-OUTPUT");
    expect(polled.text).not.toContain("files:");
  });
});
