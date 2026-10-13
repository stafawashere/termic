// @vitest-environment happy-dom

import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { showMinimap } from "@replit/codemirror-minimap";
import { indentGuidesExtension } from "./editorLookExt";
import { MINIMAP_DISPLAY_TEXT, minimapConfig, minimapExtension } from "./editorMinimapExt";

const LONG_DOC = Array.from({ length: 500 }, (_, index) => "  ".repeat(index % 4) + `line ${index}`).join("\n");

let views: EditorView[] = [];

function mount(extensions: import("@codemirror/state").Extension[]) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, doc: LONG_DOC, extensions });
  views.push(view);
  return view;
}

afterEach(() => {
  views.forEach(view => view.destroy());
  views = [];
  document.body.innerHTML = "";
});

describe("minimap config", () => {
  it("uses a bare container and the block renderer, which draws to a canvas", () => {
    const config = minimapConfig();
    expect(config.displayText).toBe(MINIMAP_DISPLAY_TEXT);
    expect(MINIMAP_DISPLAY_TEXT).toBe("blocks");

    const container = config.create({} as EditorView);
    expect(container.dom.tagName).toBe("DIV");
    expect(container.dom.childElementCount).toBe(0);
  });

  it("is supplied through the showMinimap facet", () => {
    const view = mount([minimapExtension()]);
    const configured = view.state.facet(showMinimap);
    expect(configured).not.toBeNull();
    expect(configured?.displayText).toBe("blocks");
  });
});

describe("enabling the look extensions", () => {
  it("leaves the editor DOM line count unchanged when the minimap turns on", () => {
    const compartment = new Compartment();
    const view = mount([compartment.of([])]);
    const linesBefore = view.dom.querySelectorAll(".cm-line").length;

    view.dispatch({ effects: compartment.reconfigure(minimapExtension()) });
    const linesAfter = view.dom.querySelectorAll(".cm-line").length;

    expect(linesAfter).toBe(linesBefore);
    expect(linesAfter).toBeLessThan(500);
  });

  it("renders the minimap as one canvas with no per-line nodes", () => {
    const view = mount([minimapExtension()]);
    const minimapRoot = view.dom.querySelector(".cm-minimap-gutter");
    expect(minimapRoot).not.toBeNull();

    const canvases = minimapRoot!.querySelectorAll("canvas");
    expect(canvases.length).toBe(1);
    expect(minimapRoot!.querySelectorAll(".cm-line").length).toBe(0);
  });

  it("mounts the indent guide extension and keeps the line count", () => {
    const plain = mount([]);
    const guided = mount([indentGuidesExtension()]);
    const plainLines = plain.dom.querySelectorAll(".cm-line").length;
    const guidedLines = guided.dom.querySelectorAll(".cm-line").length;
    expect(guidedLines).toBe(plainLines);
  });
});
