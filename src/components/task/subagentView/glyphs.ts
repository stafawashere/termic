// The characters Claude Code draws its transcript with, by code point.

export const GLYPH = {
  entry: "⏺",
  hook: "⎿",
  star: "✻",
  ellipsis: "…",
  middot: "·",
  down: "↓",
  up: "↑",
  boxDone: "☒",
  boxOpen: "☐",
  collapsed: "▸",
  expanded: "▾",
  prompt: ">",
} as const;

/** The working glyph's frames, out and back, one line each in the strip. */
export const SPINNER_FRAMES = [
  "·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢",
] as const;
