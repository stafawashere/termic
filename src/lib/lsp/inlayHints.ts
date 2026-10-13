// Inlay hints: the inferred types and parameter names a server offers, drawn
// inline (GH #174).
//
// `@codemirror/lsp-client` has no support for these, so this asks
// `textDocument/inlayHint` itself. Two rules keep it from costing the editor
// anything:
//
//  - **Only the viewport is asked about**, padded by a screenful, never the
//    whole file. A 5,000 line file has thousands of hints and the reader sees
//    forty lines of them.
//  - **Nothing is asked until typing and scrolling stop.** A request per
//    keystroke is a request per keystroke the server has to answer about a
//    document that is already out of date.
//  - **Nothing is asked while the editor is hidden**; it asks once when the
//    editor is shown again.

import { ViewPlugin, Decoration, WidgetType, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { LSPPlugin } from "@codemirror/lsp-client";
import type { LspRange } from "./applyWorkspaceEdit";
import { observeElementVisibility } from "@/lib/editor/viewVisibility";
import type { ObserveVisibility } from "@/lib/editor/viewVisibility";

export const DEBOUNCE_MS = 250;
export const VIEWPORT_PADDING_LINES = 20;

const KIND_TYPE = 1;
const KIND_PARAMETER = 2;

interface LspLabelPart {
  value: string;
}

export interface LspInlayHint {
  position: { line: number; character: number };
  label: string | LspLabelPart[];
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

/** The slice of the client this module touches, so a test can stand in. */
export interface InlayHintClient {
  serverCapabilities?: { inlayHintProvider?: unknown } | null;
  request<Params, Result>(method: string, params: Params): Promise<Result>;
  sync(): void;
}

/** The viewport as the server wants it: first visible line minus the padding to
 *  the end of the last visible line plus the padding, clamped to the document. */
export function paddedRange(doc: Text, visibleFrom: number, visibleTo: number): LspRange {
  const firstLine = doc.lineAt(visibleFrom).number;
  const lastLine = doc.lineAt(visibleTo).number;

  const startLine = Math.max(1, firstLine - VIEWPORT_PADDING_LINES);
  const endLine = Math.min(doc.lines, lastLine + VIEWPORT_PADDING_LINES);
  const end = doc.line(endLine);

  return {
    start: { line: startLine - 1, character: 0 },
    end: { line: endLine - 1, character: end.length },
  };
}

export function hintText(label: string | LspLabelPart[]): string {
  if (typeof label === "string") return label;
  return label.map(part => part.value).join("");
}

export function hasInlayHintSupport(client: InlayHintClient): boolean {
  return !!client.serverCapabilities?.inlayHintProvider;
}

/** A response is only good for the document and range it was asked about. */
export function isStale(
  asked: { doc: Text; range: LspRange },
  current: { doc: Text; range: LspRange },
): boolean {
  const docChanged = asked.doc !== current.doc;
  const startsBefore = current.range.start.line < asked.range.start.line;
  const endsAfter = current.range.end.line > asked.range.end.line;

  return docChanged || startsBefore || endsAfter;
}

/** Null when the server never advertised the provider: asking anyway is an
 *  error reply per pause. */
export async function requestInlayHints(
  client: InlayHintClient,
  uri: string,
  range: LspRange,
): Promise<LspInlayHint[] | null> {
  if (!hasInlayHintSupport(client)) return null;

  client.sync();
  const hints = await client.request<unknown, LspInlayHint[] | null>(
    "textDocument/inlayHint",
    { textDocument: { uri }, range },
  );

  return hints ?? [];
}

class HintWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: number | undefined,
    readonly paddingLeft: boolean,
    readonly paddingRight: boolean,
  ) {
    super();
  }

  eq(other: HintWidget) {
    const sameText = this.text === other.text;
    const sameKind = this.kind === other.kind;
    const samePadding = this.paddingLeft === other.paddingLeft && this.paddingRight === other.paddingRight;

    return sameText && sameKind && samePadding;
  }

  toDOM() {
    const dom = document.createElement("span");
    const kindClass = this.kind === KIND_PARAMETER
      ? "cm-lsp-inlay-parameter"
      : this.kind === KIND_TYPE ? "cm-lsp-inlay-type" : "";

    dom.className = `cm-lsp-inlay ${kindClass}`.trim();
    if (this.paddingLeft) dom.classList.add("cm-lsp-inlay-pad-left");
    if (this.paddingRight) dom.classList.add("cm-lsp-inlay-pad-right");
    dom.textContent = this.text;
    dom.setAttribute("aria-hidden", "true");
    return dom;
  }

  ignoreEvent() {
    return true;
  }
}

