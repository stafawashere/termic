// The sidebar's --sidebar-* family ships Dark+ hex in @theme, and every other
// theme has to redeclare whatever would otherwise leak that hex through. A
// token added to @theme and forgotten in a theme block paints Dark+ grey on
// cream (light) or on a custom theme's own palette, which no other test sees.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOM_THEME_CLASS } from "./customTheme";

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");

function blockAfter(selectorStart: string): string {
  const at = css.indexOf(selectorStart);
  expect(at, `no block starting with ${selectorStart}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--sidebar-[a-z0-9-]+):\s*([^;]+);/g)) found.set(match[1], match[2].trim());
  return found;
}

const defaults = declarations(blockAfter("@theme {"));
const derivedDarkSelector = "html.claude, html.cobalt, html.matrix, html.rosepine, html.solarized,";
const derivedDark = declarations(blockAfter(derivedDarkSelector));
const light = declarations(blockAfter("html.light {\n    --sidebar-"));

const hexTokens = [...defaults].filter(([, value]) => value.includes("#")).map(([name]) => name);
const rgbaTokens = [...defaults].filter(([, value]) => value.includes("rgba(")).map(([name]) => name);

describe("sidebar tokens", () => {
  it("declares a family in @theme", () => {
    expect(hexTokens.length).toBeGreaterThan(30);
  });

  it("redeclares every hex default for the derived dark themes", () => {
    const missing = hexTokens.filter(name => !derivedDark.has(name));
    expect(missing).toEqual([]);
  });

  it("redeclares every hex and shadow default for light", () => {
    const missing = [...hexTokens, ...rgbaTokens].filter(name => !light.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps hex out of the derived dark recipes so they follow the theme", () => {
    const hardCoded = [...derivedDark].filter(([, value]) => /#[0-9a-f]{3,8}\b/i.test(value) && !value.includes("#000000"));
    expect(hardCoded).toEqual([]);
  });

  it("covers custom themes through the class applyTheme sets", () => {
    const selectorEnd = css.indexOf("{", css.indexOf(derivedDarkSelector));
    const selector = css.slice(css.indexOf(derivedDarkSelector), selectorEnd);
    expect(selector).toContain(`html.${CUSTOM_THEME_CLASS}:not(.light)`);
  });

  it("drives selection and the dragged scrollbar from the accent", () => {
    expect(defaults.get("--sidebar-sel-bar")).toBe("var(--color-accent)");
    expect(defaults.get("--sidebar-scroll-thumb-active")).toBe("var(--color-accent)");
    expect(defaults.get("--sidebar-sel-from")).toContain("var(--color-accent)");
  });
});
