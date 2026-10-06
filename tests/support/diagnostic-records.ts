/** Observe stderr diagnostics through public-tool tests, never logger internals. */
export interface DiagnosticRecord {
  readonly level: string;
  readonly event: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<{
    class: string;
    code?: string;
    errcode?: number;
  }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function diagnosticRecords(
  calls: readonly (readonly unknown[])[],
): DiagnosticRecord[] {
  const records: DiagnosticRecord[] = [];
  for (const [line] of calls) {
    if (typeof line !== "string" || !line.startsWith("[delegate] {")) continue;
    const value: unknown = JSON.parse(line.slice("[delegate] ".length));
    if (
      !object(value) ||
      typeof value.level !== "string" ||
      typeof value.event !== "string" ||
      !object(value.context) ||
      (value.error !== undefined &&
        (!object(value.error) ||
          typeof value.error.class !== "string" ||
          (value.error.code !== undefined &&
            typeof value.error.code !== "string")))
    ) {
      throw new Error(
        "Malformed Delegate diagnostic emitted at the public boundary",
      );
    }
    records.push(value as unknown as DiagnosticRecord);
  }
  return records;
}
