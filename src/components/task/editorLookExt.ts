import type { Extension } from "@codemirror/state";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

const GUIDE = "var(--color-indent-guide)";
const GUIDE_ACTIVE = "var(--color-indent-guide-active)";

export function indentGuidesExtension(): Extension {
  return indentationMarkers({
    colors: {
      light: GUIDE,
      dark: GUIDE,
      activeLight: GUIDE_ACTIVE,
      activeDark: GUIDE_ACTIVE,
    },
    highlightActiveBlock: true,
    hideFirstIndent: true,
    markerType: "fullScope",
  });
}

export async function loadMinimapExtension(): Promise<Extension> {
  const { minimapExtension } = await import("./editorMinimapExt");
  return minimapExtension();
}
