import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseInline, parseMarkdown } from "@/lib/subagentMarkdown";
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
});

describe("parseMarkdown", () => {
  it("reads headings, lists, quotes, fences and blank lines", () => {
    const blocks = parseMarkdown("# Plan\n\n- one\n  - nested\n2. two\n> quoted\n```ts\nconst a = 1\n```\nplain");

    expect(blocks.map(block => block.kind)).toEqual([
      "heading", "blank", "bullet", "bullet", "numbered", "quote", "code", "paragraph",
    ]);
    expect(blocks[3]).toMatchObject({ depth: 1 });
    expect(blocks[4]).toMatchObject({ marker: "2." });
    expect(blocks[6]).toEqual({ kind: "code", lines: ["const a = 1"] });
  });

  it("keeps an unclosed fence as code to the end", () => {
    expect(parseMarkdown("```\nstill code")).toEqual([{ kind: "code", lines: ["still code"] }]);
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
