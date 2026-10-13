import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import fixtureText from "./__fixtures__/zed-theme.json?raw";
import {
  ZED_MAX_INPUT_BYTES,
  ZED_MAX_THEMES,
  ZedImportError,
  convertZedTheme,
  normalizeZedColor,
  sanitizeZedThemes,
  tagsForCapture,
  zedThemeExtension,
} from "./zedTheme";

function importError(input: unknown) {
  try {
    convertZedTheme(input);
  } catch (error) {
    return error as ZedImportError;
  }
  return null;
}

describe("normalizeZedColor", () => {
  it("accepts #rgb, #rrggbb and #rrggbbaa and lowercases them", () => {
    expect(normalizeZedColor("#ABC")).toBe("#aabbcc");
    expect(normalizeZedColor("#A1B2C3")).toBe("#a1b2c3");
    expect(normalizeZedColor("#A1B2C3D4")).toBe("#a1b2c3d4");
  });

  it("ignores everything else", () => {
    const rejected = ["#abcd", "#12345", "rgb(1,2,3)", "red", "", "ffffff", "#gggggg", 12, null, undefined];
    for (const value of rejected) expect(normalizeZedColor(value)).toBeNull();
  });
});

describe("tagsForCapture", () => {
  it("maps a known capture directly", () => {
    expect(tagsForCapture("keyword")).toEqual([t.keyword]);
    expect(tagsForCapture("string.escape")).toEqual([t.escape]);
  });

  it("falls back to the nearest dotted ancestor", () => {
    expect(tagsForCapture("keyword.control")).toEqual([t.keyword]);
    expect(tagsForCapture("function.method.call")).toEqual(tagsForCapture("function"));
    expect(tagsForCapture("string.escape.unicode")).toEqual([t.escape]);
  });

  it("returns no tags for a capture with no ancestor, and never throws", () => {
    const odd = ["unknown.capture", "", ".", "..a", "a.", "__proto__", "constructor.x", "toString"];
    for (const capture of odd) {
      expect(() => tagsForCapture(capture)).not.toThrow();
    }
    expect(tagsForCapture("unknown.capture")).toEqual([]);
    expect(tagsForCapture("__proto__")).toEqual([]);
    expect(tagsForCapture("toString")).toEqual([]);
  });
});

describe("convertZedTheme", () => {
  const themes = convertZedTheme(fixtureText);

  it("returns one theme per usable entry, namespaced zed:", () => {
    expect(themes.map(theme => theme.id)).toEqual(["zed:Acme Night", "zed:Acme Day", "zed:Acme Odd"]);
  });

  it("reads appearance, and treats anything but light as dark", () => {
    expect(themes[0].appearance).toBe("dark");
    expect(themes[1].appearance).toBe("light");
    expect(themes[2].appearance).toBe("dark");
  });

  it("maps the editor surface colors", () => {
    expect(themes[0].ui).toEqual({
      background: "#101820",
      foreground: "#ddeeff",
      gutterBackground: "#0c131a",
      lineNumber: "#556677",
      activeLine: "#18242f80",
      selection: "#3366ff55",
      cursor: "#ffcc00",
    });
  });

  it("takes the selection from element.selection_background when no player has one", () => {
    expect(themes[1].ui.selection).toBe("#cce0ff");
  });

  it("keeps valid syntax colors and font styles, drops invalid colors", () => {
    const syntax = themes[0].syntax;
    expect(syntax.comment).toEqual({ color: "#667788", italic: true });
    expect(syntax["keyword.control"]).toEqual({ color: "#ff3366", weight: 700 });
    expect(syntax.string.color).toBe("#88cc66");
    expect(syntax["string.escape"].color).toBe("#aabbcc");
    expect(syntax.type).toBeUndefined();
    expect(syntax.number).toBeUndefined();
    expect(syntax.constant).toBeUndefined();
    expect(syntax.variable).toBeUndefined();
  });

  it("keeps captures with no tag mapping as data without throwing", () => {
    expect(themes[0].syntax["unknown.capture.name"].color).toBe("#aabbcc");
    expect(() => zedThemeExtension(themes[0])).not.toThrow();
  });

  it("accepts an already parsed family", () => {
    expect(convertZedTheme(JSON.parse(fixtureText))).toEqual(themes);
  });

  it("drops duplicate names, keeping the first", () => {
    const family = { themes: [
      { name: "Same", appearance: "dark", style: { "editor.background": "#111" } },
      { name: "Same", appearance: "light", style: { "editor.background": "#eee" } },
    ] };
    const result = convertZedTheme(family);
    expect(result).toHaveLength(1);
    expect(result[0].ui.background).toBe("#111111");
  });
});

