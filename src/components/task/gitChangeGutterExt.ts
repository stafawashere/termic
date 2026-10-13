import { RangeSet, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { taskGitLineChanges } from "@/lib/ipc";
import type { LineChanges } from "@/lib/types";

export const GIT_GUTTER_DEBOUNCE_MS = 300;

export type ChangeKind = "added" | "modified" | "deleted";

class ChangeMarker extends GutterMarker {
  elementClass: string;

  constructor(readonly kind: ChangeKind) {
    super();
    this.elementClass = `cm-git-gutter-${kind}`;
  }

  eq(other: ChangeMarker) {
    return other.kind === this.kind;
  }
}

const MARKERS: Record<ChangeKind, ChangeMarker> = {
  added: new ChangeMarker("added"),
  modified: new ChangeMarker("modified"),
  deleted: new ChangeMarker("deleted"),
};

/** One marker per changed line. Ranges from the backend are 1-based and
 *  inclusive; lines past the end of the buffer (the buffer moved on, or a
 *  deletion at end of file) are clamped or skipped. */
export function markersFromChanges(doc: Text, changes: LineChanges): RangeSet<GutterMarker> {
  const lastLine = doc.lines;
  const placed: { from: number; kind: ChangeKind }[] = [];

  const addRange = (start: number, end: number, kind: ChangeKind) => {
    const first = Math.max(1, start);
    const last = Math.min(lastLine, end);
    for (let lineNumber = first; lineNumber <= last; lineNumber++) {
      placed.push({ from: doc.line(lineNumber).from, kind });
    }
  };

  changes.added.forEach(([start, end]) => addRange(start, end, "added"));
  changes.modified.forEach(([start, end]) => addRange(start, end, "modified"));
  changes.deleted.forEach(lineNumber => {
    const clamped = Math.min(lastLine, lineNumber);
    const isInDoc = clamped >= 1;
    if (isInDoc) placed.push({ from: doc.line(clamped).from, kind: "deleted" });
  });

  return RangeSet.of(
    placed.map(({ from, kind }) => MARKERS[kind].range(from)),
    true,
  );
}

const setChangeMarkers = StateEffect.define<RangeSet<GutterMarker>>();

/** Ask for a fresh diff now, without waiting for the debounce. Dispatched when
 *  the task's git state moved under an unchanged buffer. */
export const refreshGitGutter = StateEffect.define<void>();

const markerField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    let next = value;
    if (tr.docChanged) next = next.map(tr.changes);

    for (const effect of tr.effects) {
      if (effect.is(setChangeMarkers)) next = effect.value;
    }

    return next;
  },
});

export function gitGutterMarkers(state: EditorState): RangeSet<GutterMarker> {
  return state.field(markerField, false) ?? RangeSet.empty;
}

function requestPlugin(taskId: string, path: string) {
  return ViewPlugin.fromClass(class {
    private timer: number | null = null;
    private requestSeq = 0;
    private destroyed = false;

    constructor(private view: EditorView) {
      this.schedule(0);
    }

    update(update: ViewUpdate) {
      const refreshRequested = update.transactions.some(tr => tr.effects.some(e => e.is(refreshGitGutter)));

      if (refreshRequested) this.schedule(0);
      else if (update.docChanged) this.schedule(GIT_GUTTER_DEBOUNCE_MS);
    }

    destroy() {
      this.destroyed = true;
      this.requestSeq++;
      if (this.timer !== null) window.clearTimeout(this.timer);
    }

    private schedule(delay: number) {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.request();
      }, delay);
    }

    private request() {
      if (this.destroyed) return;

      const sentDoc = this.view.state.doc;
      const seq = ++this.requestSeq;

      taskGitLineChanges(taskId, path, sentDoc.toString())
        .then(changes => {
          const isSuperseded = seq !== this.requestSeq;
          if (this.destroyed || isSuperseded) return;

          const currentDoc = this.view.state.doc;
          const isSameDoc = currentDoc === sentDoc || currentDoc.eq(sentDoc);
          if (!isSameDoc) {
            this.schedule(GIT_GUTTER_DEBOUNCE_MS);
            return;
          }

          this.view.dispatch({ effects: setChangeMarkers.of(markersFromChanges(currentDoc, changes)) });
        })
        .catch(() => {});
    }
  });
}

export function gitChangeGutterExtension(taskId: string, path: string): Extension {
  return [
    markerField,
    gutter({
      class: "cm-git-gutter",
      markers: view => view.state.field(markerField),
    }),
    requestPlugin(taskId, path),
  ];
}
