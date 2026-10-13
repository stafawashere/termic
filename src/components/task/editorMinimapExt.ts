import type { Extension } from "@codemirror/state";
import { showMinimap, type MinimapConfig } from "@replit/codemirror-minimap";

export const MINIMAP_DISPLAY_TEXT = "blocks";

function createMinimapContainer(): { dom: HTMLElement } {
  return { dom: document.createElement("div") };
}

export function minimapConfig(): MinimapConfig {
  return {
    create: createMinimapContainer,
    displayText: MINIMAP_DISPLAY_TEXT,
    showOverlay: "mouse-over",
  };
}

export function minimapExtension(): Extension {
  return showMinimap.compute([], minimapConfig);
}
