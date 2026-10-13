import { describe, expect, it } from "vitest";
import { createReadTicket, decideDiskAction, guardWriteAgainstStaleReads, isMissingFileError, minimalChange, toDocSpace } from "./externalReload";

describe("minimalChange", () => {
  it("returns null for equal text", () => {
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("replaces only the differing span", () => {
    const change = minimalChange("one\ntwo\nthree\n", "one\nTWO!\nthree\n");

    expect(change).toEqual({ from: 4, to: 7, insert: "TWO!" });
  });

  it("handles a pure append", () => {
    expect(minimalChange("abc", "abcdef")).toEqual({ from: 3, to: 3, insert: "def" });
  });

  it("handles a pure deletion", () => {
    expect(minimalChange("abcdef", "abf")).toEqual({ from: 2, to: 5, insert: "" });
  });

  it("does not let prefix and suffix overlap on repeated characters", () => {
    const change = minimalChange("aaa", "aaaa");
    const rebuilt = "aaa".slice(0, change!.from) + change!.insert + "aaa".slice(change!.to);

    expect(rebuilt).toBe("aaaa");
  });

  it("covers a full replacement", () => {
    expect(minimalChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
  });
});

describe("toDocSpace", () => {
  it("collapses CRLF and lone CR to LF", () => {
    expect(toDocSpace("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});

describe("isMissingFileError", () => {
  it("matches the Rust open failure", () => {
    expect(isMissingFileError("open failed: No such file or directory (os error 2)")).toBe(true);
  });

  it("does not match a binary or oversize rejection", () => {
    expect(isMissingFileError("file is not valid UTF-8")).toBe(false);
    expect(isMissingFileError("file too large to preview (3000000 bytes)")).toBe(false);
  });
});

describe("createReadTicket", () => {
  it("only lets the newest ticket apply", () => {
    const tickets = createReadTicket();

    const first = tickets.next();
    const second = tickets.next();

    expect(tickets.isLatest(first)).toBe(false);
    expect(tickets.isLatest(second)).toBe(true);
  });
});

describe("decideDiskAction with reindent and autosave", () => {
  const threeSpaced = "if (a) {\n   b();\n}\n";
  const twoSpaced = "if (a) {\n  b();\n}\n";

  it("leaves a reindented, still unsaved buffer alone while disk holds what was loaded", () => {
    const action = decideDiskAction({
      disk: twoSpaced, buffer: threeSpaced, base: twoSpaced, inFlightWrite: null, isDirty: true,
    });

    expect(action).toBe("unchanged");
  });

  it("ignores the echo of the autosave that writes the reindented text", () => {
    const action = decideDiskAction({
      disk: threeSpaced, buffer: threeSpaced + "x", base: twoSpaced, inFlightWrite: threeSpaced, isDirty: true,
    });

    expect(action).toBe("ignore");
  });

  it("does not reload, reindent or dirty a buffer once the save has landed", () => {
    const afterSaveBase = threeSpaced;
    const action = decideDiskAction({
      disk: threeSpaced, buffer: threeSpaced, base: afterSaveBase, inFlightWrite: null, isDirty: false,
    });

    expect(action).toBe("adopt");
  });

  it("treats an echo that lands after the save finished but with newer typing as unchanged", () => {
    const action = decideDiskAction({
      disk: threeSpaced, buffer: threeSpaced + "y", base: threeSpaced, inFlightWrite: null, isDirty: true,
    });

    expect(action).toBe("unchanged");
  });

  it("replaces a clean buffer and merges a dirty one when someone else wrote", () => {
    const outside = "if (a) {\n  c();\n}\n";

    expect(decideDiskAction({
      disk: outside, buffer: threeSpaced, base: threeSpaced, inFlightWrite: null, isDirty: false,
    })).toBe("replace");
    expect(decideDiskAction({
      disk: outside, buffer: threeSpaced + "z", base: threeSpaced, inFlightWrite: null, isDirty: true,
    })).toBe("merge");
  });

  it("does not ignore a later outside write that equals an older save", () => {
    const action = decideDiskAction({
      disk: threeSpaced, buffer: "other\n", base: "newer\n", inFlightWrite: null, isDirty: false,
    });

    expect(action).toBe("replace");
  });
});

describe("guardWriteAgainstStaleReads", () => {
  it("drops a read that started before the save, both while it runs and after it ends", async () => {
    const tickets = createReadTicket();
    let finishWrite: () => void = () => {};
    const write = () => new Promise<void>(resolve => { finishWrite = resolve; });

    const readBeforeSave = tickets.next();
    const saving = guardWriteAgainstStaleReads(tickets, write);
    expect(tickets.isLatest(readBeforeSave)).toBe(false);

    const readDuringSave = tickets.next();
    finishWrite();
    await saving;

    expect(tickets.isLatest(readDuringSave)).toBe(false);
    expect(tickets.isLatest(tickets.next())).toBe(true);
  });

  it("still drops stale reads when the write fails", async () => {
    const tickets = createReadTicket();
    const readDuringSave = tickets.next();

    await guardWriteAgainstStaleReads(tickets, () => Promise.reject(new Error("disk full"))).catch(() => {});

    expect(tickets.isLatest(readDuringSave)).toBe(false);
  });
});
