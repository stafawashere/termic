import { describe, expect, it } from "vitest";
import { threeWayMerge } from "./threeWayMerge";

const lines = (...rows: string[]) => rows.join("\n") + "\n";

describe("threeWayMerge", () => {
  it("merges edits in separate regions", () => {
    const base = lines("a", "b", "c", "d", "e");
    const ours = lines("a", "B", "c", "d", "e");
    const theirs = lines("a", "b", "c", "d", "E");

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: lines("a", "B", "c", "d", "E") });
  });

  it("keeps an insertion from either side", () => {
    const base = lines("a", "b", "c");
    const ours = lines("a", "x", "b", "c");
    const theirs = lines("a", "b", "c", "y");

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: lines("a", "x", "b", "c", "y") });
  });

  it("reports a conflict when both sides change the same line differently", () => {
    const base = lines("a", "b", "c");
    const ours = lines("a", "mine", "c");
    const theirs = lines("a", "theirs", "c");

    const result = threeWayMerge(base, ours, theirs);

    expect(result.conflict).toBe(true);
    expect(result.text).toBe(ours);
  });

  it("accepts both sides making the same change", () => {
    const base = lines("a", "b", "c");
    const ours = lines("a", "same", "c");
    const theirs = lines("a", "same", "c");

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: ours });
  });

  it("conflicts when one side deletes a line the other edits", () => {
    const base = lines("a", "b", "c");
    const ours = lines("a", "c");
    const theirs = lines("a", "B", "c");

    const result = threeWayMerge(base, ours, theirs);

    expect(result.conflict).toBe(true);
  });

  it("applies a deletion when the other side left the line alone", () => {
    const base = lines("a", "b", "c", "d");
    const ours = lines("a", "c", "d");
    const theirs = lines("a", "b", "c", "D");

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: lines("a", "c", "D") });
  });

  it("merges CRLF text and keeps CRLF", () => {
    const base = "a\r\nb\r\nc\r\nd\r\n";
    const ours = "a\r\nB\r\nc\r\nd\r\n";
    const theirs = "a\r\nb\r\nc\r\nD\r\n";

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: "a\r\nB\r\nc\r\nD\r\n" });
  });

  it("treats CRLF and LF spellings of the same lines as equal", () => {
    const base = lines("a", "b");
    const ours = "a\r\nb\r\nc\r\n";
    const theirs = lines("a", "b", "c");

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: ours });
  });

  it("handles a missing trailing newline on one side", () => {
    const base = "a\nb";
    const ours = "a\nb\n";
    const theirs = "A\nb";

    const result = threeWayMerge(base, ours, theirs);

    expect(result).toEqual({ conflict: false, text: "A\nb\n" });
  });

  it("merges against an empty base when only one side wrote", () => {
    const result = threeWayMerge("", "", lines("hello"));

    expect(result).toEqual({ conflict: false, text: lines("hello") });
  });

  it("conflicts against an empty base when both sides wrote different text", () => {
    const result = threeWayMerge("", lines("mine"), lines("theirs"));

    expect(result.conflict).toBe(true);
  });

  it("returns ours untouched when theirs equals the base", () => {
    const base = lines("a", "b");
    const ours = lines("a", "b", "typed");

    const result = threeWayMerge(base, ours, base);

    expect(result).toEqual({ conflict: false, text: ours });
  });
});
