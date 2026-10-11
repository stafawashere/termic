import { useLayoutEffect, useState } from "react";
import { cellFromGlyph, TERMINAL_FONT_WEIGHT, TERMINAL_LINE_HEIGHT, type CellSize } from "@/lib/terminalCell";

const PROBE_GLYPHS = 32;

/** xterm 5.5 measures one `W` with canvas text metrics where the webview has
 *  them (WKWebView does), and falls back to a run of `W` in a hidden span. */
function measureGlyph(fontFamily: string, fontSize: number): CellSize {
  const hasCanvasMetrics = typeof OffscreenCanvas !== "undefined";
  if (hasCanvasMetrics) {
    const context = new OffscreenCanvas(100, 100).getContext("2d");
    if (context) {
      context.font = `${fontSize}px ${fontFamily}`;
      const metrics = context.measureText("W");
      return { width: metrics.width, height: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent };
    }
  }

  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.textContent = "W".repeat(PROBE_GLYPHS);
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre",
    fontKerning: "none",
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: String(TERMINAL_FONT_WEIGHT),
  });
  document.body.appendChild(probe);
  const glyph = { width: probe.offsetWidth / PROBE_GLYPHS, height: probe.offsetHeight };
  probe.remove();
  return glyph;
}

export function useTerminalCell(fontFamily: string, fontSize: number, letterSpacing: number): CellSize {
  const [cell, setCell] = useState<CellSize>(() => ({ width: fontSize * 0.6, height: Math.ceil(fontSize * 1.2) }));

  useLayoutEffect(() => {
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;

      const glyph = measureGlyph(fontFamily, fontSize);
      const next = cellFromGlyph(glyph, window.devicePixelRatio, letterSpacing, TERMINAL_LINE_HEIGHT);
      setCell(current => {
        const unchanged = current.width === next.width && current.height === next.height;
        return unchanged ? current : next;
      });
    };

    measure();
    void document.fonts?.ready.then(measure);
    return () => {
      cancelled = true;
    };
  }, [fontFamily, fontSize, letterSpacing]);

  return cell;
}
