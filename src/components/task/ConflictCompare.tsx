import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { resolveEditorTheme, editorSurfaceTheme } from "@/lib/editorTheme";
import { usePrefs, resolveTheme } from "@/store/prefs";

/** Read-only side by side of the buffer and the text now on disk, opened from
 *  the conflict banner. Left is the disk, right is the buffer, so the green
 *  runs are what saving the buffer would put back. */
export function ConflictCompare({ mine, disk, onClose }: {
  mine: string;
  disk: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("panels");
  const hostRef = useRef<HTMLDivElement>(null);
  const editorFontSize = usePrefs(s => s.editorFontSize);
  const themeMode = usePrefs(s => s.themeMode);
  const editorThemeIdDark = usePrefs(s => s.editorThemeIdDark);
  const editorThemeIdLight = usePrefs(s => s.editorThemeIdLight);
  const zedEditorThemes = usePrefs(s => s.zedEditorThemes);
  const appIsLight = resolveTheme(themeMode) === "light";
  const editorThemeId = appIsLight ? editorThemeIdLight : editorThemeIdDark;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensions = [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      lineNumbers(),
      EditorView.lineWrapping,
      resolveEditorTheme(editorThemeId, appIsLight, zedEditorThemes),
      editorSurfaceTheme(editorFontSize, false, true),
    ];

    const view = new MergeView({
      a: { doc: disk, extensions },
      b: { doc: mine, extensions },
      parent: host,
      highlightChanges: true,
      gutter: true,
    });

    return () => view.destroy();
  }, [mine, disk, editorFontSize, editorThemeId, appIsLight, zedEditorThemes]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-[var(--color-bg)]"
      data-testid="conflict-compare"
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2 text-[13px] text-[var(--color-fg-dim)]">
        <span>{t("editor.compareHeading")}</span>
        <button
          onClick={onClose}
          className="rounded px-2 py-[3px] hover:text-[var(--color-fg)]"
          data-testid="conflict-compare-close"
        >
          {t("editor.compareClose")}
        </button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-auto" />
    </div>
  );
}
