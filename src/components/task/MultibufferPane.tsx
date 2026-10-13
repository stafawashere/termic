import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching } from "@codemirror/language";
import type { MultibufferTab, Task } from "@/lib/types";
import type { Excerpt } from "@/lib/multibuffer";
import { saveTargets } from "@/lib/multibuffer";
import { taskFileRead, taskFileWrite } from "@/lib/ipc";
import { langForPath } from "@/lib/languageExts";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { fileIconUrl } from "@/lib/explorer/iconResolver";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs, resolveTheme } from "@/store/prefs";

const ESTIMATED_LINE_PX = 20;
const MOUNT_MARGIN = "600px";

interface ExcerptSlot {
  excerpt: Excerpt;
  view: EditorView | null;
  lineNumberComp: Compartment;
  themeComp: Compartment;
  langComp: Compartment;
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

export function MultibufferPane({ task, tab }: { task: Task; tab: MultibufferTab }) {
  const { t } = useTranslation("panels");
  const editorFontSize = usePrefs(s => s.editorFontSize);
  const codeLigatures = usePrefs(s => s.codeLigatures);
  const editorThemeIdDark = usePrefs(s => s.editorThemeIdDark);
  const editorThemeIdLight = usePrefs(s => s.editorThemeIdLight);
  const themeMode = usePrefs(s => s.themeMode);
  const appIsLight = resolveTheme(themeMode) === "light";
  const editorThemeId = appIsLight ? editorThemeIdLight : editorThemeIdDark;

  const slotsRef = useRef<ExcerptSlot[]>([]);
  if (slotsRef.current.length === 0 && tab.excerpts.length > 0) {
    slotsRef.current = tab.excerpts.map(excerpt => ({
      excerpt: { ...excerpt },
      view: null,
      lineNumberComp: new Compartment(),
      themeComp: new Compartment(),
      langComp: new Compartment(),
    }));
  }

  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const themeRef = useRef<Extension[]>([]);
  themeRef.current = [
    resolveEditorTheme(editorThemeId, appIsLight),
    editorSurfaceTheme(editorFontSize, codeLigatures),
  ];

  const markDirty = useCallback(() => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    useApp.getState().patchTab(task.id, tab.id, { dirty: true });
  }, [task.id, tab.id]);

  const refreshGutter = useCallback((slot: ExcerptSlot) => {
    slot.view?.dispatch({ effects: slot.lineNumberComp.reconfigure(gutterFor(slot)) });
  }, []);

  const rebaseWrittenFile = useCallback((path: string) => {
    const fileSlots = slotsRef.current
      .filter(slot => slot.excerpt.path === path)
      .sort((a, b) => a.excerpt.startLine - b.excerpt.startLine);

    let shift = 0;

    for (const slot of fileSlots) {
      const { excerpt } = slot;
      const previousCount = excerpt.endLine - excerpt.startLine + 1;
      const nextCount = lineCount(excerpt.text);

      excerpt.startLine += shift;
      excerpt.endLine = excerpt.startLine + nextCount - 1;
      excerpt.baseText = excerpt.text;
      shift += nextCount - previousCount;
    }

    fileSlots.forEach(refreshGutter);
  }, [refreshGutter]);

  const save = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;

