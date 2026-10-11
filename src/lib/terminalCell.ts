// The cell grid every termic terminal draws on, shared by xterm (TerminalPane)
// and the views that have to line up with it (the subagent transcript).

/** Regular and bold, the two static JetBrains Mono masters bundled with the
 *  app. Any other weight forces xterm's WebGL atlas to interpolate, which
 *  WKWebView rasterizes soft. */
export const TERMINAL_FONT_WEIGHT = 400;
export const TERMINAL_FONT_WEIGHT_BOLD = 700;

/** xterm's default, and what TUIs (gemini, claude) assume: a larger value
 *  inflates every cell, so a row the TUI fills with a background reads as
 *  a ribbon instead of a tight band. */
export const TERMINAL_LINE_HEIGHT = 1.0;

export interface CellSize {
  width: number;
  height: number;
}

/** One cell in CSS pixels from a measured glyph box, rounded to device
 *  pixels the way xterm's WebGL renderer sizes its cells: the glyph width
 *  floored and the height ceiled at the device pixel ratio, letter spacing
 *  added to the width, line height scaling the height. */
export function cellFromGlyph(glyph: CellSize, devicePixelRatio: number, letterSpacing: number, lineHeight: number): CellSize {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const deviceGlyphWidth = Math.floor(glyph.width * ratio);
  const deviceGlyphHeight = Math.ceil(glyph.height * ratio);
  const deviceCellWidth = deviceGlyphWidth + Math.round(letterSpacing);
  const deviceCellHeight = Math.floor(deviceGlyphHeight * lineHeight);

  return { width: deviceCellWidth / ratio, height: deviceCellHeight / ratio };
}
