import { describe, it, expect } from "vitest";
import { ansiKey, asClaudeTheme, CLAUDE_ROLES, CLAUDE_THEMES, paletteStyle, resolveClaudePalette } from "@/lib/claudePalette";

const TERMINAL: Record<string, string> = {
  background: "rgb(1,1,1)",
  black: "rgb(0,0,0)",
  red: "rgb(10,0,0)",
  green: "rgb(0,10,0)",
  yellow: "rgb(10,10,0)",
  blue: "rgb(0,0,10)",
  white: "rgb(200,200,200)",
  brightBlack: "rgb(100,100,100)",
  brightRed: "rgb(250,0,0)",
  brightGreen: "rgb(0,250,0)",
  brightYellow: "rgb(250,250,0)",
  brightBlue: "rgb(0,0,250)",
  brightWhite: "rgb(255,255,255)",
};

describe("claude palettes", () => {
  it("keeps the dark theme's values as claude 2.1.296 ships them", () => {
    const dark = resolveClaudePalette("dark", TERMINAL);
    expect(dark).toMatchObject({
      claude: "rgb(215,119,87)",
      claudeShimmer: "rgb(235,159,127)",
      text: "rgb(255,255,255)",
      inactive: "rgb(153,153,153)",
      permission: "rgb(177,185,249)",
      success: "rgb(78,186,101)",
      error: "rgb(255,107,128)",
      diffAdded: "rgb(34,92,43)",
      diffRemoved: "rgb(122,41,54)",
      userMessageBackground: "rgb(55, 55, 55)",
    });
  });

  it("gives every theme a colour for every role", () => {
    for (const theme of CLAUDE_THEMES) {
      const palette = resolveClaudePalette(theme, TERMINAL);
      for (const role of CLAUDE_ROLES) expect(palette[role], `${theme}.${role}`).toMatch(/^rgb\(/);
    }
  });

  it("resolves the ansi themes against the terminal's own palette", () => {
    const darkAnsi = resolveClaudePalette("dark-ansi", TERMINAL);
    expect(darkAnsi.claude).toBe(TERMINAL.brightRed);
    expect(darkAnsi.claudeShimmer).toBe(TERMINAL.brightYellow);
    expect(darkAnsi.text).toBe(TERMINAL.brightWhite);
    expect(darkAnsi.userMessageBackground).toBe(TERMINAL.brightBlack);

    const lightAnsi = resolveClaudePalette("light-ansi", TERMINAL);
    expect(lightAnsi.text).toBe(TERMINAL.black);
    expect(lightAnsi.inactive).toBe(TERMINAL.brightBlack);
  });

  it("falls back to dark for an ansi colour the terminal lacks", () => {
    const sparse = resolveClaudePalette("dark-ansi", { background: "rgb(0,0,0)" });
    expect(sparse.claude).toBe("rgb(215,119,87)");
  });

  it("maps claude's ansi names onto xterm's theme keys", () => {
    expect(ansiKey("redBright")).toBe("brightRed");
    expect(ansiKey("blackBright")).toBe("brightBlack");
    expect(ansiKey("blue")).toBe("blue");
  });

  it("reads an unknown or missing theme as dark", () => {
    expect(asClaudeTheme("light-daltonized")).toBe("light-daltonized");
    expect(asClaudeTheme("neon")).toBe("dark");
    expect(asClaudeTheme(null)).toBe("dark");
  });

  it("names each role as a custom property", () => {
    const style = paletteStyle(resolveClaudePalette("light", TERMINAL));
    expect(style["--cc-text"]).toBe("rgb(0,0,0)");
    expect(Object.keys(style)).toHaveLength(CLAUDE_ROLES.length);
  });
});
