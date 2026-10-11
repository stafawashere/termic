import { useLayoutEffect, useState } from "react";
import { cellFromGlyph, TERMINAL_FONT_WEIGHT, TERMINAL_LINE_HEIGHT, type CellSize } from "@/lib/terminalCell";

const PROBE_GLYPHS = 32;

/** The terminal's cell in CSS pixels for this font, measured the way xterm
 *  measures its glyph box (a run of `W` in a hidden span) and rounded the way
 *  its WebGL renderer sizes cells. */
export function useTerminalCell(fontFamily: string, fontSize: number, letterSpacing: number): CellSize {
  const [cell, setCell] = useState<CellSize>(() => ({ width: fontSize * 0.6, height: Math.ceil(fontSize * 1.2) }));

  useLayoutEffect(() => {
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;

      const probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.textContent = "W".repeat(PROBE_GLYPHS);
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        whiteSpace: "pre",
        fontFamily,
        fontSize: `${fontSize}px`,
        fontWeight: String(TERMINAL_FONT_WEIGHT),
        lineHeight: "normal",
        letterSpacing: "0px",
      });
      document.body.appendChild(probe);
      const box = probe.getBoundingClientRect();
      probe.remove();

      const glyph = { width: box.width / PROBE_GLYPHS, height: box.height };
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
