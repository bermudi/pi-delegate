import { describe, expect, test } from "bun:test";
import { formatResumeTag, resumeMarker } from "./format.ts";

describe("formatResumeTag", () => {
  test("derives the UUID prefix from a pi session path", () => {
    expect(
      formatResumeTag(
        "/home/u/.pi/agent/sessions/--home-daniel-build-pi-delegate--/2026-08-20T06-56-16-677Z_01a01df4-c925-7d92-a125-79eaacdfe2a9.jsonl",
      ),
    ).toBe("01a01df4");
  });

  test("falls back to the stem when the name has no _ segment", () => {
    expect(formatResumeTag("/tmp/sessions/custom-name.jsonl")).toBe("custom-n");
  });

  test("never returns an empty tag", () => {
    expect(formatResumeTag(".jsonl")).toBe("resumed");
  });
});

describe("resumeMarker", () => {
  test("marks a resumed row whose agent name lacks the resume identity", () => {
    expect(resumeMarker({ agent: "coder", resumedFrom: "01a01df4" })).toBe(
      " ↻01a01df4",
    );
  });

  test("stays empty when the identity already carries the resume label", () => {
    expect(
      resumeMarker({ agent: "resume:01a01df4", resumedFrom: "01a01df4" }),
    ).toBe("");
  });

  test("stays empty for fresh tasks", () => {
    expect(resumeMarker({ agent: "ad-hoc" })).toBe("");
    expect(resumeMarker({ agent: "ad-hoc", resumedFrom: undefined })).toBe("");
  });
});
