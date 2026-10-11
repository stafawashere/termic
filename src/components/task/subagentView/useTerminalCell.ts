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

  return measureLaidOutGlyph(fontFamily, fontSize, false);
}

/** One glyph's advance as the page lays text out, which is what letter
 *  spacing has to correct. xterm's own fallback reads the whole-pixel
 *  `offsetWidth`; the advance needs the fraction. */
function measureLaidOutGlyph(fontFamily: string, fontSize: number, fractional: boolean): CellSize {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.textContent = "W".repeat(PROBE_GLYPHS);
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    whiteSpace: "pre",
    fontKerning: "none",
    letterSpacing: "0px",
    fontFamily,
    fontSize: `${fontSize}px`,
    fontWeight: String(TERMINAL_FONT_WEIGHT),
  });
  document.body.appendChild(probe);
  const runWidth = fractional ? probe.getBoundingClientRect().width : probe.offsetWidth;
  const glyph = { width: runWidth / PROBE_GLYPHS, height: probe.offsetHeight };
  probe.remove();
  return glyph;
}

/** The cell xterm draws on, and the font's own advance for one glyph. The
 *  two differ: xterm floors the advance to device pixels and adds its
 *  letter spacing in device pixels, so text laid out by the browser has to
 *  make up the difference itself to land on the same columns. */
export interface TerminalCell extends CellSize {
  glyphWidth: number;
}

export function useTerminalCell(fontFamily: string, fontSize: number, letterSpacing: number): TerminalCell {
  const [cell, setCell] = useState<TerminalCell>(() => ({ width: fontSize * 0.6, height: Math.ceil(fontSize * 1.2), glyphWidth: fontSize * 0.6 }));

  useLayoutEffect(() => {
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;

      const glyph = measureGlyph(fontFamily, fontSize);
      const next = { ...cellFromGlyph(glyph, window.devicePixelRatio, letterSpacing, TERMINAL_LINE_HEIGHT), glyphWidth: measureLaidOutGlyph(fontFamily, fontSize, true).width };
      setCell(current => {
        const unchanged = current.width === next.width && current.height === next.height && current.glyphWidth === next.glyphWidth;
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
