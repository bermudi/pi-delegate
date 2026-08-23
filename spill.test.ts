import { describe, expect, test, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  decideSpill,
  spillToTempFile,
  renderOutputForLLM,
  renderOutputForPoll,
  sweepStaleSpillFiles,
} from "./spill.ts";

// Sweep any spill files this suite (or production code under test) drops in
// the system tmpdir. Production removes only files older than its retention
// window, but tests must not leak fresh artifacts.
function sweepSpillFiles(): void {
  const dir = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith("delegate-output-")) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

afterEach(sweepSpillFiles);

// ── decideSpill (pure) ───────────────────────────────────────────────────

describe("decideSpill", () => {
  test("under threshold passes through unchanged, no spill", () => {
    const out = "x".repeat(100);
    const d = decideSpill(out, { thresholdChars: 200, tailChars: 50 });
    expect(d.spill).toBe(false);
    expect(d.inContext).toBe(out);
    expect(d.fullChars).toBe(100);
  });

  test("exactly at threshold does NOT spill (strictly over only)", () => {
    const out = "x".repeat(200);
    const d = decideSpill(out, { thresholdChars: 200, tailChars: 50 });
    expect(d.spill).toBe(false);
    expect(d.inContext).toBe(out);
  });

  test("over threshold spills and keeps a tail of the requested length", () => {
    const out = "x".repeat(300);
    const d = decideSpill(out, { thresholdChars: 200, tailChars: 50 });
    expect(d.spill).toBe(true);
    expect(d.fullChars).toBe(300);
    expect(d.inContext.length).toBe(50);
  });

  test("the tail is the SUFFIX, not the prefix", () => {
    const head = "HEADHEADHEAD";
    const tail = "TAILTAILTAIL";
    const out = head + "M".repeat(300) + tail; // well over threshold
    const d = decideSpill(out, { thresholdChars: 100, tailChars: 12 });
    expect(d.spill).toBe(true);
    expect(d.inContext).toBe(tail); // exact-length suffix == the tail marker
    expect(d.inContext).not.toContain("HEAD");
    expect(d.inContext).not.toContain("M");
  });

  test("tail shorter than tailChars returns the whole output", () => {
    const out = "short";
    const d = decideSpill(out, { thresholdChars: 2, tailChars: 50 });
    expect(d.spill).toBe(true);
    expect(d.inContext).toBe("short");
  });

  test("surrogate-pair-aware: cut does not begin on a lone trailing surrogate", () => {
    // A string ending in astral chars (emoji). Force a cut that, by code-unit
    // length, would land on the trailing surrogate of a pair.
    const out = "a".repeat(100) + "😀".repeat(50); // 😀 = 2 UTF-16 units each
    const d = decideSpill(out, { thresholdChars: 10, tailChars: 5 });
    expect(d.spill).toBe(true);
    // The in-context string must not start with a lone trailing surrogate
    // (0xDC00–0xDFFF), which would render as a replacement char.
    const first = d.inContext.charCodeAt(0);
    expect(first).toBeGreaterThanOrEqual(0xd800); // it's a leading surrogate of a pair
    expect(first).toBeLessThanOrEqual(0xdbff);
  });
});

// ── spillToTempFile (I/O) ────────────────────────────────────────────────