    try {
      const excerpts = slotsRef.current.map(slot => slot.excerpt);
      const editedPaths = [...new Set(
        excerpts.filter(excerpt => excerpt.text !== excerpt.baseText).map(excerpt => excerpt.path),
      )];

      const diskTexts: Record<string, string> = {};
      await Promise.all(editedPaths.map(async path => {
        try {
          diskTexts[path] = await taskFileRead(task.id, path);
        } catch {
          // a file that cannot be read is reported as a conflict
        }
      }));

      const targets = saveTargets(excerpts, diskTexts);
      let allWritten = true;
      let writtenCount = 0;

      for (const target of targets) {
        if (target.status === "conflict") {
          allWritten = false;
          useUI.getState().pushToast(t("multibuffer.conflictToast", { path: target.path }), "error");
          continue;
        }

        try {
          await taskFileWrite(task.id, target.path, target.content);
          rebaseWrittenFile(target.path);
          writtenCount += 1;
        } catch (error) {
          allWritten = false;
          useUI.getState().pushToast(t("editor.saveFailed", { error }), "error");
        }
      }

      const hasWrites = writtenCount > 0;
      if (hasWrites) {
        useUI.getState().pushToast(
          t(writtenCount === 1 ? "multibuffer.savedOne" : "multibuffer.savedMany", { count: writtenCount }),
          "success",
        );
        useApp.getState().bumpGitRevision(task.id);
      }

      if (allWritten) {
        dirtyRef.current = false;
        useApp.getState().patchTab(task.id, tab.id, { dirty: false });
      }
    } finally {
      savingRef.current = false;
    }
  }, [task.id, tab.id, t, rebaseWrittenFile]);

  const saveRef = useRef(save);
  saveRef.current = save;

  const mountView = useCallback((index: number, host: HTMLElement) => {
    const slot = slotsRef.current[index];
    if (!slot || slot.view) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: slot.excerpt.text,
        extensions: [
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { void saveRef.current(); return true; } },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorState.lineSeparator.of("\n"),
          slot.lineNumberComp.of(gutterFor(slot)),
          history(),
          drawSelection(),
          highlightActiveLine(),
          bracketMatching(),
          slot.langComp.of([]),
          slot.themeComp.of(themeRef.current),
          EditorView.updateListener.of(update => {
            if (!update.docChanged) return;
            slot.excerpt.text = update.state.doc.toString();
            markDirty();
          }),
        ],
      }),
      parent: host,
    });

    slot.view = view;

    if (import.meta.env.VITE_E2E) {
      (view.dom as unknown as { __cmView: EditorView }).__cmView = view;
    }

    void langForPath(slot.excerpt.path).then(found => {
      if (!found || slot.view !== view) return;
      view.dispatch({ effects: slot.langComp.reconfigure(found.ext) });
    });
  }, [markDirty]);

  useEffect(() => {
    for (const slot of slotsRef.current) {
      slot.view?.dispatch({ effects: slot.themeComp.reconfigure(themeRef.current) });
    }
  }, [editorThemeId, appIsLight, editorFontSize, codeLigatures]);

  useEffect(() => () => {
    for (const slot of slotsRef.current) {
      slot.view?.destroy();
      slot.view = null;
    }
  }, []);

  const openAtExcerpt = (excerpt: Excerpt) => {
    useApp.getState().openPreviewTab(task.id, {
      type: "edit",
      path: excerpt.path,
      title: excerpt.path.split("/").pop() || excerpt.path,
      revealAt: { line: excerpt.startLine },
      permanent: true,
    });
  };

  if (slotsRef.current.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--color-fg-faint)]">
        {t("multibuffer.empty")}
      </div>
    );
  }

  return (
    <div data-testid="multibuffer-pane" className="h-full overflow-y-auto bg-[var(--color-bg-0)]">
      {slotsRef.current.map((slot, index) => {
        const { excerpt } = slot;
        const previous = slotsRef.current[index - 1];
        const startsFile = previous?.excerpt.path !== excerpt.path;
        const name = excerpt.path.split("/").pop() || excerpt.path;

        return (
          <div key={`${excerpt.path}:${index}`}>
            {startsFile && (
              <button
                type="button"
                data-testid="multibuffer-header"
                onClick={() => openAtExcerpt(excerpt)}
                title={t("multibuffer.openTip", { path: excerpt.path, line: excerpt.startLine })}
                className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-bg-1)] px-3 py-1 text-left text-[12.5px] hover:bg-[var(--color-hover)]"
              >
                <img src={fileIconUrl(name)} alt="" className="h-4 w-4 shrink-0 file-icon" />
                <span className="truncate font-semibold text-[var(--color-fg)]">{name}</span>
                <span className="truncate text-[12px] text-[var(--color-fg-faint)]">{excerpt.path}</span>
              </button>
            )}
            <LazyExcerpt
              index={index}
              lines={lineCount(excerpt.text)}
              path={excerpt.path}
              mountView={mountView}
              slot={slot}
            />
          </div>
        );
      })}
    </div>
  );
}

function gutterFor(slot: ExcerptSlot): Extension {
  return lineNumbers({ formatNumber: lineNumber => String(slot.excerpt.startLine + lineNumber - 1) });
}

function LazyExcerpt({ index, lines, path, mountView, slot }: {
  index: number;
  lines: number;
  path: string;
  mountView: (index: number, host: HTMLElement) => void;
  slot: ExcerptSlot;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (slot.view) return;

    const observer = new IntersectionObserver(entries => {
      const isVisible = entries.some(entry => entry.isIntersecting);
      if (!isVisible) return;

      observer.disconnect();
      mountView(index, host);
    }, { rootMargin: MOUNT_MARGIN });

    observer.observe(host);

    return () => observer.disconnect();
  }, [index, mountView, slot]);

  return (
    <div
      ref={hostRef}
      data-testid="multibuffer-excerpt"
      data-excerpt-index={index}
      data-path={path}
      className="border-b border-[var(--color-border-soft)]"
      style={{ minHeight: slot.view ? undefined : lines * ESTIMATED_LINE_PX }}
    />
  );
}
