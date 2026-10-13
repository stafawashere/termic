import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, SelectionRange } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { Command } from "@codemirror/view";

const PARSE_BUDGET_MS = 50;

type RangeSnapshot = readonly SelectionRange[];

const pushSnapshot = StateEffect.define<RangeSnapshot>();
const popSnapshot = StateEffect.define<null>();

const snapshotStack = StateField.define<readonly RangeSnapshot[]>({
  create: () => [],
  update(stack, tr) {
    const pushed = tr.effects.find(effect => effect.is(pushSnapshot));
    const popped = tr.effects.find(effect => effect.is(popSnapshot));

    if (pushed) return [...stack, pushed.value as RangeSnapshot];
    if (popped) return stack.slice(0, -1);

    const selectionChanged = tr.selection !== undefined;
    const hasHistory = stack.length > 0;
    const shouldReset = (selectionChanged || tr.docChanged) && hasHistory;
    return shouldReset ? [] : stack;
  },
});

export const syntaxSelectionExtension: Extension = snapshotStack;

function enclosingRange(state: EditorState, range: SelectionRange): SelectionRange {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS);
  if (!tree) return range;

  const { from, to } = range;
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, 1);

  while (node) {
    const coversRange = node.from <= from && node.to >= to;
    const isLarger = node.from < from || node.to > to;
    const isUsable = coversRange && isLarger;
    if (isUsable) return EditorSelection.range(node.from, node.to);

    node = node.parent;
  }

  return range;
}

export const expandSelection: Command = view => {
  const { state } = view;
  const previous = state.selection.ranges;
  const grown = previous.map(range => enclosingRange(state, range));

  const changed = grown.some((range, index) => !range.eq(previous[index]));
  if (!changed) return false;

  view.dispatch({
    selection: EditorSelection.create(grown, state.selection.mainIndex),
    effects: pushSnapshot.of(previous),
    scrollIntoView: true,
    userEvent: "select.syntax",
  });

  return true;
};

export const shrinkSelection: Command = view => {
  const { state } = view;
  const stack = state.field(snapshotStack, false);
  const hasHistory = stack !== undefined && stack.length > 0;
  if (!hasHistory) return false;

  const restored = stack[stack.length - 1];
  const mainIndex = Math.min(state.selection.mainIndex, restored.length - 1);

  view.dispatch({
    selection: EditorSelection.create([...restored], mainIndex),
    effects: popSnapshot.of(null),
    scrollIntoView: true,
    userEvent: "select.syntax",
  });

  return true;
};
