import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { expandSelection, shrinkSelection, syntaxSelectionExtension } from "./syntaxSelection";

interface FakeView {
  state: EditorState;
  dispatch: (spec: unknown) => void;
}

function makeView(doc: string, language: Extension, cursors: number[]): FakeView {
  const selection = EditorSelection.create(cursors.map(pos => EditorSelection.cursor(pos)));
  const state = EditorState.create({
    doc,
    selection,
    extensions: [language, syntaxSelectionExtension, EditorState.allowMultipleSelections.of(true)],
  });
  const view: FakeView = {
    state,
    dispatch: spec => {
      view.state = view.state.update(spec as never).state;
    },
  };
  return view;
}

function asView(view: FakeView): EditorView {
  return view as unknown as EditorView;
}

function rangesOf(view: FakeView): Array<[number, number]> {
  return view.state.selection.ranges.map(range => [range.from, range.to]);
}

const SNIPPET = "const total = add(left, mul(2, 3));";

describe("syntax selection", () => {
  it("expands outward and shrinks back through the same ranges", () => {
    const view = makeView(SNIPPET, javascript(), [SNIPPET.indexOf("2")]);
    const start = rangesOf(view);

    expect(expandSelection(asView(view))).toBe(true);
    const first = rangesOf(view);
    expect(expandSelection(asView(view))).toBe(true);
    const second = rangesOf(view);

    const [firstFrom, firstTo] = first[0];
    const [secondFrom, secondTo] = second[0];
    expect(firstTo - firstFrom).toBeGreaterThan(0);
    expect(secondFrom).toBeLessThanOrEqual(firstFrom);
    expect(secondTo).toBeGreaterThanOrEqual(firstTo);
    expect(secondTo - secondFrom).toBeGreaterThan(firstTo - firstFrom);

    expect(shrinkSelection(asView(view))).toBe(true);
    expect(rangesOf(view)).toEqual(first);
    expect(shrinkSelection(asView(view))).toBe(true);
    expect(rangesOf(view)).toEqual(start);
  });

  it("shrink with an empty stack is a no-op that returns false", () => {
    const view = makeView(SNIPPET, javascript(), [5]);
    const before = rangesOf(view);

    expect(shrinkSelection(asView(view))).toBe(false);
    expect(rangesOf(view)).toEqual(before);
  });

  it("clears the stack when the selection moves by hand", () => {
    const view = makeView(SNIPPET, javascript(), [SNIPPET.indexOf("left")]);
    expandSelection(asView(view));
    expandSelection(asView(view));

    view.dispatch({ selection: EditorSelection.single(3) });
    const afterMove = rangesOf(view);

    expect(shrinkSelection(asView(view))).toBe(false);
    expect(rangesOf(view)).toEqual(afterMove);
  });

  it("clears the stack when the document changes", () => {
    const view = makeView(SNIPPET, javascript(), [SNIPPET.indexOf("left")]);
    expandSelection(asView(view));

    view.dispatch({ changes: { from: 0, insert: "x" } });

    expect(shrinkSelection(asView(view))).toBe(false);
  });

  it("expands and shrinks multiple cursors independently", () => {
    const doc = "foo(a, b);\nbar(c, d);";
    const firstPos = doc.indexOf("a");
    const secondPos = doc.indexOf("d");
    const view = makeView(doc, javascript(), [firstPos, secondPos]);

    expandSelection(asView(view));
    const afterOne = rangesOf(view);
    expect(afterOne).toEqual([
      [firstPos, firstPos + 1],
      [secondPos, secondPos + 1],
    ]);

    expandSelection(asView(view));
    const [firstGrown, secondGrown] = rangesOf(view);
    expect(firstGrown[0]).toBeLessThan(firstPos);
    expect(secondGrown[0]).toBeGreaterThan(firstGrown[1]);
    expect(secondGrown[0]).toBeLessThan(secondPos);

    shrinkSelection(asView(view));
    expect(rangesOf(view)).toEqual(afterOne);
  });

  it("returns false when the whole document is already selected", () => {
    const view = makeView("x", javascript(), [0]);
    view.dispatch({ selection: EditorSelection.single(0, 1) });

    expect(expandSelection(asView(view))).toBe(false);
  });

  const LANGUAGE_CASES: Array<[string, () => Extension, string, string]> = [
    ["cpp", () => cpp(), "int main() { return add(1, mul(2, 3)); }", "2"],
    ["css", () => css(), "a { margin: calc(1px + 2px); }", "2px"],
    ["go", () => go(), "package main\nfunc main() { x := add(1, mul(2, 3)) }", "2"],
    ["html", () => html(), "<div><p class=\"a\">hello</p></div>", "hello"],
    ["java", () => java(), "class A { int f() { return add(1, mul(2, 3)); } }", "2"],
    ["javascript", () => javascript(), "const x = add(1, mul(2, 3));", "2"],
    ["json", () => json(), "{\"a\": {\"b\": [1, 2, 3]}}", "2"],
    ["markdown", () => markdown(), "# Title\n\nSome *nested emphasis* here.\n", "nested"],
    ["python", () => python(), "def f():\n    return add(1, mul(2, 3))\n", "2"],
    ["rust", () => rust(), "fn main() { let x = add(1, mul(2, 3)); }", "2"],
    ["sql", () => sql(), "SELECT a FROM t WHERE (b = 1 AND (c = 2));", "2"],
    ["xml", () => xml(), "<root><item id=\"1\">text</item></root>", "text"],
    ["yaml", () => yaml(), "root:\n  child:\n    leaf: value\n", "value"],
  ];

  it.each(LANGUAGE_CASES)("grows from inside a nested expression in %s", (_name, language, doc, needle) => {
    const cursor = doc.indexOf(needle) + 1;
    const view = makeView(doc, language(), [cursor]);
    const before = view.state.selection.main;

    const grew = expandSelection(asView(view));
    const after = view.state.selection.main;

    expect(grew).toBe(true);
    expect(after.to - after.from).toBeGreaterThan(before.to - before.from);
    expect(after.from).toBeLessThanOrEqual(before.from);
    expect(after.to).toBeGreaterThanOrEqual(before.to);
  });
});
