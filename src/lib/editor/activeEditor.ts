// The editor the user was last typing in.
//
// The command palette runs outside any editor, so a command that acts on "the
// current file" (rename, format, code actions) has to ask who that is. Only
// editors with code intelligence armed register here, which makes a non-null
// answer double as "this one has a language server behind it".

import type { EditorView } from "@codemirror/view";

let current: EditorView | null = null;

export function setActiveEditor(view: EditorView): void {
  current = view;
}

/** Forget `view` if it is the remembered one. A view that is not current has
 *  nothing to clear: a hidden tab's editor being destroyed must not drop the
 *  one the user is looking at. */
export function clearActiveEditor(view: EditorView): void {
  if (current === view) current = null;
}

/** The last focused editor, if it is still on screen. A tab that was switched
 *  away from keeps its view mounted but hidden, and acting on it would edit a
 *  file the user is not looking at. */
export function getActiveEditor(): EditorView | null {
  const view = current;
  if (!view) return null;

  const isMounted = view.dom.isConnected;
  const isVisible = view.dom.offsetParent !== null;
  return isMounted && isVisible ? view : null;
}
