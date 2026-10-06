import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// #122: actual diagnostic bases differ from engine agentDir; synthetic source
// Git, real PTY, public registered tools and provider-free workers only.
const ttyTest =
  process.platform === "linux" && Bun.which("script") ? test : test.skip;
for (const scenario of ["primary", "fallback"]) {
  ttyTest(
    `${scenario} runtime inside source is absent from both worker copies, private Git blobs and evidence`,
    async () => {
      const scratch = mkdtempSync(
        join(tmpdir(), "delegate-runtime-copy-test-"),
      );
      try {
        const source = join(scratch, "source");
        const quote = (value: string): string =>
          "'" + value.replaceAll("'", "'\\''") + "'";
        const cmd = [
          process.execPath,
          resolve(
            import.meta.dirname,
            "../support/diagnostic-workspaces-child.ts",
          ),
          scenario,
        ]
          .map(quote)
          .join(" ");
        const child = Bun.spawn(
          ["script", "-q", "-e", "-c", cmd, "/dev/null"],
          {
            env: {
              ...process.env,
              DELEGATE_AGENT_DIR: "",
              PI_CODING_AGENT_DIR: "",
              HOME: join(source, "home"),
              DIAGNOSTIC_PI_FIXTURE: join(source, "home", ".pi", "agent"),
              TMPDIR: join(source, "temp"),
              DIAGNOSTIC_SOURCE_FIXTURE: source,
              DIAGNOSTIC_ENGINE_FIXTURE: join(scratch, "engine"),
              NO_COLOR: "1",
              FORCE_COLOR: "0",
              TERM: "dumb",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({
          code,
          output: stdout.replaceAll("\r", "").trim(),
          stderr,
        }).toEqual({
          code: 0,
          output: "DIAGNOSTIC_WORKSPACE_OK",
          stderr: "",
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    30_000,
  );
}
