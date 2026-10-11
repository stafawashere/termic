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
