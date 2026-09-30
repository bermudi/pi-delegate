import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Engine suites explicitly opt into retained advanced call controls. */
export default function fullSurfaceFixture(api: ExtensionAPI): void {
  api.on("session_start", (_event, ctx) => {
    const path = join(ctx.cwd, "delegate.json");
    const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Full-surface fixture expected an object config.");
    }
    writeFileSync(path, JSON.stringify({ surface: "full", ...raw }));
  });
}
