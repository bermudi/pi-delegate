import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { Ticket } from "./types.ts";

const usage = Type.Object({
  input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(),
  cacheWrite: Type.Number(), cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()), totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(),
    cacheWrite: Type.Number(), total: Type.Number(),
  }),
});
const integration = Type.Object({
  status: Type.Union([
    Type.Literal("applied_unverified"), Type.Literal("conflict"),
    Type.Literal("retained"), Type.Literal("no_changes"),
    Type.Literal("discarded"), Type.Literal("apply_failed"),
  ]),
  reason: Type.Optional(Type.String()),
  proposedFiles: Type.Array(Type.String()),
  appliedFiles: Type.Array(Type.String()),
  conflicts: Type.Optional(Type.Array(Type.Object({ path: Type.String(), reason: Type.String() }))),
  baselineRef: Type.Optional(Type.String()),
  proposalRef: Type.Optional(Type.String()),
  patchPath: Type.Optional(Type.String()),
  worktreePath: Type.Optional(Type.String()),
});
const outcome = Type.Object({
  index: Type.Integer({ minimum: 0 }), id: Type.String(),
  status: Type.Union([
    Type.Literal("ok"), Type.Literal("failed"),
    Type.Literal("cancelled"), Type.Literal("blocked"),
  ]),
  output: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  retries: Type.Integer({ minimum: 0 }), usage: Type.Optional(usage),
  integration: Type.Optional(integration),
  blockedBy: Type.Optional(Type.Array(Type.String())),
  quarantined: Type.Optional(Type.Boolean()),
  sessionFile: Type.Optional(Type.String()),
});
const savedTicket = Type.Object({
  version: Type.Literal(1),
  id: Type.String({ pattern: "^t-[0-9a-f-]{36}$" }),
  status: Type.Union([
    Type.Literal("running"), Type.Literal("completed"),
    Type.Literal("partial"), Type.Literal("failed"), Type.Literal("cancelled"),
  ]),
  tasks: Type.Array(Type.Object({
    id: Type.String(), agent: Type.String(),
    resumeTag: Type.Optional(Type.String()),
    aliasedFrom: Type.Optional(Type.String()),
  }), { minItems: 1 }),
  outcomes: Type.Array(Type.Union([outcome, Type.Null()])),
  outputBounds: Type.Object({
    spillThresholdChars: Type.Integer({ minimum: 0 }),
    spillTailChars: Type.Integer({ minimum: 0 }),
  }),
  createdAt: Type.Number(),
  notices: Type.Array(Type.String()),
});

export type SavedTicket = Static<typeof savedTicket>;

/** Contains full child outputs. Keep it private, atomic, and never follow a ticket symlink. */
export class TicketJournal {
  readonly dir: string;

  constructor(agentDir: string) {
    this.dir = join(agentDir, "delegate-tickets");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error(`${this.dir} must be an owner-only directory, not a symlink`);
    }
  }

  load(): SavedTicket[] {
    const records: SavedTicket[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      if (!/^t-[0-9a-f-]{36}\.json$/.test(name)) continue;
      const path = join(this.dir, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
          throw new Error("not an owner-only regular file");
        }
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!Check(savedTicket, parsed)) throw new Error("invalid or unsupported ticket record");
        if (parsed.id + ".json" !== name ||
            parsed.outcomes.length !== parsed.tasks.length ||
            parsed.outcomes.some((item, index) =>
              item !== null && (item.index !== index || item.id !== parsed.tasks[index]?.id))) {
          throw new Error("ticket identity or outcome alignment mismatch");
        }
        if (parsed.status === "completed" &&
            !parsed.outcomes.every((item) => item?.status === "ok")) {
          throw new Error("completed ticket has missing or unsuccessful outcomes");
        }
        records.push(parsed);
      } catch (error) {
        throw new Error(`Cannot recover ticket ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    return records;
  }

  save(ticket: Ticket): void {
    const path = join(this.dir, `${ticket.id}.json`);
    const temp = join(this.dir, `.${ticket.id}-${randomUUID()}.tmp`);
    const data = JSON.stringify({
      version: 1,
      id: ticket.id,
      status: ticket.status,
      tasks: ticket.tasks.map(({ id, agent, resumeTag, aliasedFrom }) => ({ id, agent, resumeTag, aliasedFrom })),
      outcomes: ticket.outcomes.map((item) => item ?? null),
      outputBounds: ticket.outputBounds,
      createdAt: ticket.createdAt,
      notices: ticket.notices,
    });
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, path);
      const dirFd = openSync(this.dir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
          console.error(`[delegate] ticket journal temp cleanup failed: ${String(cleanupError)}`);
      }
      throw new Error(`Saving ticket ${ticket.id} in ${this.dir} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  remove(id: string): void {
    unlinkSync(join(this.dir, `${id}.json`));
  }
}
