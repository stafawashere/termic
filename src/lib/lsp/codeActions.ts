// Code actions: the quick fixes and refactorings a server offers at the cursor
// (GH #174).
//
// `@codemirror/lsp-client` has no support for these, so this asks
// `textDocument/codeAction` itself. The answer is a list, shown in the same
// floating style as the usages popup and anchored at the cursor, because a
// choice you have to make is read where your eye already is.

import { EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField, StateEffect, Prec, type Extension } from "@codemirror/state";
import { forEachDiagnostic } from "@codemirror/lint";
import { LSPPlugin } from "@codemirror/lsp-client";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { TermicWorkspace } from "./workspace";
import type { LspRange, LspWorkspaceEdit } from "./applyWorkspaceEdit";

interface LspCommand {
  title?: string;
  command: string;
  arguments?: unknown[];
}

interface LspCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: LspWorkspaceEdit;
  /** A CodeAction carries an object here; a bare Command IS the object, with
   *  the command name in this field as a string. */
  command?: LspCommand | string;
  arguments?: unknown[];
  data?: unknown;
}

interface ActionsState {
  pos: number;
  items: LspCodeAction[];
  active: number;
}

const setActions = StateEffect.define<{ pos: number; items: LspCodeAction[] } | null>();
const moveActive = StateEffect.define<number>();

const actionsField = StateField.define<ActionsState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActions)) {
        if (!effect.value) return null;
        return { pos: effect.value.pos, items: effect.value.items, active: 0 };
      }
      if (effect.is(moveActive) && value) {
        const next = Math.max(0, Math.min(value.items.length - 1, value.active + effect.value));
        return next === value.active ? value : { ...value, active: next };
      }
    }
    // An edit or a cursor move changes what applies at the anchor.
    const hasMoved = tr.docChanged || !!tr.selection;
    if (hasMoved && value) return null;
    return value;
  },
  provide: field => showTooltip.from(field, state => (state ? buildTooltip(state) : null)),
});

function buildTooltip(state: ActionsState): Tooltip {
  return {
    pos: state.pos,
    above: false,
    create: view => {
      const dom = document.createElement("div");
      dom.className = "cm-lsp-usages cm-lsp-actions";

      const list = dom.appendChild(document.createElement("div"));
      list.className = "cm-lsp-usages-list";
      list.setAttribute("role", "listbox");

      const rows: HTMLElement[] = [];
      const select = (index: number) => {
        rows.forEach((row, rowIndex) => {
          const isActive = rowIndex === index;
          row.classList.toggle("cm-lsp-usages-active", isActive);
          row.setAttribute("aria-selected", String(isActive));
          if (isActive) row.scrollIntoView({ block: "nearest" });
        });
      };

      state.items.forEach((item, index) => {
        const row = list.appendChild(document.createElement("div"));
        row.className = "cm-lsp-usages-row cm-lsp-actions-row";
        row.setAttribute("role", "option");

        const title = row.appendChild(document.createElement("span"));
        title.className = "cm-lsp-actions-title";
        title.textContent = item.title;

        const kind = row.appendChild(document.createElement("span"));
        kind.className = "cm-lsp-actions-kind";
        kind.textContent = item.kind ?? "";

        row.addEventListener("mouseenter", () => select(index));
        row.addEventListener("mousedown", event => {
          event.preventDefault();
          void chooseAction(view, item);
        });
        rows.push(row);
      });

      select(state.active);
      return {
        dom,
        class: "cm-lsp-usages-tooltip cm-lsp-actions-tooltip",
        update: update => {
          const next = update.state.field(actionsField, false);
          if (next && next.pos === state.pos) select(next.active);
        },
      };
    },
  };
}

const actionsKeymap = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    const state = view.state.field(actionsField, false);
    if (!state) return false;

    if (event.key === "Escape") {
      view.dispatch({ effects: setActions.of(null) });
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      view.dispatch({ effects: moveActive.of(event.key === "ArrowDown" ? 1 : -1) });
      return true;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = state.items[state.active];
      if (item) void chooseAction(view, item);
      return true;
    }
    return false;
  },
}));

