import { describe, it, expect } from "vitest";
import type { TranscriptEntry } from "@/lib/types";
import {
  appendBatch, formatToolInput, positionOfEntry, prependPage, rowOffsets, rowsForView, shouldFollowTail,
  stripAnsi, toTranscriptRow, toTranscriptRows, truncateLines, visibleRange, type TranscriptWindow,
} from "@/lib/subagentTranscript";

function entry(kind: TranscriptEntry["kind"], text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { kind, text, truncated: false, name: null, isError: false, timestamp: null, ...extra };
}

function texts(window: TranscriptWindow): string[] {
  return window.rows.map(row => `${row.index}:${row.text}`);
}

describe("toTranscriptRow", () => {
  it("keeps each known kind and the tool name on a tool call", () => {
    const rows = toTranscriptRows([
      entry("userText", "look around"),
      entry("assistantText", "on it"),
      entry("thinking", "hmm"),
      entry("toolUse", "{\"path\":\"/Users/u/dev/acme/README.md\"}", { name: "Read" }),
      entry("toolResult", "boom", { isError: true }),
      entry("error", "API Error"),
    ], 10);

    expect(rows.map(row => row.kind)).toEqual(["userText", "assistantText", "thinking", "toolUse", "toolResult", "error"]);
    expect(rows.map(row => row.index)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(rows[3].toolName).toBe("Read");
    expect(rows[0].toolName).toBeNull();
    expect(rows[4].isError).toBe(true);
  });

  it("strips ANSI escapes from text and tool names", () => {
    const row = toTranscriptRow(entry("toolUse", "\u001b[31mred\u001b[0m", { name: "\u001b[1mBash\u001b[0m" }), 0);
    expect(row.text).toBe("red");
    expect(row.toolName).toBe("Bash");
  });

  it("drops whatever a redacted thinking block carries, so the view shows only its placeholder", () => {
    const row = toTranscriptRow(entry("redactedThinking", "opaque-bytes"), 0);
    expect(row.kind).toBe("redactedThinking");
    expect(row.text).toBe("");
  });

  it("maps a compact boundary to its own row rather than dropping it", () => {
    const rows = toTranscriptRows([entry("assistantText", "before"), entry("compactBoundary", ""), entry("assistantText", "after")], 0);
    expect(rows.map(row => row.kind)).toEqual(["assistantText", "compactBoundary", "assistantText"]);
  });

  it("turns an unknown or malformed entry into an unknown row instead of throwing", () => {
    const odd = toTranscriptRow({ kind: "attachment", text: "a.png" }, 3);
    expect(odd).toMatchObject({ index: 3, kind: "unknown", sourceKind: "attachment", text: "a.png" });

    for (const malformed of [null, 42, "text", { kind: 7, text: { nested: true } }]) {
      const row = toTranscriptRow(malformed, 0);
      expect(row.kind).toBe("unknown");
      expect(row.text).toBe("");
    }
  });
});

describe("stripAnsi", () => {
  it("removes CSI, OSC hyperlinks and stray escapes and keeps the text", () => {
    const raw = "\u001b[1;32mok\u001b[0m \u001b]8;;https://acme.com\u0007link\u001b]8;;\u001b\\ end\u001b";
    expect(stripAnsi(raw)).toBe("ok link end");
  });
});

describe("formatToolInput", () => {
  it("joins the values of a flat object the way the TUI prints a call", () => {
    expect(formatToolInput("{\"command\":\"ls -la\",\"timeout\":5}")).toBe("ls -la, 5");
  });

  it("falls back to the raw text for nested input or text that is not JSON", () => {
    expect(formatToolInput("{\"edits\":[{\"a\":1}]}")).toBe("{\"edits\":[{\"a\":1}]}");
    expect(formatToolInput("not json")).toBe("not json");
  });

  it("clips a long input to one line", () => {
    const formatted = formatToolInput(JSON.stringify({ text: "x".repeat(1000) }));
    expect(formatted.endsWith("...")).toBe(true);
    expect(formatted.length).toBeLessThan(300);
  });
});

describe("shouldFollowTail", () => {
  it("follows at the bottom", () => {
    expect(shouldFollowTail(600, 1000, 400)).toBe(true);
  });

  it("follows within the threshold of the bottom", () => {
    expect(shouldFollowTail(580, 1000, 400)).toBe(true);
    expect(shouldFollowTail(570, 1000, 400, 30)).toBe(true);
  });

  it("stops following once scrolled up past the threshold", () => {
    expect(shouldFollowTail(560, 1000, 400)).toBe(false);
    expect(shouldFollowTail(0, 1000, 400)).toBe(false);
  });

  it("follows when everything fits on screen", () => {
    expect(shouldFollowTail(0, 300, 400)).toBe(true);
  });
});

describe("appendBatch", () => {
  const page: TranscriptWindow = { start: 5, rows: toTranscriptRows([entry("assistantText", "a"), entry("assistantText", "b")], 5) };

  it("adds only the part of a batch the window does not already hold", () => {
    const merged = appendBatch(page, 6, [entry("assistantText", "b"), entry("assistantText", "c")]);
    expect(merged.kind).toBe("appended");
    if (merged.kind !== "appended") return;
    expect(texts(merged.window)).toEqual(["5:a", "6:b", "7:c"]);
  });

  it("reports a batch it already holds as unchanged", () => {
    expect(appendBatch(page, 5, [entry("assistantText", "a")]).kind).toBe("unchanged");
  });

  it("reports a gap when the batch starts past the window's end", () => {
    expect(appendBatch(page, 9, [entry("assistantText", "z")]).kind).toBe("gap");
  });
});

describe("prependPage", () => {
  const current: TranscriptWindow = { start: 2, rows: toTranscriptRows([entry("assistantText", "c")], 2) };

  it("puts a page that ends at the window's start in front of it", () => {
    const widened = prependPage(current, 0, [entry("assistantText", "a"), entry("assistantText", "b")]);
    expect(texts(widened)).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("ignores a page that does not meet the window", () => {
    expect(prependPage(current, 0, [entry("assistantText", "a")])).toBe(current);
  });
});

describe("visibleRange", () => {
  const offsets = rowOffsets(500, () => 20);

  it("mounts only the rows around the viewport", () => {
    const range = visibleRange(offsets, 2000, 400, 100);
    expect(range.first).toBe(95);
    expect(range.end).toBe(125);
  });

  it("clamps at both ends of the list", () => {
    expect(visibleRange(offsets, 0, 400, 100)).toEqual({ first: 0, end: 25 });
    expect(visibleRange(offsets, 9600, 400, 100)).toEqual({ first: 475, end: 500 });
  });

  it("is empty for an empty list", () => {
    expect(visibleRange(rowOffsets(0, () => 20), 0, 400, 100)).toEqual({ first: 0, end: 0 });
  });
});

describe("rowsForView", () => {
  const rows = toTranscriptRows([
    entry("assistantText", "hi"),
    entry("thinking", "hmm"),
    entry("redactedThinking", ""),
    entry("toolUse", "{}", { name: "Read" }),
    entry("toolResult", "out"),
  ], 0);
  const kinds = (shown: readonly { kind: string }[]) => shown.map(row => row.kind);

  it("hands back the same list when nothing is hidden", () => {
    expect(rowsForView(rows, { showThinking: true, showToolOutputs: true })).toBe(rows);
  });

  it("hides thinking, redacted thinking included", () => {
    expect(kinds(rowsForView(rows, { showThinking: false, showToolOutputs: true })))
      .toEqual(["assistantText", "toolUse", "toolResult"]);
  });

  it("hides tool output and keeps the call", () => {
    expect(kinds(rowsForView(rows, { showThinking: true, showToolOutputs: false })))
      .toEqual(["assistantText", "thinking", "redactedThinking", "toolUse"]);
  });

  it("keeps each row's place in the whole transcript", () => {
    const shown = rowsForView(rows, { showThinking: false, showToolOutputs: false });

    expect(shown.map(row => row.index)).toEqual([0, 3]);
    expect(positionOfEntry(shown, 3)).toBe(1);
    expect(positionOfEntry(shown, 1)).toBe(-1);
  });
});

describe("truncateLines", () => {
  it("cuts past the line limit and counts what it cut", () => {
    expect(truncateLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", cutLines: 2 });
  });

  it("leaves text at or under the limit alone", () => {
    expect(truncateLines("a\nb", 2)).toEqual({ text: "a\nb", cutLines: 0 });
  });

  it("never cuts with a limit of 0", () => {
    expect(truncateLines("a\nb\nc", 0)).toEqual({ text: "a\nb\nc", cutLines: 0 });
  });
});
