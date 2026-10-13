// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import type { LineChanges } from "@/lib/types";

const lineChangesMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ taskGitLineChanges: lineChangesMock }));

import {
  gitChangeGutterExtension, gitGutterMarkers, markersFromChanges, refreshGitGutter, GIT_GUTTER_DEBOUNCE_MS,
} from "./gitChangeGutterExt";

const DOC = "one\ntwo\nthree\nfour\nfive\n";

const NO_CHANGES: LineChanges = { added: [], modified: [], deleted: [], truncated: false };

let views: EditorView[] = [];

function mount(doc = DOC) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc,
    extensions: [gitChangeGutterExtension("task-gutter", "src/thing.ts")],
  });
  views.push(view);
  return view;
}

function markerList(view: EditorView) {
  const found: { from: number; cls: string }[] = [];
  const cursor = gitGutterMarkers(view.state).iter();
  while (cursor.value) {
    found.push({ from: cursor.from, cls: cursor.value.elementClass });
    cursor.next();
  }
  return found;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  lineChangesMock.mockReset();
});

afterEach(() => {
  views.forEach(view => view.destroy());
  views = [];
  vi.useRealTimers();
});

describe("markersFromChanges", () => {
  it("places one marker per changed line with the matching class", () => {
    const doc = Text.of(DOC.split("\n"));
    const changes: LineChanges = { added: [[1, 2]], modified: [[4, 4]], deleted: [3], truncated: false };

    const set = markersFromChanges(doc, changes);
    const found: { from: number; cls: string }[] = [];
    for (const cursor = set.iter(); cursor.value; cursor.next()) {
      found.push({ from: cursor.from, cls: cursor.value.elementClass });
    }

    expect(found).toEqual([
      { from: 0, cls: "cm-git-gutter-added" },
      { from: 4, cls: "cm-git-gutter-added" },
      { from: 8, cls: "cm-git-gutter-deleted" },
      { from: 14, cls: "cm-git-gutter-modified" },
    ]);
  });

  it("clamps a deletion past the end and skips ranges beyond the buffer", () => {
    const doc = Text.of(["a", "b"]);
    const changes: LineChanges = { added: [[5, 6]], modified: [], deleted: [9], truncated: false };

    const set = markersFromChanges(doc, changes);

    expect(set.size).toBe(1);
    expect(set.iter().from).toBe(2);
  });

  it("draws nothing for an empty result", () => {
    expect(markersFromChanges(Text.of(["a"]), NO_CHANGES).size).toBe(0);
  });
});

describe("request scheduling", () => {
  it("requests on mount with the live buffer", async () => {
    lineChangesMock.mockResolvedValue(NO_CHANGES);
    mount();

    await vi.advanceTimersByTimeAsync(0);

    expect(lineChangesMock).toHaveBeenCalledTimes(1);
    expect(lineChangesMock).toHaveBeenCalledWith("task-gutter", "src/thing.ts", DOC);
  });

  it("waits 300ms after the last edit before asking again", async () => {
    lineChangesMock.mockResolvedValue(NO_CHANGES);
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    lineChangesMock.mockClear();

    view.dispatch({ changes: { from: 0, insert: "a" } });
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS - 100);
    view.dispatch({ changes: { from: 0, insert: "b" } });
    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS - 1);
    expect(lineChangesMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(lineChangesMock).toHaveBeenCalledTimes(1);
  });

  it("requests immediately when asked to refresh", async () => {
    lineChangesMock.mockResolvedValue(NO_CHANGES);
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    lineChangesMock.mockClear();

    view.dispatch({ effects: refreshGitGutter.of() });
    await vi.advanceTimersByTimeAsync(0);

    expect(lineChangesMock).toHaveBeenCalledTimes(1);
  });

  it("applies a result for the document that was sent", async () => {
    lineChangesMock.mockResolvedValue({ added: [[2, 2]], modified: [], deleted: [], truncated: false });
    const view = mount();

    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(markerList(view)).toEqual([{ from: 4, cls: "cm-git-gutter-added" }]);
  });
});

describe("stale and superseded results", () => {
  it("drops a result when the buffer changed while it was in flight, then asks again", async () => {
    const first = deferred<LineChanges>();
    lineChangesMock.mockReturnValueOnce(first.promise);
    lineChangesMock.mockResolvedValue(NO_CHANGES);
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);

    view.dispatch({ changes: { from: 0, insert: "x" } });
    first.resolve({ added: [[1, 1]], modified: [], deleted: [], truncated: false });
    await flush();

    expect(markerList(view)).toEqual([]);

    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS);
    expect(lineChangesMock).toHaveBeenCalledTimes(2);
    expect(lineChangesMock).toHaveBeenLastCalledWith("task-gutter", "src/thing.ts", "x" + DOC);
  });

  it("ignores an older request that resolves after a newer one was sent", async () => {
    const older = deferred<LineChanges>();
    const newer = deferred<LineChanges>();
    lineChangesMock.mockReturnValueOnce(older.promise);
    lineChangesMock.mockReturnValueOnce(newer.promise);
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);

    view.dispatch({ effects: refreshGitGutter.of() });
    await vi.advanceTimersByTimeAsync(0);
    expect(lineChangesMock).toHaveBeenCalledTimes(2);

    newer.resolve({ added: [[3, 3]], modified: [], deleted: [], truncated: false });
    await flush();
    older.resolve({ added: [[1, 1]], modified: [], deleted: [], truncated: false });
    await flush();

    expect(markerList(view)).toEqual([{ from: 8, cls: "cm-git-gutter-added" }]);
  });

  it("keeps markers attached to their lines while the buffer is edited", async () => {
    lineChangesMock.mockResolvedValue({ added: [[3, 3]], modified: [], deleted: [], truncated: false });
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    view.dispatch({ changes: { from: 0, insert: "zero\n" } });

    expect(markerList(view)).toEqual([{ from: 13, cls: "cm-git-gutter-added" }]);
  });

  it("does not request after the view is destroyed", async () => {
    lineChangesMock.mockResolvedValue(NO_CHANGES);
    const view = mount();
    view.destroy();

    await vi.advanceTimersByTimeAsync(GIT_GUTTER_DEBOUNCE_MS * 2);

    expect(lineChangesMock).not.toHaveBeenCalled();
  });
});