export function buildDecorations(doc: Text, hints: LspInlayHint[], range: LspRange): DecorationSet {
  const widgets = [];

  for (const hint of hints) {
    const text = hintText(hint.label);
    if (!text) continue;

    const isBeforeRange = hint.position.line < range.start.line;
    const isAfterRange = hint.position.line > range.end.line;
    if (isBeforeRange || isAfterRange) continue;

    const line = doc.line(Math.max(1, Math.min(hint.position.line + 1, doc.lines)));
    const pos = Math.min(line.from + hint.position.character, line.to);
    const widget = new HintWidget(text, hint.kind, !!hint.paddingLeft, !!hint.paddingRight);

    widgets.push(Decoration.widget({ widget, side: 1 }).range(pos));
  }

  return Decoration.set(widgets, true);
}

function visibleSpan(view: EditorView) {
  const ranges = view.visibleRanges;
  if (ranges.length === 0) return null;

  return { from: ranges[0].from, to: ranges[ranges.length - 1].to };
}

export function createInlayHints(observeVisibility: ObserveVisibility = observeElementVisibility) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    timer: number | null = null;
    disposed = false;
    generation = 0;
    isVisible = false;
    isStale = true;
    stopObserving: () => void;

    constructor(readonly view: EditorView) {
      this.stopObserving = observeVisibility(view.dom, isVisible => this.setVisible(isVisible));
    }

    setVisible(isVisible: boolean) {
      this.isVisible = isVisible;

      if (isVisible && this.isStale) this.schedule();
      if (!isVisible && this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = this.decorations.map(update.changes);

      const shouldRefresh = update.docChanged || update.viewportChanged;
      if (shouldRefresh) {
        this.isStale = true;
        if (this.isVisible) this.schedule();
      }
    }

    destroy() {
      this.disposed = true;
      this.stopObserving();
      if (this.timer !== null) window.clearTimeout(this.timer);
    }

    schedule() {
      if (this.timer !== null) window.clearTimeout(this.timer);
      // A timer, not requestAnimationFrame: rAF is frozen while the window is
      // occluded (docs/gotchas.md).
      this.timer = window.setTimeout(() => { void this.run(); }, DEBOUNCE_MS);
    }

    async run() {
      const plugin = LSPPlugin.get(this.view);
      if (!plugin) return;

      this.isStale = false;

      const client = plugin.client;
      try {
        await client.initializing;
      } catch {
        return;
      }
      if (this.disposed) return;

      const span = visibleSpan(this.view);
      if (!span) return;

      const doc = this.view.state.doc;
      const range = paddedRange(doc, span.from, span.to);
      const generation = ++this.generation;

      let hints: LspInlayHint[] | null = null;
      try {
        hints = await requestInlayHints(client, plugin.uri, range);
      } catch {
        // -32801 ContentModified: the next debounce covers it.
        return;
      }
      if (this.disposed || !hints) return;

      const isSuperseded = generation !== this.generation;
      const currentSpan = visibleSpan(this.view);
      if (isSuperseded || !currentSpan) return;

      const currentDoc = this.view.state.doc;
      const visibleNow = {
        start: { line: currentDoc.lineAt(currentSpan.from).number - 1, character: 0 },
        end: { line: currentDoc.lineAt(currentSpan.to).number - 1, character: 0 },
      };
      if (isStale({ doc, range }, { doc: currentDoc, range: visibleNow })) return;

      this.decorations = buildDecorations(currentDoc, hints, range);
      this.view.dispatch({});
    }
  }, {
    decorations: plugin => plugin.decorations,
  });
}

export const inlayHints = createInlayHints();

export const inlayHintsTheme = EditorView.baseTheme({
  ".cm-lsp-inlay": {
    color: "var(--color-fg-faint)",
    fontSize: "0.85em",
    pointerEvents: "none",
    userSelect: "none",
  },
  ".cm-lsp-inlay-type": { fontStyle: "italic" },
  ".cm-lsp-inlay-parameter": { opacity: "0.85" },
  ".cm-lsp-inlay-pad-left": { marginLeft: "0.35em" },
  ".cm-lsp-inlay-pad-right": { marginRight: "0.35em" },
});

export const inlayHintsExtension = [inlayHints, inlayHintsTheme];
