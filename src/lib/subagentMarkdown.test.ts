import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInline, parseMarkdown, renderTable } from "@/lib/subagentMarkdown";
import { Markdown } from "@/components/task/subagentView/Markdown";

describe("parseInline", () => {
  it("splits bold, italic and inline code from plain text", () => {
    const spans = parseInline("use **bold**, *it*, _also_ and `code` here");
    const styled = spans.map(span => [span.text, span.bold, span.italic, span.code]);

    expect(styled).toEqual([
      ["use ", false, false, false],
      ["bold", true, false, false],
      [", ", false, false, false],
      ["it", false, true, false],
      [", ", false, false, false],
      ["also", false, true, false],
      [" and ", false, false, false],
      ["code", false, false, true],
      [" here", false, false, false],
    ]);
  });

  it("leaves snake_case names and a lone star alone", () => {
    expect(parseInline("call snake_case_name, my_var_ and 2 * 3")).toHaveLength(1);
  });
  it("reads links, bare urls, strikethrough and backslash escapes the way claude does", () => {
    const spans = parseInline("see [the docs](https://acme.com/a), https://acme.com/b. ~~old~~ \\*not italic\\*");
    const styled = spans.filter(span => span.link || span.strike).map(span => [span.text, span.link, span.strike]);

    expect(styled).toEqual([
      ["the docs", true, false],
      ["https://acme.com/b", true, false],
      ["old", false, true],
    ]);
    expect(spans.map(span => span.text).join("")).toBe("see the docs, https://acme.com/b. old *not italic*");
  });
});

describe("parseMarkdown", () => {
  it("reads headings, lists, quotes, fences and blank lines", () => {
    const blocks = parseMarkdown("# Plan\n\n- one\n  - nested\n2. two\n> quoted\n```ts\nconst a = 1\n```\nplain");

    expect(blocks.map(block => block.kind)).toEqual([
      "heading", "blank", "bullet", "bullet", "numbered", "quote", "code", "paragraph",
    ]);
    expect(blocks[3]).toMatchObject({ depth: 1 });
    expect(blocks[4]).toMatchObject({ marker: "2." });
    expect(blocks[0]).toMatchObject({ level: 1 });
    expect(blocks[6]).toEqual({ kind: "code", language: "ts", lines: ["const a = 1"] });
  });

  it("numbers an ordered list from its first item, in letters and roman numerals further down", () => {
    const blocks = parseMarkdown("3. three\n3. four\n   1. sub\n   1. sub\n      1. deep\n      1. deeper\n- dash\n  - inner");
    const markers = blocks.map(block => block.kind === "numbered" ? [block.marker, block.indent] : block.kind === "bullet" ? ["-", block.indent] : null);

    expect(markers).toEqual([
      ["3.", 0], ["4.", 0], ["a.", 3], ["b.", 3], ["i.", 6], ["ii.", 6], ["-", 0], ["-", 2],
    ]);
  });

  it("ends a heading on exactly one blank row", () => {
    const kinds = (source: string) => parseMarkdown(source).map(block => block.kind);

    expect(kinds("## Title\ntext")).toEqual(["heading", "blank", "paragraph"]);
    expect(kinds("## Title\n\n\n\ntext")).toEqual(["heading", "blank", "paragraph"]);
    expect(kinds("text\n## Title")).toEqual(["paragraph", "heading"]);
  });

  it("counts nested quote levels", () => {
    expect(parseMarkdown("> one\n>> two")).toMatchObject([{ kind: "quote", depth: 1 }, { kind: "quote", depth: 2 }]);
  });

  it("keeps an unclosed fence as code to the end", () => {
    expect(parseMarkdown("```\nstill code")).toEqual([{ kind: "code", language: "", lines: ["still code"] }]);
  });

  it("draws a table in box characters with a rule after every row", () => {
    const blocks = parseMarkdown("| Name | Port |\n|---|--:|\n| web | 4000 |\n| db | 5432 |\nafter");

    expect(blocks.map(block => block.kind)).toEqual(["table", "paragraph"]);
    expect(blocks[0]).toEqual({ kind: "table", lines: [
      "\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "\u2502 Name \u2502 Port \u2502",
      "\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
      "\u2502 web  \u2502 4000 \u2502",
      "\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2524",
      "\u2502 db   \u2502 5432 \u2502",
      "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2518",
    ] });
  });

  it("centres header cells, right-aligns by the rule, and keeps a column at least 3 wide", () => {
    const lines = renderTable(["a", "Total"], ["---", "--:"], [["x", "7"]]);
    expect(lines[1]).toBe("\u2502  a  \u2502 Total \u2502");
    expect(lines[3]).toBe("\u2502 x   \u2502     7 \u2502");
  });
});

describe("Markdown", () => {
  it("renders raw HTML and script tags as text, never as markup", () => {
    const html = renderToStaticMarkup(createElement(Markdown, {
      text: "<script>alert(1)</script> and <b>bold</b>\n```\n<img src=x onerror=alert(1)>\n```",
    }));

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