describe("spillToTempFile", () => {
  test("writes the full content to a file under os.tmpdir() and returns its path", () => {
    const out = "the full output\nwith multiple lines";
    const p = spillToTempFile(out, "scout", "abc123");
    expect(p).not.toBeNull();
    expect(p!).toMatch(/delegate-output-scout-abc123\.md$/);
    expect(path.dirname(p!)).toBe(os.tmpdir());
    expect(fs.readFileSync(p!, "utf8")).toBe(out);
  });

  test("sanitizes the label so agent names cannot escape the filename", () => {
    const p = spillToTempFile("x", "scout/../../../etc", "zz");
    expect(p).not.toBeNull();
    const name = path.basename(p!);
    // No path separators survive sanitization — slashes become underscores —
    // so the result is a flat filename that cannot escape its directory.
    expect(name).not.toContain("/");
    expect(name).toMatch(/^delegate-output-/);
    expect(name).toMatch(/-zz\.md$/);
  });

  test("unique names via distinct suffixes (suffix is injectable)", () => {
    const a = spillToTempFile("x", "scout", "aa0000");
    const b = spillToTempFile("x", "scout", "bb1111");
    expect(a).not.toBe(b);
  });

  test("production names carry 128 bits of random suffix", () => {
    const p = spillToTempFile("x", "scout");
    expect(p).not.toBeNull();
    expect(path.basename(p!)).toMatch(
      /^delegate-output-scout-[0-9a-f]{32}\.md$/,
    );
  });

  test("exclusive creation never overwrites a colliding spill", () => {
    const existing = spillToTempFile("first", "scout", "collision");
    expect(existing).not.toBeNull();
    const collided = spillToTempFile("second", "scout", "collision");
    expect(collided).toBeNull();
    expect(fs.readFileSync(existing!, "utf8")).toBe("first");
  });

  test("stale cleanup removes old spills but retains fresh context pointers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-spill-sweep-"));
    try {
      const oldPath = path.join(dir, "delegate-output-old-deadbeef.md");
      const freshPath = path.join(dir, "delegate-output-fresh-cafebabe.md");
      fs.writeFileSync(oldPath, "old");
      fs.writeFileSync(freshPath, "fresh");
      const now = Date.now();
      fs.utimesSync(oldPath, new Date(now - 2_000), new Date(now - 2_000));
      fs.utimesSync(freshPath, new Date(now - 500), new Date(now - 500));

      sweepStaleSpillFiles(dir, now, 1_000);

      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(freshPath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file is created mode 0o600 (owner read/write only)", () => {
    const p = spillToTempFile("secret output", "reviewer", "perm");
    expect(p).not.toBeNull();
    const mode = fs.statSync(p!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("returns null (never throws) when the write target is unwritable", () => {
    // Point the file at a non-existent directory: writeFileSync throws ENOENT.
    // The lossless contract is "return null, do not throw".
    const p = spillToTempFile(
      "x",
      "scout",
      "fail",
      "/nonexistent-dir-delegate-spill-test",
    );
    expect(p).toBeNull();
  });
});

// ── renderOutputForLLM (composition) ─────────────────────────────────────

describe("renderOutputForLLM", () => {
  test("under threshold returns the output unchanged", () => {
    const out = "small output";
    const rendered = renderOutputForLLM(out, "scout", {
      thresholdChars: 100,
      tailChars: 10,
    });
    expect(rendered).toBe(out);
  });

  test("over threshold returns tail + pointer and writes a spill file", () => {
    const head = "HEADMARKER" + "a".repeat(300);
    const tail = "b".repeat(300) + "TAILMARKER";
    const out = head + tail; // > threshold, tail marker lands in the kept tail
    const rendered = renderOutputForLLM(out, "scout", {
      thresholdChars: 200,
      tailChars: 30,
    });

    // The tail is kept; the head is not.
    expect(rendered).toContain("…");
    expect(rendered).toContain("TAILMARKER");
    expect(rendered).not.toContain("HEADMARKER");
    // Pointer names a real file and states the size.
    expect(rendered).toContain("spilled to");
    expect(rendered).toContain("above is the tail");

    // Extract the path and confirm the full output (incl. head) was written.
    const match = rendered.match(/spilled to (.+?) —/);
    expect(match).not.toBeNull();
    const filePath = match![1]!;
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toBe(out);
    expect(filePath).toMatch(/delegate-output-scout-/);
  });

  test("write failure degrades to the full output unchanged (lossless)", () => {
    const out = "x".repeat(500);
    const rendered = renderOutputForLLM(out, "scout", {
      thresholdChars: 100,
      tailChars: 20,
      dir: "/nonexistent-dir-delegate-spill-test",
    });
    // No spill file possible → full output returned verbatim, no throw.
    expect(rendered).toBe(out);
    expect(rendered).not.toContain("spilled to");
  });

  test("empty / placeholder outputs pass through without spilling", () => {
    for (const out of ["", "   ", "(no output)"]) {
      const rendered = renderOutputForLLM(out, "scout", {
        thresholdChars: 1,
        tailChars: 1,
      });
      expect(rendered).toBe(out);
    }
  });
});

// ── renderOutputForPoll (running-ticket tail, no file) ───────────────────

describe("renderOutputForPoll", () => {
  test("under tail budget returns the output unchanged", () => {
    const out = "short";
    expect(renderOutputForPoll(out, { tailChars: 100 })).toBe(out);
  });

  test("does not promise a spill when output is below the spill threshold", () => {
    const rendered = renderOutputForPoll("x".repeat(50), {
      tailChars: 10,
      thresholdChars: 100,
    });
    expect(rendered).toContain("full output will be included");
    expect(rendered).not.toContain("spilled to a file");
  });

  test("over tail budget returns the tail + a note, and writes NO file", () => {
    const head = "HEADMARKER" + "a".repeat(300);
    const tail = "b".repeat(300) + "TAILMARKER";
    const out = head + tail;
    const rendered = renderOutputForPoll(out, {
      tailChars: 30,
      thresholdChars: 100,
    });
    expect(rendered).toContain("…");
    expect(rendered).toContain("TAILMARKER");
    expect(rendered).not.toContain("HEADMARKER");
    expect(rendered).toContain("truncated");
    expect(rendered).toContain("spilled to a file when the ticket completes");
    // Critically: no file is written for the poll path.
    expect(rendered).not.toMatch(/^.*spilled to \/.*\.md/);
  });

  test("empty / placeholder pass through", () => {
    for (const out of ["", "   ", "(no output)"]) {
      expect(renderOutputForPoll(out, { tailChars: 1 })).toBe(out);
    }
  });
});
