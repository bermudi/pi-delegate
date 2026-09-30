import { createHash } from "node:crypto";

const SETTLED_TTL_MS = 60 * 60 * 1000;
const SETTLED_CAP = 256;

interface OperationRecord<Result> {
  readonly fingerprint: string;
  promise: Promise<Result>;
  settledAt: number | undefined;
  readonly sequence: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) continue;
      out[key] = canonicalize(entry);
    }
    return out;
  }
  return value;
}

export function dispatchFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export class OperationStore<Result> {
  private readonly records = new Map<string, OperationRecord<Result>>();
  private sequence = 0;

  run(
    operationId: string,
    fingerprint: string,
    start: () => Promise<Result>,
    retainUntil?: (result: Result) => Promise<unknown>,
  ): Promise<Result> {
    this.sweepExpired(Date.now());
    const existing = this.records.get(operationId);
    if (existing !== undefined) {
      if (existing.fingerprint === fingerprint) {
        console.error(
          `[delegate] operationId '${operationId}' reuses the original in-flight or settled result; no new execution starts`,
        );
        return existing.promise;
      }
      console.error(
        `[delegate] operationId '${operationId}' conflicts: the same key is already bound to a different dispatch request`,
      );
      throw new Error(
        `operationId '${operationId}' is already bound to a different dispatch request; reuse the original request or choose a new operationId.`,
      );
    }
    const record: OperationRecord<Result> = {
      fingerprint,
      promise: Promise.resolve() as Promise<Result>,
      settledAt: undefined,
      sequence: this.sequence,
    };
    this.sequence += 1;
    const markSettled = () => {
      record.settledAt = Date.now();
      this.pruneSettled();
    };
    record.promise = Promise.resolve()
      .then(start)
      .then(
        (value) => {
          if (retainUntil === undefined) {
            markSettled();
          } else {
            try {
              void retainUntil(value).then(markSettled, markSettled);
            } catch {
              markSettled();
            }
          }
          return value;
        },
        (error: unknown) => {
          markSettled();
          throw error;
        },
      );
    this.records.set(operationId, record);
    this.pruneSettled();
    return record.promise;
  }

  private sweepExpired(now: number): void {
    for (const [key, record] of this.records) {
      if (
        record.settledAt !== undefined &&
        now - record.settledAt >= SETTLED_TTL_MS
      ) {
        this.records.delete(key);
      }
    }
  }

  private pruneSettled(): void {
    const settled = [...this.records.entries()].filter(
      ([, record]) => record.settledAt !== undefined,
    );
    const excess = settled.length - SETTLED_CAP;
    if (excess <= 0) return;
    settled.sort(
      (a, b) =>
        (a[1].settledAt ?? 0) - (b[1].settledAt ?? 0) ||
        a[1].sequence - b[1].sequence,
    );
    for (const [key] of settled.slice(0, excess)) {
      this.records.delete(key);
    }
  }
}
