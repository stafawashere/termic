import { describe, it, expect } from "vitest";
import {
  applyTextEdits,
  applyWorkspaceEdit,
  editsByUri,
  type EditTargets,
  type LspTextEdit,
} from "./applyWorkspaceEdit";

const edit = (
  startLine: number, startChar: number, endLine: number, endChar: number, newText: string,
): LspTextEdit => ({
  range: {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  },
  newText,
});

function fakeTargets(files: Record<string, string>, open: Set<string> = new Set()) {
  const written: Record<string, string> = {};
  const openEdits: Record<string, LspTextEdit[]> = {};
  const targets: EditTargets = {
    applyOpen: (uri, edits) => {
      if (!open.has(uri)) return false;
      openEdits[uri] = edits;
      return true;
    },
    read: async uri => files[uri] ?? null,
    write: async (uri, text) => {
      if (uri.includes("readonly")) throw new Error("permission denied");
      written[uri] = text;
    },
  };
  return { targets, written, openEdits };
}

describe("applyTextEdits", () => {
  it("applies several edits against the original positions, last first", () => {
    const text = "let foo = foo + 1;\nreturn foo;\n";
    const out = applyTextEdits(text, [
      edit(0, 4, 0, 7, "bar"),
      edit(0, 10, 0, 13, "bar"),
      edit(1, 7, 1, 10, "bar"),
    ]);
    expect(out).toBe("let bar = bar + 1;\nreturn bar;\n");
  });

  it("gives the same answer whatever order the edits arrive in", () => {
    const text = "aa bb cc";
    const forward = [edit(0, 0, 0, 2, "X"), edit(0, 6, 0, 8, "Z")];
    expect(applyTextEdits(text, forward)).toBe(applyTextEdits(text, [...forward].reverse()));
    expect(applyTextEdits(text, forward)).toBe("X bb Z");
  });

  it("keeps two inserts at one position in the order they were sent", () => {
    const out = applyTextEdits("ab", [edit(0, 1, 0, 1, "1"), edit(0, 1, 0, 1, "2")]);
    expect(out).toBe("a12b");
  });

  it("handles CRLF text without counting the carriage return as a column", () => {
    const out = applyTextEdits("one\r\ntwo\r\n", [edit(1, 0, 1, 3, "2")]);
    expect(out).toBe("one\r\n2\r\n");
  });

  it("clamps a character past the end of its line to the line end", () => {
    const out = applyTextEdits("ab\ncd", [edit(0, 99, 0, 99, "!")]);
    expect(out).toBe("ab!\ncd");
  });

  it("rejects overlapping edits instead of mangling the file", () => {
    expect(() => applyTextEdits("abcdef", [edit(0, 0, 0, 4, "x"), edit(0, 2, 0, 5, "y")]))
      .toThrow(/overlapping/);
  });
});

describe("editsByUri", () => {
  it("reads the changes form", () => {
    const { byUri } = editsByUri({ changes: { "file:///a.ts": [edit(0, 0, 0, 1, "x")] } });
    expect(byUri.get("file:///a.ts")).toHaveLength(1);
  });

  it("reads the documentChanges form, merging two entries for one file", () => {
    const { byUri, unsupported } = editsByUri({
      documentChanges: [
        { textDocument: { uri: "file:///a.ts" }, edits: [edit(0, 0, 0, 1, "x")] },
        { textDocument: { uri: "file:///a.ts" }, edits: [edit(1, 0, 1, 1, "y")] },
        { textDocument: { uri: "file:///b.ts" }, edits: [edit(0, 0, 0, 1, "z")] },
      ],
    });
    expect(byUri.get("file:///a.ts")).toHaveLength(2);
    expect(byUri.get("file:///b.ts")).toHaveLength(1);
    expect(unsupported).toEqual([]);
  });

  it("reports file operations instead of ignoring them", () => {
    const { unsupported } = editsByUri({
      documentChanges: [{ kind: "rename", oldUri: "file:///old.ts", uri: "file:///new.ts" }],
    });
    expect(unsupported).toEqual(["rename file:///new.ts"]);
  });
});

describe("applyWorkspaceEdit", () => {
  it("sends an open file's edits to its editor and never touches the disk", async () => {
    const { targets, written, openEdits } = fakeTargets(
      { "file:///a.ts": "stale disk text" },
      new Set(["file:///a.ts"]),
    );
    const result = await applyWorkspaceEdit(
      { changes: { "file:///a.ts": [edit(0, 0, 0, 1, "x")] } },
      targets,
    );
    expect(result.applied).toEqual(["file:///a.ts"]);
    expect(openEdits["file:///a.ts"]).toHaveLength(1);
    expect(written).toEqual({});
  });

  it("writes an unopened file through the write path, with every edit applied", async () => {
    const { targets, written } = fakeTargets({ "file:///b.ts": "foo();\nfoo();\n" });
    const result = await applyWorkspaceEdit(
      {
        documentChanges: [{
          textDocument: { uri: "file:///b.ts" },
          edits: [edit(0, 0, 0, 3, "bar"), edit(1, 0, 1, 3, "bar")],
        }],
      },
      targets,
    );
    expect(result.failed).toEqual([]);
    expect(written["file:///b.ts"]).toBe("bar();\nbar();\n");
  });

  it("handles a mix of an open file and an unopened one", async () => {
    const { targets, written, openEdits } = fakeTargets(
      { "file:///b.ts": "foo" },
      new Set(["file:///a.ts"]),
    );
    const result = await applyWorkspaceEdit(
      {
        changes: {
          "file:///a.ts": [edit(0, 0, 0, 1, "x")],
          "file:///b.ts": [edit(0, 0, 0, 3, "bar")],
        },
      },
      targets,
    );
    expect(result.applied.sort()).toEqual(["file:///a.ts", "file:///b.ts"]);
    expect(Object.keys(openEdits)).toEqual(["file:///a.ts"]);
    expect(written).toEqual({ "file:///b.ts": "bar" });
  });

  it("reports a file that fails to write and still applies the others", async () => {
    const { targets, written } = fakeTargets({
      "file:///readonly.ts": "foo",
      "file:///ok.ts": "foo",
    });
    const result = await applyWorkspaceEdit(
      {
        changes: {
          "file:///readonly.ts": [edit(0, 0, 0, 3, "bar")],
          "file:///ok.ts": [edit(0, 0, 0, 3, "bar")],
        },
      },
      targets,
    );
    expect(result.failed).toEqual([{ uri: "file:///readonly.ts", reason: "permission denied" }]);
    expect(written).toEqual({ "file:///ok.ts": "bar" });
  });

  it("reports a file it cannot read rather than skipping it", async () => {
    const { targets } = fakeTargets({});
    const result = await applyWorkspaceEdit(
      { changes: { "file:///gone.ts": [edit(0, 0, 0, 1, "x")] } },
      targets,
    );
    expect(result.applied).toEqual([]);
    expect(result.failed).toEqual([{ uri: "file:///gone.ts", reason: "unreadable" }]);
  });
});
