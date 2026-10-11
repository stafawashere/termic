// The colours Claude Code 2.1.296 draws its transcript with, one table per
// value of its `theme` setting. The rgb numbers are taken from the theme
// objects in the installed claude binary; the two ansi themes name terminal
// colours instead, which resolve against termic's own terminal palette so
// they come out the way claude's would in the terminal tab next door.
//
// These are rgb() data rather than @theme tokens because they belong to
// claude's themes, not termic's: see docs/themes.md "The subagent view
// paints with claude's palette".

export const CLAUDE_THEMES = [
  "dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi",
] as const;

export type ClaudeTheme = (typeof CLAUDE_THEMES)[number];

export const CLAUDE_ROLES = [
  "claude", "claudeShimmer", "text", "inactive", "subtle", "permission", "suggestion", "success", "error", "warning",
  "diffAdded", "diffRemoved", "diffAddedWord", "diffRemovedWord", "userMessageBackground",
] as const;

export type ClaudeRole = (typeof CLAUDE_ROLES)[number];

type Palette = Record<ClaudeRole, string>;

const DARK: Palette = {
  claude: "rgb(215,119,87)",
  claudeShimmer: "rgb(235,159,127)",
  text: "rgb(255,255,255)",
  inactive: "rgb(153,153,153)",
  subtle: "rgb(80,80,80)",
  permission: "rgb(177,185,249)",
  suggestion: "rgb(177,185,249)",
  success: "rgb(78,186,101)",
  error: "rgb(255,107,128)",
  warning: "rgb(255,193,7)",
  diffAdded: "rgb(34,92,43)",
  diffRemoved: "rgb(122,41,54)",
  diffAddedWord: "rgb(56,166,96)",
  diffRemovedWord: "rgb(179,89,107)",
  userMessageBackground: "rgb(55, 55, 55)",
};

const PALETTES: Record<ClaudeTheme, Palette> = {
  dark: DARK,
  light: {
    claude: "rgb(215,119,87)",
    claudeShimmer: "rgb(245,149,117)",
    text: "rgb(0,0,0)",
    inactive: "rgb(102,102,102)",
    subtle: "rgb(175,175,175)",
    permission: "rgb(87,105,247)",
    suggestion: "rgb(87,105,247)",
    success: "rgb(44,122,57)",
    error: "rgb(171,43,63)",
    warning: "rgb(150,108,30)",
    diffAdded: "rgb(105,219,124)",
    diffRemoved: "rgb(255,168,180)",
    diffAddedWord: "rgb(47,157,68)",
    diffRemovedWord: "rgb(209,69,75)",
    userMessageBackground: "rgb(240, 240, 240)",
  },
  "dark-daltonized": {
    claude: "rgb(255,153,51)",
    claudeShimmer: "rgb(255,183,101)",
    text: "rgb(255,255,255)",
    inactive: "rgb(153,153,153)",
    subtle: "rgb(80,80,80)",
    permission: "rgb(153,204,255)",
    suggestion: "rgb(153,204,255)",
    success: "rgb(51,153,255)",
    error: "rgb(255,102,102)",
    warning: "rgb(255,204,0)",
    diffAdded: "rgb(0,68,102)",
    diffRemoved: "rgb(102,0,0)",
    diffAddedWord: "rgb(0,119,179)",
    diffRemovedWord: "rgb(179,0,0)",
    userMessageBackground: "rgb(55, 55, 55)",
  },
  "light-daltonized": {
    claude: "rgb(255,153,51)",
    claudeShimmer: "rgb(255,183,101)",
    text: "rgb(0,0,0)",
    inactive: "rgb(102,102,102)",
    subtle: "rgb(175,175,175)",
    permission: "rgb(51,102,255)",
    suggestion: "rgb(51,102,255)",
    success: "rgb(0,102,153)",
    error: "rgb(204,0,0)",
    warning: "rgb(255,153,0)",
    diffAdded: "rgb(153,204,255)",
    diffRemoved: "rgb(255,204,204)",
    diffAddedWord: "rgb(51,102,204)",
    diffRemovedWord: "rgb(153,51,51)",
    userMessageBackground: "rgb(220, 220, 220)",
  },
  "dark-ansi": {
    claude: "ansi:redBright",
    claudeShimmer: "ansi:yellowBright",
    text: "ansi:whiteBright",
    inactive: "ansi:white",
    subtle: "ansi:white",
    permission: "ansi:blueBright",
    suggestion: "ansi:blueBright",
    success: "ansi:greenBright",
    error: "ansi:redBright",
    warning: "ansi:yellowBright",
    diffAdded: "ansi:green",
    diffRemoved: "ansi:red",
    diffAddedWord: "ansi:greenBright",
    diffRemovedWord: "ansi:redBright",
    userMessageBackground: "ansi:blackBright",
  },
  "light-ansi": {
    claude: "ansi:redBright",
    claudeShimmer: "ansi:yellowBright",
    text: "ansi:black",
    inactive: "ansi:blackBright",
    subtle: "ansi:blackBright",
    permission: "ansi:blue",
    suggestion: "ansi:blue",
    success: "ansi:green",
    error: "ansi:red",
    warning: "ansi:yellow",
    diffAdded: "ansi:green",
    diffRemoved: "ansi:red",
    diffAddedWord: "ansi:greenBright",
    diffRemovedWord: "ansi:redBright",
    userMessageBackground: "ansi:white",
  },
};

/** Where claude's spinner drifts when nothing new has arrived for a while.
 *  A constant in claude, not a theme role; an ansi theme uses its `error`
 *  instead, since the blend needs rgb on both ends. */
export const STALL_RED = "rgb(171,43,63)";

export function isAnsiTheme(theme: ClaudeTheme): boolean {
  return theme.endsWith("-ansi");
}

export function asClaudeTheme(value: string | null | undefined): ClaudeTheme {
  const known = (CLAUDE_THEMES as readonly string[]).includes(value ?? "");
  return known ? (value as ClaudeTheme) : "dark";
}

/** `ansi:redBright` as the xterm theme key that holds it, `brightRed`. */
export function ansiKey(name: string): string {
  const bright = /^(\w+)Bright$/.exec(name);
  if (!bright) return name;

  return `bright${bright[1][0].toUpperCase()}${bright[1].slice(1)}`;
}

/** Every role as a CSS colour. An ansi colour the terminal palette lacks
 *  falls back to the dark table's value for that role. */
export function resolveClaudePalette(theme: ClaudeTheme, terminal: Record<string, string>): Palette {
  const palette = PALETTES[theme];
  const resolved = {} as Palette;

  for (const role of CLAUDE_ROLES) {
    const value = palette[role];
    const isAnsi = value.startsWith("ansi:");
    resolved[role] = isAnsi ? terminal[ansiKey(value.slice(5))] ?? DARK[role] : value;
  }
  return resolved;
}

/** Claude draws a link in the terminal's own blue, plain on a light theme
 *  and bright on every other. */
export function claudeLinkColor(theme: ClaudeTheme, terminal: Record<string, string>, palette: Palette): string {
  const key = theme.startsWith("light") ? "blue" : "brightBlue";
  return terminal[key] ?? palette.permission;
}

/** The palette as custom properties for the view's root, `--cc-<role>`. */
export function paletteStyle(palette: Palette): Record<string, string> {
  const style: Record<string, string> = {};
  for (const role of CLAUDE_ROLES) style[`--cc-${role}`] = palette[role];
  return style;
}
