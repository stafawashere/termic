import { describe, it, expect } from "vitest";
import { nextTruncateLines } from "@/lib/subagentPrefs";

describe("nextTruncateLines", () => {
  it("steps 20, 40, 100, then no cap, and round again", () => {
    expect([20, 40, 100, 0].map(nextTruncateLines)).toEqual([40, 100, 0, 20]);
  });

  it("moves a custom cap from Settings to the next larger step, or off past the last", () => {
    expect(nextTruncateLines(7)).toBe(20);
    expect(nextTruncateLines(60)).toBe(100);
    expect(nextTruncateLines(500)).toBe(0);
  });
});
