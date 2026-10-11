// The characters Claude Code draws its transcript with, by code point.

export const GLYPH = {
  entry: "\u23FA",
  bullet: "\u25CF",
  ring: "\u25CB",
  pointer: "\u276F",
  hook: "\u23BF",
  star: "\u273B",
  ellipsis: "\u2026",
  middot: "\u00B7",
  down: "\u2193",
  up: "\u2191",
  therefore: "\u2234",
  todoDone: "\u2714",
  todoActive: "\u25FC",
  todoPending: "\u25FB",
  collapsed: "\u25B8",
  expanded: "\u25BE",
} as const;

/** Claude draws its message and tool bullet as U+23FA on macOS and U+25CF
 *  everywhere else; termic's claude runs on this same machine. */
const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
export const MESSAGE_BULLET = IS_MAC ? GLYPH.entry : GLYPH.bullet;

/** The result connector: two spaces, the hook, a space and a no-break
 *  space, so the result's text starts at cell 5. */
export const RESULT_CONNECTOR = "  \u23BF \u00A0";

/** The spinner glyph's frames, one line each in the strip. The cosine in
 *  index.css plays them out and back. */
export const SPINNER_FRAMES = ["\u00B7", "\u2722", "\u2733", "\u2736", "\u273B", "\u273D"] as const;

/** Claude 2.1.296's welcome mascot, three rows of quadrant blocks, nine
 *  cells wide. */
export const MASCOT_ROWS = [
  " \u2590\u259B\u2588\u2588\u2588\u259B\u2588",
  "\u259D\u259C\u2588\u2588\u2588\u2588\u2588\u2588\u2580",
  " \u259D\u259D   \u259D\u259D",
] as const;

export const MASCOT_WIDTH = 9;

/** Which quarters of its cell each block glyph fills: top left, top right,
 *  bottom left, bottom right. Drawn as boxes, the way xterm draws block
 *  glyphs itself, so rows meet without the font's line gap. */
export const BLOCK_QUADRANTS: Readonly<Record<string, readonly [boolean, boolean, boolean, boolean]>> = {
  "\u2588": [true, true, true, true],
  "\u2580": [true, true, false, false],
  "\u2590": [false, true, false, true],
  "\u2598": [true, false, false, false],
  "\u259B": [true, true, true, false],
  "\u259C": [true, true, false, true],
  "\u259D": [false, true, false, false],
};
