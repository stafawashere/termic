import { describe, it, expect } from "vitest";
import { cellFromGlyph } from "@/lib/terminalCell";

describe("cellFromGlyph", () => {
  it("floors the width and ceils the height at the device pixel ratio", () => {
    expect(cellFromGlyph({ width: 7.83, height: 15.2 }, 2, 0, 1)).toEqual({ width: 7.5, height: 15.5 });
  });

  it("adds letter spacing to the width and scales the height by line height", () => {
    expect(cellFromGlyph({ width: 8, height: 16 }, 1, 2, 1.25)).toEqual({ width: 10, height: 20 });
  });

  it("treats a missing pixel ratio as 1", () => {
    expect(cellFromGlyph({ width: 8.4, height: 15.1 }, 0, 0, 1)).toEqual({ width: 8, height: 16 });
  });
});
