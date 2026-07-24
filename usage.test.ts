import { describe, expect, test } from "bun:test";
import type { Usage } from "@mariozechner/pi-ai";
import {
  addUsage,
  emptyUsage,
  sumUsage,
  usageDelta,
  type SessionUsageSnapshot,
} from "./usage.ts";

describe("nested usage accounting", () => {
  test("turns cumulative session stats into a non-negative delta", () => {
    const before: SessionUsageSnapshot = {
      input: 100,
      output: 20,
      cacheRead: 500,
      cacheWrite: 50,
      cost: 0.02,
    };
    const after: SessionUsageSnapshot = {
      input: 260,
      output: 45,
      cacheRead: 500,
      cacheWrite: 90,
      cost: 0.05,
    };
    const u = usageDelta(before, after);
    expect(u.input).toBe(160);
    expect(u.output).toBe(25);
    expect(u.cacheRead).toBe(0);
    expect(u.cacheWrite).toBe(40);
    expect(u.totalTokens).toBe(160 + 25 + 0 + 40);
    expect(u.cost.total).toBeCloseTo(0.03);
  });

  test("never reports a negative delta when stats move backwards", () => {
    const before: SessionUsageSnapshot = {
      input: 300,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.1,
    };
    const after: SessionUsageSnapshot = {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    const u = usageDelta(before, after);
    expect(u.input).toBe(0);
    expect(u.cost.total).toBe(0);
  });

  test("combines task usage and preserves optional breakdowns", () => {
    const a: Usage = {
      ...emptyUsage(),
      input: 10,
      output: 5,
      totalTokens: 15,
      reasoning: 3,
    };
    const b: Usage = {
      ...emptyUsage(),
      input: 7,
      output: 2,
      totalTokens: 9,
      cacheWrite1h: 1,
    };
    const sum = addUsage(a, b);
    expect(sum.input).toBe(17);
    expect(sum.output).toBe(7);
    expect(sum.totalTokens).toBe(24);
    expect(sum.reasoning).toBe(3);
    expect(sum.cacheWrite1h).toBe(1);
  });

  test("adds usage without mutating either operand", () => {
    const a: Usage = { ...emptyUsage(), input: 4, totalTokens: 4 };
    const b: Usage = { ...emptyUsage(), input: 6, totalTokens: 6 };
    const sum = addUsage(a, b);
    expect(sum.input).toBe(10);
    expect(a.input).toBe(4);
    expect(b.input).toBe(6);
  });

  test("sumUsage skips undefined entries", () => {
    const u: Usage = { ...emptyUsage(), input: 8, totalTokens: 8 };
    expect(sumUsage([undefined, u, undefined]).input).toBe(8);
    expect(sumUsage([]).totalTokens).toBe(0);
  });
});
