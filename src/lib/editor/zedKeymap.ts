import { EditorSelection, Prec } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  deleteLine,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectLine,
  toggleComment,
} from "@codemirror/commands";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import type { Command, KeyBinding } from "@codemirror/view";
import type { EditorKeymap } from "@/store/prefs";
import { getActiveEditor } from "./activeEditor";
import { expandSelection, shrinkSelection, syntaxSelectionExtension } from "./syntaxSelection";

// Zed's default-macos.json editor bindings, the ones CodeMirror can serve.
//
// Left out because Termic already owns the key: cmd-[ and cmd-] (Zed's
// outdent and indent) are app-wide Back and Forward, and Tab and Shift-Tab
// already indent and dedent here.

const insertLineAbove: Command = view => {
  const { state } = view;
  const transaction = state.changeByRange(range => {
    const line = state.doc.lineAt(range.head);
    const leading = /^\s*/.exec(line.text)?.[0] ?? "";
    return {
      changes: { from: line.from, insert: `${leading}\n` },
      range: EditorSelection.cursor(line.from + leading.length),
    };
  });

  view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

const formatWhenArmed: Command = view => {
  const isArmed = getActiveEditor() === view;
  if (!isArmed) return false;

  void import("@/lib/lsp/editorExtension").then(module => {
    module.runEditorCommand(view, "format-document");
  });
  return true;
};

// Alt-Up and Alt-Down are CodeMirror's move-line keys. Under this preset they
// belong to syntax selection, so a refused expand or shrink must not fall
// through and shove the line around.
const alwaysHandled = (command: Command): Command => view => {
  command(view);
  return true;
};

export function zedKeymap(): KeyBinding[] {
  return [
    { key: "Mod-d", run: selectNextOccurrence, preventDefault: true, stopPropagation: true },
    { key: "Mod-Shift-l", run: selectSelectionMatches, preventDefault: true, stopPropagation: true },
    { key: "Mod-Alt-ArrowUp", run: addCursorAbove, preventDefault: true, stopPropagation: true },
    { key: "Mod-Alt-ArrowDown", run: addCursorBelow, preventDefault: true, stopPropagation: true },
    { key: "Alt-ArrowUp", run: alwaysHandled(expandSelection), preventDefault: true, stopPropagation: true },
    { key: "Alt-ArrowDown", run: alwaysHandled(shrinkSelection), preventDefault: true, stopPropagation: true },
    { key: "Ctrl-Mod-ArrowUp", run: moveLineUp, preventDefault: true },
    { key: "Ctrl-Mod-ArrowDown", run: moveLineDown, preventDefault: true },
    { key: "Mod-Shift-d", run: copyLineDown, preventDefault: true, stopPropagation: true },
    { key: "Ctrl-Shift-k", run: deleteLine, preventDefault: true },
    { key: "Mod-l", run: selectLine, preventDefault: true, stopPropagation: true },
    { key: "Mod-Enter", run: insertBlankLine, preventDefault: true },
    { key: "Mod-Shift-Enter", run: insertLineAbove, preventDefault: true },
    { key: "Mod-/", run: toggleComment, preventDefault: true },
    { key: "Mod-Shift-i", run: formatWhenArmed, preventDefault: true },
  ];
}

export function zedKeymapExtension(): Extension {
  return [syntaxSelectionExtension, Prec.high(keymap.of(zedKeymap()))];
}

export function zedKeymapOwnsKey(keymapPref: EditorKeymap, target: EventTarget | null): boolean {
  const isZed = keymapPref === "zed";
  const element = target as Element | null;
  const insideEditor = typeof element?.closest === "function" && element.closest(".cm-editor") !== null;
  return isZed && insideEditor;
}
