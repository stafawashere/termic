import { describe, it, expect } from "vitest";
import { buildExcerpts, saveTargets, spliceExcerpts } from "@/lib/multibuffer";

const numbered = (count: number, eol = "\n", trailing = true) => {
  const body = Array.from({ length: count }, (_, index) => `line ${index + 1}`).join(eol);
  return trailing ? body + eol : body;
};

describe("buildExcerpts", () => {
  it("merges adjacent and overlapping ranges into one excerpt", () => {
    const fileTexts = { "a.ts": numbered(30) };
    const excerpts = buildExcerpts(
      [{ path: "a.ts", line: 10 }, { path: "a.ts", line: 14 }, { path: "a.ts", line: 11 }],
      fileTexts,
    );

    expect(excerpts).toHaveLength(1);
    expect(excerpts[0].startLine).toBe(7);
    expect(excerpts[0].endLine).toBe(17);
    expect(excerpts[0].text).toBe(excerpts[0].baseText);
  });

  it("keeps ranges that leave a gap apart and clamps to the file", () => {
    const excerpts = buildExcerpts(
      [{ path: "a.ts", line: 1 }, { path: "a.ts", line: 20 }, { path: "a.ts", line: 99 }],
      { "a.ts": numbered(20) },
    );

    expect(excerpts.map((e) => [e.startLine, e.endLine])).toEqual([[1, 4], [17, 20]]);
  });

  it("groups per file and skips unknown files", () => {
    const excerpts = buildExcerpts(
      [{ path: "a.ts", line: 2 }, { path: "b.ts", line: 2 }, { path: "gone.ts", line: 1 }],
      { "a.ts": numbered(5), "b.ts": numbered(5) },
      1,
    );

    expect(excerpts.map((e) => [e.path, e.startLine, e.endLine])).toEqual([
      ["a.ts", 1, 3],
      ["b.ts", 1, 3],
    ]);
  });
});

describe("spliceExcerpts", () => {
  it("applies several excerpts in one file bottom-up", () => {
    const fileText = numbered(30);
    const [top, bottom] = buildExcerpts(
      [{ path: "a.ts", line: 3 }, { path: "a.ts", line: 25 }],
      { "a.ts": fileText },
      1,
    );
    top.text = "two\nthree\nfour\nfour and a half";
    bottom.text = bottom.text.replace("line 25", "LINE 25");

    const expectedLines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    expectedLines[24] = "LINE 25";
    expectedLines.splice(1, 3, "two", "three", "four", "four and a half");
    const expected = expectedLines.join("\n") + "\n";

    expect(spliceExcerpts(fileText, [top, bottom])).toBe(expected);
  });

  it("handles an excerpt that shrank", () => {
    const fileText = numbered(10);
    const [excerpt] = buildExcerpts([{ path: "a.ts", line: 5 }], { "a.ts": fileText }, 2);
    excerpt.text = "line 3\nline 7";

    expect(spliceExcerpts(fileText, [excerpt])).toBe("line 1\nline 2\nline 3\nline 7\nline 8\nline 9\nline 10\n");
  });

  it("preserves CRLF line endings", () => {
    const fileText = numbered(6, "\r\n");
    const [excerpt] = buildExcerpts([{ path: "a.ts", line: 3 }], { "a.ts": fileText }, 1);
    expect(excerpt.text.includes("\r")).toBe(false);
    excerpt.text = excerpt.text.replace("line 3", "edited\nextra");

    const result = spliceExcerpts(fileText, [excerpt]);

    expect(result).toBe("line 1\r\nline 2\r\nedited\r\nextra\r\nline 4\r\nline 5\r\nline 6\r\n");
    expect(result.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("keeps a missing trailing newline missing", () => {
    const fileText = numbered(4, "\n", false);
    const [excerpt] = buildExcerpts([{ path: "a.ts", line: 4 }], { "a.ts": fileText }, 1);
    excerpt.text = "line 3\nlast";

    expect(spliceExcerpts(fileText, [excerpt])).toBe("line 1\nline 2\nline 3\nlast");
  });

  it("returns the file unchanged when no excerpt was edited", () => {
    const fileText = numbered(8);
    const excerpts = buildExcerpts([{ path: "a.ts", line: 4 }], { "a.ts": fileText });

    expect(spliceExcerpts(fileText, excerpts)).toBe(fileText);
  });
});

describe("saveTargets", () => {
  it("returns new content for an edited file and skips untouched ones", () => {
    const texts = { "a.ts": numbered(8), "b.ts": numbered(8) };
    const excerpts = buildExcerpts(
      [{ path: "a.ts", line: 4 }, { path: "b.ts", line: 4 }],
      texts,
      1,
    );
    excerpts[0].text = excerpts[0].text.replace("line 4", "changed");

    const targets = saveTargets(excerpts, texts);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toEqual({
      path: "a.ts",
      status: "write",
      content: texts["a.ts"].replace("line 4", "changed"),
    });
  });

  it("reports a conflict when the disk text moved on", () => {
    const texts = { "a.ts": numbered(8) };
    const [excerpt] = buildExcerpts([{ path: "a.ts", line: 4 }], texts, 1);
    excerpt.text = "edited";

    const drifted = { "a.ts": texts["a.ts"].replace("line 4", "someone else") };

    expect(saveTargets([excerpt], drifted)).toEqual([{ path: "a.ts", status: "conflict" }]);
    expect(saveTargets([excerpt], {})).toEqual([{ path: "a.ts", status: "conflict" }]);
  });

  it("reports a conflict when the file shrank below the excerpt", () => {
    const texts = { "a.ts": numbered(8) };
    const [excerpt] = buildExcerpts([{ path: "a.ts", line: 8 }], texts, 1);
    excerpt.text = "edited";

    expect(saveTargets([excerpt], { "a.ts": numbered(3) })).toEqual([{ path: "a.ts", status: "conflict" }]);
  });
});
