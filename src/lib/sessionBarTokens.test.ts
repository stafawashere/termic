// The session bar's --sessionbar-* family ships Dark+ values in its own
// @theme block, and every other theme has to redeclare whatever would leak
// that hex through: a token forgotten in a theme block paints Dark+ grey on
// cream (light) or on a custom theme's palette, and no other test sees it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOM_THEME_CLASS } from "./customTheme";

const css = readFileSync(join(__dirname, "..", "index.css"), "utf8");
const sectionStart = css.indexOf("@theme {\n  --sessionbar-");

function blockAfter(selectorStart: string): string {
  const at = css.indexOf(selectorStart, sectionStart);
  expect(at, `no block starting with ${selectorStart}`).toBeGreaterThan(-1);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/(--sessionbar-[a-z0-9-]+):\s*([^;]+);/g)) found.set(match[1], match[2].trim());
  return found;
}

const derivedDarkSelector = "html.claude, html.cobalt, html.matrix, html.rosepine, html.solarized,";
const defaults = declarations(blockAfter("@theme {"));
const derivedDark = declarations(blockAfter(derivedDarkSelector));
const light = declarations(blockAfter("html.light {"));

const hexTokens = [...defaults].filter(([, value]) => value.includes("#")).map(([name]) => name);
const shadowTokens = [...defaults].filter(([, value]) => value.includes("rgba(")).map(([name]) => name);

describe("session bar tokens", () => {
  it("declares its family in its own @theme block", () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(hexTokens).toEqual(expect.arrayContaining(["--sessionbar-bg-top", "--sessionbar-bg-bottom", "--sessionbar-border", "--sessionbar-glyph-dim", "--sessionbar-close-ink"]));
  });

  it("redeclares every hex default for the derived dark themes", () => {
    const missing = hexTokens.filter(name => !derivedDark.has(name));
    expect(missing).toEqual([]);
  });

  it("redeclares every hex and shadow default for light", () => {
    const missing = [...hexTokens, ...shadowTokens].filter(name => !light.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps hex out of the derived dark recipes so they follow the theme", () => {
    const hardCoded = [...derivedDark].filter(([, value]) => /#[0-9a-f]{3,8}\b/i.test(value));
    expect(hardCoded).toEqual([]);
  });

  it("covers custom themes through the class applyTheme sets", () => {
    const at = css.indexOf(derivedDarkSelector, sectionStart);
    const selector = css.slice(at, css.indexOf("{", at));
    expect(selector).toContain(`html.${CUSTOM_THEME_CLASS}:not(.light)`);
  });
});