const actionsTheme = EditorView.theme({
  ".cm-lsp-actions": {
    minWidth: "240px",
  },
  ".cm-lsp-actions-row": {
    justifyContent: "space-between",
  },
  ".cm-lsp-actions-title": {
    color: "var(--color-fg)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-lsp-actions-kind": {
    color: "var(--color-fg-dim)",
    fontSize: "11px",
    flexShrink: 0,
  },
});

export const codeActionsPopup: Extension = [actionsField, actionsKeymap, actionsTheme];

function notify(message: string, kind: "info" | "error") {
  useUI.getState().pushToast(message, kind);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBefore(a: { line: number; character: number }, b: { line: number; character: number }) {
  const isEarlierLine = a.line < b.line;
  const isSameLine = a.line === b.line;
  const isEarlierColumn = a.character < b.character;
  return isEarlierLine || (isSameLine && isEarlierColumn);
}

function overlaps(diagnostic: { range: LspRange }, range: LspRange): boolean {
  const endsBeforeRange = isBefore(diagnostic.range.end, range.start);
  const startsAfterRange = isBefore(range.end, diagnostic.range.start);
  return !endsBeforeRange && !startsAfterRange;
}

/** The diagnostics touching the selection, in the shape the request wants.
 *  The server's own pushed copies when there are any, since they carry the
 *  `code` and `data` a quick fix is keyed on; otherwise rebuilt from what the
 *  editor is showing (pull diagnostics arrive without them). */
function diagnosticsAt(view: EditorView, plugin: LSPPlugin, range: LspRange) {
  const workspace = plugin.client.workspace;
  if (workspace instanceof TermicWorkspace) {
    const pushed = workspace.diagnosticsFor(plugin.uri).filter(item => overlaps(item, range));
    if (pushed.length) return pushed;
  }

  const rebuilt: unknown[] = [];
  const selection = view.state.selection.main;
  forEachDiagnostic(view.state, (diagnostic, from, to) => {
    const touchesSelection = from <= selection.to && to >= selection.from;
    if (!touchesSelection) return;
    rebuilt.push({
      range: { start: plugin.toPosition(from), end: plugin.toPosition(to) },
      message: diagnostic.message,
      severity: { error: 1, warning: 2, info: 3, hint: 4 }[diagnostic.severity],
      source: diagnostic.source,
    });
  });
  return rebuilt;
}

/** Ask the server what can be done at the selection and float the answer. */
export async function showCodeActions(view: EditorView): Promise<void> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return;

  const client = plugin.client;
  try {
    await client.initializing;
  } catch {
    return;
  }
  const provider = client.serverCapabilities?.codeActionProvider;
  if (!provider) {
    notify(i18n.t("backend:lsp.noCodeActionSupport"), "info");
    return;
  }

  client.sync();
  const selection = view.state.selection.main;
  const range: LspRange = {
    start: plugin.toPosition(selection.from),
    end: plugin.toPosition(selection.to),
  };

  let items: Array<LspCodeAction> | null;
  try {
    items = await client.request<unknown, Array<LspCodeAction> | null>("textDocument/codeAction", {
      textDocument: { uri: plugin.uri },
      range,
      context: { diagnostics: diagnosticsAt(view, plugin, range), triggerKind: 1 },
    });
  } catch (err) {
    notify(i18n.t("backend:lsp.codeActionsFailed", { error: describe(err) }), "error");
    return;
  }

  const usable = (items ?? []).filter(item => !item.disabled);
  const preferredFirst = [
    ...usable.filter(item => item.isPreferred),
    ...usable.filter(item => !item.isPreferred),
  ];
  if (!preferredFirst.length) {
    notify(i18n.t("backend:lsp.noCodeActions"), "info");
    return;
  }

  view.dispatch({ effects: setActions.of({ pos: selection.head, items: preferredFirst }) });
}

async function chooseAction(view: EditorView, chosen: LspCodeAction): Promise<void> {
  view.dispatch({ effects: setActions.of(null) });
  view.focus();

  const plugin = LSPPlugin.get(view);
  if (!plugin) return;
  const client = plugin.client;

  try {
    let action = chosen;
    const provider = client.serverCapabilities?.codeActionProvider;
    const canResolve = typeof provider === "object" && !!provider.resolveProvider;
    const needsResolve = !action.edit && action.data !== undefined && canResolve;
    if (needsResolve) {
      action = await client.request<LspCodeAction, LspCodeAction>("codeAction/resolve", action);
    }

    const workspace = client.workspace;
    if (action.edit && workspace instanceof TermicWorkspace) {
      await workspace.applyEdit(action.edit, i18n.t("backend:lsp.whatCodeAction"));
    }

    const command: LspCommand | null = typeof action.command === "string"
      ? { command: action.command, arguments: action.arguments }
      : action.command ?? null;
    if (command) {
      await client.request("workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      });
    }
  } catch (err) {
    notify(i18n.t("backend:lsp.codeActionFailed", { error: describe(err) }), "error");
  }
}