describe("convertZedTheme caps and errors", () => {
  it("rejects input over 512 KB", () => {
    const padding = "x".repeat(ZED_MAX_INPUT_BYTES);
    const oversized = JSON.stringify({ themes: [], padding });
    expect(importError(oversized)?.code).toBe("too-large");
  });

  it("measures bytes, not characters", () => {
    const multibyte = JSON.stringify({ themes: [], padding: "é".repeat(ZED_MAX_INPUT_BYTES / 2) });
    expect(multibyte.length).toBeLessThan(ZED_MAX_INPUT_BYTES);
    expect(importError(multibyte)?.code).toBe("too-large");
  });

  it("converts at most 64 themes", () => {
    const entries = Array.from({ length: ZED_MAX_THEMES + 20 }, (_, index) => ({
      name: `Theme ${index}`,
      appearance: "dark",
      style: {},
    }));
    const result = convertZedTheme({ themes: entries });
    expect(result).toHaveLength(ZED_MAX_THEMES);
    expect(result[ZED_MAX_THEMES - 1].name).toBe(`Theme ${ZED_MAX_THEMES - 1}`);
  });

  it("reports unparseable text and files without usable themes", () => {
    expect(importError("{ nope")?.code).toBe("invalid-json");
    expect(importError("{}")?.code).toBe("no-themes");
    expect(importError({ themes: [{ style: {} }, 3, null] })?.code).toBe("no-themes");
    expect(importError(null)?.code).toBe("no-themes");
  });
});

describe("zedThemeExtension", () => {
  const [night, day] = convertZedTheme(fixtureText);

  it("builds an extension CodeMirror accepts, once per theme object", () => {
    expect(zedThemeExtension(night)).toBe(zedThemeExtension(night));
    expect(() => EditorState.create({ doc: "x", extensions: [zedThemeExtension(night), zedThemeExtension(day)] })).not.toThrow();
  });

  it("builds a theme with no colors at all", () => {
    const bare = convertZedTheme({ themes: [{ name: "Bare", style: {} }] })[0];
    expect(() => EditorState.create({ doc: "x", extensions: [zedThemeExtension(bare)] })).not.toThrow();
  });
});

describe("sanitizeZedThemes", () => {
  it("round-trips converted themes", () => {
    const themes = convertZedTheme(fixtureText);
    expect(sanitizeZedThemes(JSON.parse(JSON.stringify(themes)))).toEqual(themes);
  });

  it("drops bad colors and malformed entries from hand-edited storage", () => {
    const stored = [
      { id: "zed:Edited", name: "Edited", appearance: "light", ui: { background: "javascript:alert(1)", foreground: "#fff" }, syntax: { keyword: { color: "url(x)" }, string: { color: "#0f0", italic: true } } },
      "junk",
      { name: 5 },
    ];
    const result = sanitizeZedThemes(stored);
    expect(result).toHaveLength(1);
    expect(result[0].ui).toEqual({ foreground: "#ffffff" });
    expect(result[0].syntax).toEqual({ string: { color: "#00ff00", italic: true } });
  });

  it("returns nothing for non-arrays", () => {
    expect(sanitizeZedThemes(null)).toEqual([]);
    expect(sanitizeZedThemes({})).toEqual([]);
  });
});
