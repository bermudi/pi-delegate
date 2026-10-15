import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TestSession } from "@marcfargas/pi-test-harness";
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
} from "../support/pi-boundary.ts";
import { gitFixtureEnv } from "../support/git-fixture.ts";

/**
 * SPEC v3 "Report surface" reserved-namespace regression: the report spool is
 * a runtime tree exactly like `delegate-diagnostics`. It is never copied into
 * a scratch or isolated worker, never hashed into the source Git object
 * database by a private baseline, and never attributed as a worker's file
 * change — including when another process appends to it mid-run.
 *
 * The fixture is synthetic source plus a real repository: the assertions read
 * the worker's own copy through its shell, the settled outcome's attribution,
 * and every blob in the source object database. The worker's summary is never
 * evidence.
 */

const linuxTest = process.platform === "linux" ? test : test.skip;

function gitInit(dir: string): void {
  execSync(
    "git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init",
    { cwd: dir, env: gitFixtureEnv() },
  );
}

describe("the report spool is a reserved runtime namespace", () => {
  let session: TestSession | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    session?.dispose();
    session = undefined;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture(): { source: string; sentinel: string } {
    const root = mkdtempSync(join(tmpdir(), "delegate-report-namespace-"));
    chmodSync(root, 0o700);
    dirs.push(root);
    const source = join(root, "source");
    mkdirSync(source, { mode: 0o700 });
    // The run sentinel is what must never reach Git or a worker; the tracked
    // record below carries a different marker because a user may legitimately
    // have committed runtime files before ignoring the tree, and Delegate does
    // not scrub historical objects already in their database.
    const sentinel = `SYNTHETIC_RUN_${randomUUID()}`;
    writeFileSync(join(source, "ordinary.txt"), "ORDINARY_SOURCE\n");
    // A user whose agent directory lives inside the repository ignores it,
    // which is exactly how the runtime tree reaches the copy path (#120).
    writeFileSync(join(source, ".gitignore"), "delegate-reports/\n");
    gitInit(source);
    // A record that was tracked before the user ignored the tree: the private
    // baseline must drop it from seeded state, not merely refuse new blobs.
    const tree = join(source, "delegate-reports");
    mkdirSync(tree, { mode: 0o700 });
    writeFileSync(join(tree, "abcd1234ef56.json"), "SYNTHETIC_TRACKED_RECORD\n", {
      mode: 0o600,
    });
    execSync("git add -f delegate-reports/abcd1234ef56.json && git commit -qm tracked", {
      cwd: source,
      env: gitFixtureEnv(),
    });
    // Live, untracked runtime state: a nested tree (another session's agent
    // directory) and a symlink alias of the spool.
    mkdirSync(join(source, "nested", "delegate-reports"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(source, "nested", "delegate-reports", "1234abcd5678.json"),
      `${sentinel}_nested\n`,
      { mode: 0o600 },
    );
    symlinkSync(tree, join(source, "reports-alias"));
    return { source, sentinel };
  }

  for (const workspace of ["scratch", "isolated"] as const) {
    linuxTest(
      `a ${workspace} worker sees no report tree and the spool never reaches Git or attribution`,
      async () => {
        const { source, sentinel } = fixture();
        session = await openDelegateBoundary();
        const subagents = await installSubagentModel(session);
        const control = `control-${workspace}.txt`;
        // The worker's own shell is the observer: every runtime entry is
        // unreachable from inside its copy, and the alias is not carried in
        // either (a copied symlink would dangle into the real spool).
        const probe = [
          "for candidate in delegate-reports nested/delegate-reports reports-alias; do if [ -e \"$candidate\" ]; then printf 'PRESENT:%s\\n' \"$candidate\"; else printf 'ABSENT:%s\\n' \"$candidate\"; fi; done",
          "if [ -L reports-alias ]; then printf 'LINK:reports-alias\\n'; fi",
          "test -f ordinary.txt && printf COPY_OMITS_REPORTS",
        ].join("; ");
        let observed: { isError: boolean; content: unknown }[] = [];
        const finish: FauxResponseFactory = (context) => {
          observed = context.messages
            .filter((message) => message.role === "toolResult")
            .map((message) => ({
              isError: message.isError,
              content: message.content,
            }));
          return fauxAssistantMessage("NAMESPACE_DONE");
        };
        subagents.respond([
          fauxAssistantMessage([fauxToolCall("bash", { command: probe })]),
          fauxAssistantMessage([
            fauxToolCall("bash", {
              command:
                `printf '%s\\n' '${sentinel}_DURING_RUN' >> '${join(source, "delegate-reports", "abcd1234ef56.json")}'` +
                `; printf CONTROL > '${join(source, control)}'`,
            }),
          ]),
          finish,
        ]);

        const result = await callDelegate(session, {
          async: false,
          tasks: [{ prompt: "namespace probe", cwd: source, workspace }],
        });
        expect(result.isError).toBe(false);

        const outcome = (
          objectOf(result.details).results as Record<string, unknown>[]
        )[0]!;
        // Both halves of the completion evidence: the recorded outcome and
        // the machine-readable details projection.
        for (const attributed of [
          JSON.stringify(outcome.attributedFiles ?? []),
          JSON.stringify(objectOf(result.details).attributedFiles),
        ]) {
          expect(attributed).not.toContain("delegate-reports");
        }
        // The drift window worked (it named the control write), so the absent
        // runtime path is exclusion, not a window that never opened.
        expect(objectOf(outcome.integration).sourceDrift).toEqual([control]);

        // The worker's own copy, read from the worker's tool results.
        expect(observed.length).toBe(2);
        expect(observed.every((message) => !message.isError)).toBe(true);
        const probeOutput = JSON.stringify(observed[0]!.content);
        for (const absent of [
          "delegate-reports",
          "nested/delegate-reports",
          "reports-alias",
        ]) {
          expect(probeOutput).toContain(`ABSENT:${absent}`);
        }
        expect(probeOutput).not.toContain("LINK:reports-alias");
        expect(probeOutput).toContain("COPY_OMITS_REPORTS");

        // Private baselines write into the source object database: no blob
        // there may carry a spool record.
        const objects = execSync(
          "git cat-file --batch-all-objects --batch-check='%(objectname) %(objecttype)'",
          { cwd: source, env: gitFixtureEnv(), encoding: "utf8" },
        )
          .trim()
          .split("\n");
        for (const line of objects) {
          const [oid, kind] = line.split(" ");
          if (kind !== "blob") continue;
          const body = execSync(`git cat-file blob ${oid}`, {
            cwd: source,
            env: gitFixtureEnv(),
            encoding: "utf8",
          });
          expect(body).not.toContain("SYNTHETIC_RUN_");
        }
        expect(readFileSync(join(source, "ordinary.txt"), "utf8")).toBe(
          "ORDINARY_SOURCE\n",
        );
        // The source keeps its own state: the run appended to the record in
        // place, and nothing moved it into a baseline or a worker.
        expect(
          readFileSync(join(source, "delegate-reports", "abcd1234ef56.json"), "utf8"),
        ).toContain("_DURING_RUN");
      },
      30_000,
    );
  }
});
