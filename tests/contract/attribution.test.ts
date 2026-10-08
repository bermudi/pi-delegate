import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { diagnosticRecords } from "../support/diagnostic-records.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  calls,
  says,
  when,
  type TestSession,
} from "@marcfargas/pi-test-harness";
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

  type AttributedEntry = {
    taskId: string;
    files: string[];
    uncertain: boolean;
    concurrentWriters?: string[];
  };

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
      async: false,
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
      async: false,
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
      async: false,
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

  test("a bash call outside a git repository reports its changes as unknown; bash output is never parsed", async () => {
    // Contract: SPEC "Completion evidence" — a shell's file effects are
    // unknowable only when no Git evidence window covered the run (user
    // decision 2026-10-02, live session 01a0fdba). The session cwd is not
    // a repository, and the brief forbids parsing bash output for paths.
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
      async: false,
      tasks: [{ prompt: "run a shell command" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: unknown (shell used outside git)");
    expect(result.text).not.toContain("bashmade.txt");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([]);
    expect(attributed[0]!.uncertain).toBe(true);
  });

  test("write + uncovered bash evidence compose: observed paths plus the unknown-shell mark", async () => {
    // Contract: SPEC "Completion evidence" — a task that both edited and
    // shelled outside Git reports the paths it claimed and that more
    // unknown shell changes may exist.
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
      async: false,
      tasks: [{ prompt: "write and shell" }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: known.txt · plus unknown shell changes (outside git)");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([join(session.cwd, "known.txt")]);
    expect(attributed[0]!.uncertain).toBe(true);
  });

  test("two tasks attributed the same file produce one overlap line naming the path and both ids", async () => {
    // Contract: SPEC "Completion evidence" — "when two tasks in one batch
    // are attributed the same file, the result says so". Same-call shared
    // writers are dependsOn-ordered since #126 (unordered overlap rejects),
    // and the overlap is still reported — evidence is not suppressed by
    // ordering.
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
        { id: "task-1", prompt: "write shared file first" },
        { id: "task-2", prompt: "write shared file second", dependsOn: ["task-1"] },
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
    // The delivered wake renders the settled view: the files line rides
    // it. Asserted before any wait — a wait that returns the terminal
    // view consumes the wake (SPEC "Wake delivery").
    const end = Date.now() + 2000;
    while (sends.mock.calls.length === 0 && Date.now() < end) {
      await Bun.sleep(5);
    }
    expect(sends).toHaveBeenCalled();
    expect(String(sends.mock.calls[0]![0].content)).toContain("files: deliverable.md");
    // A wait after the wake still returns the full view and details.
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
    expect(polled.text).toContain("plus unknown shell changes (outside git)");
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

/**
 * SPEC v3 "Observability — Completion evidence" after the 2026-10-02
 * user decision (live session 01a0fdba — every bash-using worker had
 * reported only `files: uncertain (bash)`): each task runs inside a Git
 * evidence window — a HEAD/status/lstat snapshot before its first
 * attempt and another after the final one — so a shell's file footprint
 * is reported by path wherever Git covers the worker's cwd. Only the
 * uncovered case keeps the unknown-shell mark, and windows name the
 * concurrent writers (parent, mutating siblings) that may have dirtied
 * them instead of pretending exclusivity.
 */
describe("completion evidence — git evidence windows (user decision 2026-10-02)", () => {
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

  /** `git init` a directory; commits are made per test where needed. */
  function initRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    execSync(
      "git init -q && git config user.email t@t && git config user.name t",
      { cwd: dir },
    );
  }

  /** The window's absolute path basis is the canonical repository root. */
  function inRepo(repo: string, rel: string): string {
    return join(realpathSync(repo), rel);
  }

  type AttributedEntry = {
    taskId: string;
    files: string[];
    uncertain: boolean;
    concurrentWriters?: string[];
  };

  function attributedOf(details: unknown): AttributedEntry[] {
    const entries = objectOf(details, "details").attributedFiles;
    if (!Array.isArray(entries)) {
      throw new Error(`details.attributedFiles is not an array: ${typeof entries}`);
    }
    return entries as AttributedEntry[];
  }

  test("a worker's bash write inside a git repository is reported by path, not uncertain", async () => {
    // Contract: SPEC "Completion evidence" — the window names the paths
    // that changed inside it (user decision 2026-10-02, live session
    // 01a0fdba); bash output is still never parsed for paths.
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo seeded > made.txt" }),
      ]),
      fauxAssistantMessage("RAN-IT"),
    ]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "create the file", cwd: repo }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: made.txt");
    expect(result.text).not.toContain("unknown");
    expect(result.text).not.toContain("uncertain");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([inRepo(repo, "made.txt")]);
    expect(attributed[0]!.uncertain).toBe(false);
  });

  test("a bash-modified pre-dirty file is reported while an untouched pre-dirty file is not", async () => {
    // Contract: SPEC "Completion evidence" — the window diffs state, not
    // only status codes: a file already dirty before the run reports
    // when the run rewrote it, and one it never touched stays absent.
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "touched.txt"), "ONE\n");
    writeFileSync(join(repo, "untouched.txt"), "TWO\n");
    execSync("git add -A && git commit -qm base", { cwd: repo });
    // Pre-window dirt on both files: neither is the worker's to report.
    writeFileSync(join(repo, "touched.txt"), "ONE dirty\n");
    writeFileSync(join(repo, "untouched.txt"), "TWO dirty\n");
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo appended >> touched.txt" }),
      ]),
      fauxAssistantMessage("DONE"),
    ]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "append to the touched file", cwd: repo }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: touched.txt");
    expect(result.text).not.toContain("untouched.txt");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([inRepo(repo, "touched.txt")]);
    expect(attributed[0]!.uncertain).toBe(false);
  });

  test("a git-covered task whose bash changed nothing reports no files line", async () => {
    // Contract: SPEC "Completion evidence" — a covered window with an
    // empty diff carries no evidence at all: the uncertainty mark is
    // gone and no files line stands in for it.
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "keep.txt"), "KEEP\n");
    execSync("git add -A && git commit -qm base", { cwd: repo });
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "cat keep.txt" }),
      ]),
      fauxAssistantMessage("LOOKED"),
    ]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "inspect the tree", cwd: repo }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("files:");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([]);
    expect(attributed[0]!.uncertain).toBe(false);
  });

  test("a worker's committed change is reported through the moved HEAD", async () => {
    // Contract: SPEC "Completion evidence" — when HEAD moves inside the
    // window the committed paths still report, even though the worktree
    // reads clean at settle time.
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "base.txt"), "BASE\n");
    execSync("git add -A && git commit -qm base", { cwd: repo });
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", {
          command:
            "echo NEW > committed.txt && git add committed.txt && git commit -qm add",
        }),
      ]),
      fauxAssistantMessage("COMMITTED"),
    ]);
    const result = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "commit a file", cwd: repo }],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("files: committed.txt");
    const attributed = attributedOf(result.details);
    expect(attributed[0]!.files).toEqual([inRepo(repo, "committed.txt")]);
    expect(attributed[0]!.uncertain).toBe(false);
  });

  test("a git snapshot failure emits a diagnostic and falls back to the unknown-shell mark without failing the task", async () => {
    // Contract: SPEC "Completion evidence" — a snapshot failure degrades
    // to the uncovered-shell mark; it never fails the task. A corrupt
    // .git/index deterministically fails `git status` while rev-parse
    // still resolves the root (admission's write-scope probe uses
    // rev-parse only, so the task still runs).
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    writeFileSync(join(repo, ".git", "index"), "GARBAGE");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo seeded > made.txt" }),
      ]),
      fauxAssistantMessage("RAN-IT"),
    ]);
    try {
      const result = await callDelegate(session, {
        async: false,
        tasks: [{ prompt: "run a shell command", cwd: repo }],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("files: unknown (shell used outside git)");
      expect(diagnosticRecords(errors.mock.calls).some((record) =>
        record.event === "git snapshot failed" &&
        record.context.taskId === "task-1" && record.context.path === repo &&
        record.level === "error",
      )).toBe(true);
      const attributed = attributedOf(result.details);
      expect(attributed[0]!.uncertain).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  test("two overlapping mutating tasks on one repository name each other and produce no false overlap line", async () => {
    // Contract: SPEC "Completion evidence — concurrency honesty" — a
    // window may carry another writer's changes, so each line names the
    // overlapping mutating writers instead of pretending exclusivity,
    // and overlap reporting never counts a shared diff twice (user
    // decision 2026-10-02). Shared writers on one root can never overlap
    // — admission serializes or rejects them — so the reachable shape is
    // a shared writer beside a non-reserving scratch task: the copy lands
    // inside the repository (the agent dir IS the repo here) and, coming
    // from a non-Git source, carries no .git of its own — both windows
    // open on the same root.
    const session = await openAt();
    initRepo(session.cwd);
    const source = mkdtempSync(join(tmpdir(), "delegate-scratch-source-"));
    writeFileSync(join(source, "keep.txt"), "KEEP\n");
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The two workers stream concurrently, so a plain FIFO queue cannot
    // keep each pair together — dispatch on each task's prompt phrase
    // (the pattern dependencies.test.ts uses for exactly this).
    const first: FauxResponseFactory = (context) => {
      const messages = JSON.stringify(context.messages);
      if (messages.includes("write in the repo")) {
        if (messages.includes("tool_result")) {
          return gate.then(() => fauxAssistantMessage("FIRST-DONE"));
        }
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "one.txt", content: "1" }),
        ]);
      }
      if (messages.includes("tool_result")) {
        return gate.then(() => fauxAssistantMessage("SECOND-DONE"));
      }
      return fauxAssistantMessage([
        fauxToolCall("write", { path: "two.txt", content: "2" }),
      ]);
    };
    model.respond([first, first, first, first]);
    const dispatched = await callDelegate(session, {
      tasks: [
        { prompt: "write in the repo" },
        { prompt: "work a copy", cwd: source, workspace: "scratch" },
      ],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      // Both windows must be open before either settles: wait for each
      // task's live write evidence.
      const end = Date.now() + 5000;
      for (;;) {
        const poll = await callDelegateTicket(session, { action: "poll", ticket });
        const live = attributedOf(poll.details);
        if (live.filter((entry) => entry.files.length > 0).length === 2) break;
        if (Date.now() > end) {
          throw new Error(`tasks never observed their writes: ${poll.text}`);
        }
        await Bun.sleep(10);
      }
      release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 10_000,
      });
      expect(waited.isError).toBe(false);
      const attributed = attributedOf(waited.details);
      const first = attributed.find((entry) => entry.taskId === "task-1")!;
      const second = attributed.find((entry) => entry.taskId === "task-2")!;
      expect(first.concurrentWriters).toEqual([`${ticket}#task-2`]);
      expect(second.concurrentWriters).toEqual([`${ticket}#task-1`]);
      expect(waited.text).toContain(`may include concurrent edits by: ${ticket}#task-1`);
      expect(waited.text).toContain(`may include concurrent edits by: ${ticket}#task-2`);
      // Both diffs share paths (each other's writes, the journal inside
      // the repo) — with the windows untrusted under concurrency, no
      // overlap line may fire on Git-derived claims.
      expect(waited.text).not.toContain("overlap:");
    } finally {
      release();
    }
  });

  test("a parent mutating tool call during the task window is named as a concurrent writer", async () => {
    // Contract: SPEC "Completion evidence — concurrency honesty" — the
    // parent is named when its write/edit/bash/exec tool calls land
    // inside a task's window; the record is content-free — the fact of
    // the call, never its arguments.
    const session = await openAt();
    initRepo(session.cwd);
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo w > worker.txt" }),
      ]),
      async () => {
        await gate;
        return fauxAssistantMessage("WORKER-DONE");
      },
    ]);
    const dispatched = await callDelegate(session, {
      tasks: [{ prompt: "work in the repo" }],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      // The window opens before the first attempt; once the live row
      // shows the bash call's uncertainty mark, the window is provably
      // open and the parent's write lands inside it.
      const end = Date.now() + 5000;
      for (;;) {
        const poll = await callDelegateTicket(session, { action: "poll", ticket });
        if (poll.text.includes("uncertain (bash)")) break;
        if (Date.now() > end) {
          throw new Error(`worker never shelled: ${poll.text}`);
        }
        await Bun.sleep(10);
      }
      await session.run(
        when("parent writes inside the window", [
          calls("write", {
            path: join(session.cwd, "parent.txt"),
            content: "P",
          }),
          says("done"),
        ]),
      );
      release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 10_000,
      });
      expect(waited.isError).toBe(false);
      expect(waited.text).toContain("may include concurrent edits by: parent");
      const attributed = attributedOf(waited.details);
      expect(attributed[0]!.concurrentWriters).toEqual(["parent"]);
    } finally {
      release();
    }
  });

  test("a read-only task beside a writing sibling opens no window and reports no files", async () => {
    // Contract: SPEC "Completion evidence" — only a mutating toolset
    // opens a Git evidence window (bash counts as mutating). A read-only
    // task pays no snapshot cost and can never wear the edits a sibling
    // or the parent landed beside it in the shared root.
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    writeFileSync(join(repo, "keep.txt"), "KEEP\n");
    execSync("git add -A && git commit -qm base", { cwd: repo });
    const model = await installSubagentModel(session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const routed: FauxResponseFactory = (context) => {
      const messages = JSON.stringify(context.messages);
      if (messages.includes("inspect the tree")) {
        return gate.then(() => fauxAssistantMessage("LOOKED"));
      }
      if (messages.includes("tool_result")) {
        return fauxAssistantMessage("WROTE-IT");
      }
      return fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo w > sibling.txt" }),
      ]);
    };
    model.respond([routed, routed, routed]);
    const dispatched = await callDelegate(session, {
      tasks: [
        { prompt: "inspect the tree", cwd: repo, tools: ["read"] },
        { prompt: "write a file", cwd: repo, tools: ["bash"] },
      ],
      async: true,
    });
    const ticket = ticketIdOf(dispatched.text);
    try {
      // The sibling's write must land while the read-only task is still
      // running — inside the span where a window, if it had opened one,
      // would have seen it.
      const end = Date.now() + 5000;
      while (!existsSync(join(repo, "sibling.txt"))) {
        if (Date.now() > end) {
          throw new Error("sibling writer never landed its write");
        }
        await Bun.sleep(10);
      }
      release();
      const waited = await callDelegateTicket(session, {
        action: "wait",
        ticket,
        timeoutMs: 10_000,
      });
      expect(waited.isError).toBe(false);
      const attributed = attributedOf(waited.details);
      const reader = attributed.find((entry) => entry.taskId === "task-1")!;
      expect(reader.files).toEqual([]);
      expect(reader.uncertain).toBe(false);
      expect(reader.concurrentWriters ?? []).toEqual([]);
      const section = waited.text.slice(
        waited.text.indexOf("### Task task-1"),
        waited.text.indexOf("### Task task-2"),
      );
      expect(section).not.toContain("files:");
      expect(section).not.toContain("concurrent edits");
    } finally {
      release();
    }
  });

  test("sequential tasks on one repository do not name each other as concurrent writers", async () => {
    // Contract: SPEC "Completion evidence — concurrency honesty" — only
    // windows that overlapped in time are named; a task that ran after
    // its predecessor settled keeps no stale writer names (the
    // registry's closed records are prunable, never re-claimed).
    const session = await openAt();
    const repo = join(session.cwd, "repo");
    initRepo(repo);
    const model = await installSubagentModel(session);
    model.respond([
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo a > first.txt" }),
      ]),
      fauxAssistantMessage("FIRST-DONE"),
      fauxAssistantMessage([
        fauxToolCall("bash", { command: "echo b > second.txt" }),
      ]),
      fauxAssistantMessage("SECOND-DONE"),
    ]);
    const first = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "write the first file", cwd: repo }],
    });
    expect(first.isError).toBe(false);
    const second = await callDelegate(session, {
      async: false,
      tasks: [{ prompt: "write the second file", cwd: repo }],
    });
    expect(second.isError).toBe(false);
    expect(second.text).toContain("files: second.txt");
    expect(second.text).not.toContain("concurrent edits");
    const attributed = attributedOf(second.details);
    expect(attributed[0]!.files).toEqual([inRepo(repo, "second.txt")]);
    expect(attributed[0]!.concurrentWriters ?? []).toEqual([]);
    // The predecessor's file is pre-existing dirt now — not reported.
    expect(second.text).not.toContain("first.txt");
  });
});
