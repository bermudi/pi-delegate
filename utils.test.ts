import { describe, expect, test } from "bun:test";
import {
  sanitizeTerminalLine,
  sanitizeTerminalText,
  stripAnsi,
} from "./utils.ts";

describe("terminal text sanitization", () => {
  test("stripAnsi removes C1 and ESC-prefixed control strings with either ST form", () => {
    const input =
      `a\x9d0;title\x07b` +
      `c\x9d8;;https://example.test\x9cd` +
      `e\x90dcs payload\x9cf` +
      `g\x9fapc payload\x1b\\h` +
      `i\x1b]osc payload\x9cj` +
      `k\x1bPmore dcs\x1b\\l`;

    expect(stripAnsi(input)).toBe("abcdefghijkl");
  });

  test("sanitizeTerminalText preserves layout while removing terminal controls", () => {
    const input = "  one\x1b]0;title\x07\t two\r\nthree\x00  ";
    expect(sanitizeTerminalText(input)).toBe("  one  two\nthree   ");
  });

  test("sanitizeTerminalLine removes BEL, backspace, and residual controls", () => {
    const input = "one\x07two\bthree\x00four\x7ffive\x85six\x9cseven\n eight";
    const sanitized = sanitizeTerminalLine(input);

    expect(sanitized).toBe("one two three four five six seven eight");
    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("terminal sanitizers strip Unicode bidi formatting controls", () => {
    const bidiControls =
      "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const input = `left${bidiControls}right\nnext`;

    expect(sanitizeTerminalText(input)).toBe("leftright\nnext");
    expect(sanitizeTerminalLine(input)).toBe("leftright next");
    expect(sanitizeTerminalText(input)).not.toMatch(
      /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/,
    );
  });

  test("unterminated control strings are handled without repeated rescanning", () => {
    const hostile = "\x1b]".repeat(100_000);
    expect(stripAnsi(hostile)).toBe("");
  });

  test("malformed CSI stops before TAB, LF, and CR to preserve diagnostic layout", () => {
    const input = "head\x1b[31\tcolumn\x1b[32\nline\x9b33\rtail";
    expect(stripAnsi(input)).toBe("head\tcolumn\nline\rtail");
    expect(sanitizeTerminalText(input)).toBe("head column\nline\ntail");
  });

  test("standalone ESC-backslash ST preserves a word boundary", () => {
    expect(stripAnsi("left\x1b\\right")).toBe("left right");
    expect(sanitizeTerminalLine("left\x1b\\right")).toBe("left right");
  });

  test("malformed generic ESC does not split or remove Unicode text", () => {
    expect(stripAnsi("a\x1b😀b")).toBe("a😀b");
  });
});
