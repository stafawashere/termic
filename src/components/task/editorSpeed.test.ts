// @vitest-environment happy-dom
//
// Editor speed invariants for the Zed-like features (docs/performance.md).
//
// Everything here is a count: requests sent, stringifies done, decorations
// drawn. None of it is a timing, so it holds on a 3-core CI runner
// (docs/perf-ci.md). The timers are fake and the outside calls are injected.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import type { LineChanges } from "@/lib/types";
import type { ObserveVisibility } from "@/lib/editor/viewVisibility";

const lspState = vi.hoisted(() => ({ plugin: null as unknown }));
vi.mock("@codemirror/lsp-client", () => ({ LSPPlugin: { get: () => lspState.plugin } }));
vi.mock("@/lib/ipc", () => ({ taskGitLineChanges: vi.fn() }));

import {
  gitChangeGutterExtension, refreshGitGutter, GIT_GUTTER_DEBOUNCE_MS,
} from "./gitChangeGutterExt";
import { createInlayHints, buildDecorations, DEBOUNCE_MS } from "@/lib/lsp/inlayHints";
import type { LspInlayHint } from "@/lib/lsp/inlayHints";

const NO_CHANGES: LineChanges = { added: [], modified: [], deleted: [], truncated: false };
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

function makeVisibility(startsVisible: boolean) {
  let notify: (isVisible: boolean) => void = () => {};
  const observe: ObserveVisibility = (_element, onChange) => {
    notify = onChange;
    onChange(startsVisible);
    return () => {};
  };

  return { observe, set: (isVisible: boolean) => notify(isVisible) };
}

let views: EditorView[] = [];

function mountView(extensions: import("@codemirror/state").Extension, doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, doc, extensions });
  views.push(view);

  return view;
}

function typeCharacters(view: EditorView, count: number) {
  for (let index = 0; index < count; index++) {
    view.dispatch({ changes: { from: view.state.doc.length, insert: "x" } });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  lspState.plugin = null;
});

afterEach(() => {
  views.forEach(view => view.destroy());
  views = [];
  vi.useRealTimers();
});

describe("git change gutter requests", () => {
  function mountGutter(startsVisible = true) {
    const fetchChanges = vi.fn().mockResolvedValue(NO_CHANGES);
    const visibility = makeVisibility(startsVisible);
    const view = mountView(
      gitChangeGutterExtension("task-speed", "src/a.ts", { fetchChanges, observeVisibility: visibility.observe }),
      "one\ntwo\n",
    );

    return { view, fetchChanges, visibility };
  }

  it("sends one request for a burst of edits inside the debounce window", async () => {
    const { view, fetchChanges } = mountGutter();
    await vi.advanceTimersByTimeAsync(0);
    fetchChanges.mockClear();

    typeCharacters(view, 50);
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS);

    expect(fetchChanges).toHaveBeenCalledTimes(1);
  });

  it("stringifies the document once per request and never on a keystroke", async () => {
    const { view, fetchChanges } = mountGutter();
    await vi.advanceTimersByTimeAsync(0);
    fetchChanges.mockClear();

    const stringify = vi.spyOn(Text.prototype, "toString");
    typeCharacters(view, 50);
    expect(stringify).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
    expect(stringify).toHaveBeenCalledTimes(1);
    stringify.mockRestore();
  });

  it("sends nothing while hidden, then one request when shown again", async () => {
    const { view, fetchChanges, visibility } = mountGutter(false);
    await vi.advanceTimersByTimeAsync(5000);
    typeCharacters(view, 20);
    view.dispatch({ effects: refreshGitGutter.of() });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchChanges).toHaveBeenCalledTimes(0);

    visibility.set(true);
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
  });

  it("does not ask again on show when nothing changed while hidden", async () => {
    const { fetchChanges, visibility } = mountGutter(true);
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS);
    expect(fetchChanges).toHaveBeenCalledTimes(1);

    visibility.set(false);
    visibility.set(true);
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS);
    expect(fetchChanges).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending request when the editor is hidden mid-debounce", async () => {
    const { view, fetchChanges, visibility } = mountGutter();
    await vi.advanceTimersByTimeAsync(0);
    fetchChanges.mockClear();

    typeCharacters(view, 5);
    visibility.set(false);
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS * 3);
    expect(fetchChanges).toHaveBeenCalledTimes(0);
  });

  it("sends exactly one request on mount", async () => {
    const { fetchChanges } = mountGutter();
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS * 3);

    expect(fetchChanges).toHaveBeenCalledTimes(1);
  });
});

describe("inlay hint requests", () => {
  function fakeServer(hints: LspInlayHint[] = []) {
    const request = vi.fn().mockResolvedValue(hints);
    lspState.plugin = {
      uri: "file:///a.ts",
      client: {
        initializing: Promise.resolve(),
        serverCapabilities: { inlayHintProvider: true },
        request,
        sync: vi.fn(),
      },
    };

    return request;
  }

  function mountInlay(startsVisible: boolean, doc = "a\nb\nc\n") {
    const visibility = makeVisibility(startsVisible);
    const plugin = createInlayHints(visibility.observe);
    const view = mountView(plugin, doc);

    return { view, plugin, visibility };
  }

  it("sends one request for a burst of edits inside the debounce window", async () => {
    const request = fakeServer();
    const { view } = mountInlay(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    request.mockClear();

    typeCharacters(view, 50);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends nothing while hidden, then one request when shown again", async () => {
    const request = fakeServer();
    const { view, visibility } = mountInlay(false);
    typeCharacters(view, 20);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 10);
    expect(request).toHaveBeenCalledTimes(0);

    visibility.set(true);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("draws decorations only for lines inside the requested range", () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const doc = Text.of(lines.split("\n"));
    const range = { start: { line: 10, character: 0 }, end: { line: 20, character: 0 } };
    const hintOnLine = (line: number): LspInlayHint => ({ position: { line, character: 0 }, label: ": T" });
    const hints = [5, 9, 10, 15, 20, 21, 150].map(hintOnLine);

    const decorations = buildDecorations(doc, hints, range);
    const drawnLines: number[] = [];
    const cursor = decorations.iter();
    while (cursor.value) {
      drawnLines.push(doc.lineAt(cursor.from).number - 1);
      cursor.next();
    }

    expect(drawnLines).toEqual([10, 15, 20]);
  });
});

describe("whole-document reads stay off the keystroke path", () => {
  const WHOLE_DOC_READ = /\.toString\(\)|sliceDoc\(/g;

  const allowed: Record<string, number> = {
    "gitChangeGutterExt.ts": 1,
    "MultibufferPane.tsx": 1,
    "../../lib/lsp/inlayHints.ts": 0,
    "../../lib/editor/syntaxSelection.ts": 0,
    "../../lib/editor/zedKeymap.ts": 0,
  };

  for (const [file, expectedCount] of Object.entries(allowed)) {
    it(`${file} has ${expectedCount} whole-document read(s)`, () => {
      const source = readFileSync(resolve(SOURCE_DIR, file), "utf8");
      const found = source.match(WHOLE_DOC_READ) ?? [];

      expect(found.length).toBe(expectedCount);
    });
  }
});
