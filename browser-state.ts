import type { DelegateRuntime } from "./runtime.ts";
import type {
  AsyncTicket,
  DelegateDetails,
  TaskProgress,
  ToolActivity,
} from "./types.ts";

interface SyncDetails {
  tasks: { prompt?: string }[];
  progress: TaskProgress[];
  results: { output?: string; error?: string }[];
  serializedNotice?: string;
  dispatchWarning?: string;
}

/** Finished sync calls must not pin entire tool arguments/results after the
 * parent compacts. Keep only primitive display arguments and bounded text. */
function compactProgress(p: TaskProgress): TaskProgress {
  let budget = 65_536;
  const activities: ToolActivity[] = [];
  const take = (text: string): string => {
    const limit = Math.min(4096, budget);
    if (limit <= 0) return "";
    const value = text.length > limit ? `…${text.slice(-limit)}` : text;
    budget -= value.length;
    return value;
  };
  for (const tool of p.activities.slice(-100).reverse()) {
    if (budget <= 0) break;
    const args: Record<string, unknown> = {};
    for (const key of [
      "path",
      "file_path",
      "command",
      "pattern",
      "query",
      "url",
      "task",
      "prompt",
      "offset",
      "limit",
    ]) {
      const value = tool.args[key];
      if (typeof value === "string" && budget > 0) args[key] = take(value);
      else if (typeof value === "number") args[key] = value;
    }
    const output = tool.result
      ? tool.result.content
          .filter((part) => part.type === "text")
          .slice(-20)
          .map((part) => part.text?.slice(-4096) ?? "")
          .join("\n")
      : (tool.liveOutput ?? "");
    const text = budget > 0 ? take(output) : "";
    activities.push({
      id: tool.id,
      name: tool.name,
      args,
      startTime: tool.startTime,
      endTime: tool.endTime,
      result: tool.result
        ? { isError: tool.result.isError, content: [{ type: "text", text }] }
        : undefined,
      liveOutput: tool.result ? undefined : text,
    });
  }
  return {
    ...p,
    assistantPreview: p.assistantPreview?.slice(-32_768),
    error: p.error?.slice(0, 4096),
    activities: activities.reverse(),
    warnings: [
      ...(p.warnings ?? []).slice(0, 10).map((s) => s.slice(0, 4096)),
      ...(activities.length < p.activities.length
        ? ["Earlier tool activity omitted from retained sync preview."]
        : []),
    ],
  };
}

function compactDetails(details: SyncDetails): SyncDetails {
  return {
    tasks: details.tasks.map((task) => ({
      prompt: task.prompt?.slice(0, 4096),
    })),
    progress: details.progress.map(compactProgress),
    results: details.results.map((result) => ({
      output: result.output?.slice(-32_768),
      error: result.error?.slice(0, 4096),
    })),
    serializedNotice: details.serializedNotice?.slice(0, 4096),
    dispatchWarning: details.dispatchWarning?.slice(0, 4096),
  };
}

interface SyncRun {
  details: SyncDetails;
  finished: boolean;
  created: number;
  error?: string;
}

/** UI-only history. Active sync runs are never evicted; retain the last twenty
 * finished calls. Async history stays owned by the existing ticket registry. */
export class BrowserHistory {
  readonly runs = new Map<string, SyncRun>();
  generation = 0;

  reset(): void {
    this.generation++;
    this.runs.clear();
  }

  update(
    id: string,
    details: DelegateDetails | undefined,
    finished: boolean,
    generation = this.generation,
  ): void {
    if (generation !== this.generation) return;
    if (!details?.progress.length) {
      if (finished)
        this.fail(
          id,
          "Dispatch ended before tasks could start; see the delegate result.",
        );
      return;
    }
    const created = this.runs.get(id)?.created ?? Date.now();
    this.runs.delete(id);
    this.runs.set(id, {
      details: finished ? compactDetails(details) : details,
      finished,
      created,
    });
    this.prune();
  }

  fail(id: string, error: unknown, generation = this.generation): void {
    if (generation !== this.generation) return;
    const run = this.runs.get(id);
    if (!run) return;
    run.finished = true;
    run.details = compactDetails(run.details);
    run.error = (error instanceof Error ? error.message : String(error)).slice(
      0,
      4096,
    );
    this.runs.delete(id);
    this.runs.set(id, run);
    this.prune();
  }

  private prune(): void {
    const finished = [...this.runs].filter(([, run]) => run.finished);
    for (const [id] of finished.slice(0, -20)) this.runs.delete(id);
  }
}

export interface BrowserRow {
  key: string;
  batch: string;
  created: number;
  progress: TaskProgress;
  siblings: TaskProgress[];
  prompt: string;
  output?: string;
  error?: string;
  ticket?: AsyncTicket;
  finished: boolean;
  notice?: string;
}

export function browserRows(
  runtime: DelegateRuntime,
  history: BrowserHistory,
): BrowserRow[] {
  const rows: BrowserRow[] = [];
  for (const ticket of runtime.tickets.values()) {
    for (const progress of ticket.progress) {
      const result = ticket.results[progress.index];
      rows.push({
        key: `${ticket.id}:${progress.index}`,
        batch: ticket.id,
        created: ticket.created,
        progress,
        siblings: ticket.progress,
        prompt: ticket.tasks[progress.index]?.prompt ?? progress.task,
        output: result?.output,
        error: result?.error ?? ticket.error,
        ticket,
        finished: ticket.status !== "running" && ticket.status !== "cancelling",
        notice: [ticket.serializedNotice, ticket.dispatchWarning]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }
  for (const [id, run] of history.runs) {
    for (const progress of run.details.progress) {
      const result = run.details.results[progress.index];
      rows.push({
        key: `sync:${id}:${progress.index}`,
        batch: `sync ${id.slice(-8)}`,
        created: run.created,
        progress,
        siblings: run.details.progress,
        prompt: run.details.tasks[progress.index]?.prompt ?? progress.task,
        output: result?.output,
        error: result?.error ?? run.error,
        finished: run.finished,
        notice: [run.details.serializedNotice, run.details.dispatchWarning]
          .filter(Boolean)
          .join("\n"),
      });
    }
  }
  return rows.sort(
    (a, b) =>
      Number(a.finished) - Number(b.finished) ||
      b.created - a.created ||
      a.batch.localeCompare(b.batch) ||
      a.progress.index - b.progress.index,
  );
}

export function browserRowStatus(row: BrowserRow): string {
  const p = row.progress;
  if (p.incomplete) return "incomplete — worker may still be active";
  if (p.status === "done") return "done";
  if (p.status === "failed") return "failed";
  if (row.ticket?.status === "cancelling") return "cancelling";
  if (row.finished)
    return row.error ? "failed" : (row.ticket?.status ?? "finished");
  if (p.paused) return "paused";
  if (p.status === "pending") {
    if (row.ticket?.pause && row.ticket.pause.state !== "running")
      return "queued — ticket paused";
    const before =
      p.waitingFor === undefined ? undefined : row.siblings[p.waitingFor];
    if (before && before.status !== "done" && before.status !== "failed")
      return `queued — waiting for ${before.id ?? `task ${before.index + 1}`}`;
    return "queued — waiting for preparation or capacity";
  }
  const phase = p.activity ?? "starting";
  return row.ticket?.pause?.state === "pausing"
    ? `${phase} — pausing after turn`
    : phase;
}
