/** Authored preparation guidance. Optional telemetry text excludes caller-owned paths and IDs. */
export class SafePreparationError extends Error {
  constructor(message: string, readonly telemetryMessage: string = message) {
    super(message);
  }
}
