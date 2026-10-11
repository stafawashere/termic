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
  boxDone: "\u2612",
  boxOpen: "\u2610",
  collapsed: "\u25B8",
  expanded: "\u25BE",
} as const;

/** The working glyph's frames, out and back, one line each in the strip. */
export const SPINNER_FRAMES = [
  "\u00B7", "\u2722", "\u2733", "\u2736", "\u273B", "\u273D", "\u273B", "\u2736", "\u2733", "\u2722",
] as const;
