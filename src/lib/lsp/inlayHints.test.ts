import { describe, it, expect, vi } from "vitest";
import { Text } from "@codemirror/state";

vi.mock("@codemirror/lsp-client", () => ({ LSPPlugin: { get: () => null } }));

import {
  paddedRange,
  hintText,
  isStale,
  requestInlayHints,
  VIEWPORT_PADDING_LINES,
  type InlayHintClient,
} from "./inlayHints";

const manyLines = (count: number) => Text.of(Array.from({ length: count }, (_, index) => `line ${index + 1}`));

function fakeClient(capabilities: InlayHintClient["serverCapabilities"], reply: unknown = []) {
  const request = vi.fn(async () => reply);
  const client = { serverCapabilities: capabilities, request, sync: vi.fn() } as unknown as InlayHintClient;
  return { client, request };
}

describe("paddedRange", () => {
  it("pads the visible lines by the viewport padding on both sides", () => {
    const doc = manyLines(200);
    const from = doc.line(100).from;
    const to = doc.line(120).to;

    const range = paddedRange(doc, from, to);

    expect(range.start).toEqual({ line: 99 - VIEWPORT_PADDING_LINES, character: 0 });
    expect(range.end).toEqual({ line: 119 + VIEWPORT_PADDING_LINES, character: "line 140".length });
  });

  it("clamps to the document at both ends", () => {
    const doc = manyLines(30);

    const range = paddedRange(doc, doc.line(2).from, doc.line(28).to);

    expect(range.start.line).toBe(0);
    expect(range.end).toEqual({ line: 29, character: "line 30".length });
  });
});

describe("hintText", () => {
  it("returns a string label untouched", () => {
    expect(hintText(": number")).toBe(": number");
  });

  it("joins label parts in order", () => {
    expect(hintText([{ value: ": " }, { value: "Map<" }, { value: "string>" }])).toBe(": Map<string>");
  });

  it("keeps markup characters as plain text", () => {
    expect(hintText([{ value: "<b>x</b>" }])).toBe("<b>x</b>");
  });
});

describe("isStale", () => {
  const doc = manyLines(100);
  const asked = { doc, range: { start: { line: 10, character: 0 }, end: { line: 70, character: 0 } } };

  it("accepts the same document and a range inside the asked one", () => {
    const current = { doc, range: { start: { line: 20, character: 0 }, end: { line: 50, character: 0 } } };

    expect(isStale(asked, current)).toBe(false);
  });

  it("drops a response when the document changed", () => {
    const edited = doc.replace(0, 1, Text.of(["x"]));

    expect(isStale(asked, { doc: edited, range: asked.range })).toBe(true);
  });

  it("drops a response when the viewport scrolled outside the asked range", () => {
    const scrolled = { doc, range: { start: { line: 40, character: 0 }, end: { line: 90, character: 0 } } };

    expect(isStale(asked, scrolled)).toBe(true);
  });
});

describe("requestInlayHints", () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } };

  it("sends no request when the server has no inlayHintProvider", async () => {
    const { client, request } = fakeClient({});

    const result = await requestInlayHints(client, "file:///a.ts", range);

    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("asks textDocument/inlayHint for the range when the capability exists", async () => {
    const { client, request } = fakeClient({ inlayHintProvider: true }, [{ position: { line: 1, character: 2 }, label: "x" }]);

    const result = await requestInlayHints(client, "file:///a.ts", range);

    expect(request).toHaveBeenCalledWith("textDocument/inlayHint", { textDocument: { uri: "file:///a.ts" }, range });
    expect(result).toHaveLength(1);
  });

  it("treats a null reply as no hints", async () => {
    const { client } = fakeClient({ inlayHintProvider: { resolveProvider: false } }, null);

    expect(await requestInlayHints(client, "file:///a.ts", range)).toEqual([]);
  });
});
