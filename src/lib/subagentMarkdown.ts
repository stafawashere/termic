// The slice of markdown Claude Code draws in its terminal, parsed into plain
// data for the subagent view to turn into React elements. There is no HTML
// path anywhere: a tag in the text is text, and stays text.

export interface MarkdownSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

export type MarkdownBlock =
  | { kind: "paragraph"; spans: MarkdownSpan[] }
  | { kind: "heading"; spans: MarkdownSpan[] }
  | { kind: "bullet"; depth: number; spans: MarkdownSpan[] }
  | { kind: "numbered"; depth: number; marker: string; spans: MarkdownSpan[] }
  | { kind: "quote"; spans: MarkdownSpan[] }
  | { kind: "code"; lines: string[] }
  | { kind: "blank" };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(?<![\w*])(\*[^*\s][^*\n]*\*)(?!\w)|(?<!\w)(_[^_\s][^_\n]*_)(?!\w)/g;

function span(text: string, style: Partial<MarkdownSpan> = {}): MarkdownSpan {
  return { text, bold: false, italic: false, code: false, ...style };
}

export function parseInline(line: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let consumed = 0;

  for (const match of line.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > consumed) spans.push(span(line.slice(consumed, at)));

    const [token, code, starBold, underBold] = match;
    if (code) spans.push(span(token.slice(1, -1), { code: true }));
    else if (starBold || underBold) spans.push(span(token.slice(2, -2), { bold: true }));
    else spans.push(span(token.slice(1, -1), { italic: true }));

    consumed = at + token.length;
  }

  if (consumed < line.length) spans.push(span(line.slice(consumed)));
  return spans;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function depthOf(indent: string): number {
  return Math.floor(indent.replace(/\t/g, "  ").length / 2);
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let fence: string[] | null = null;

  for (const line of source.split("\n")) {
    const isFence = FENCE.test(line);
    if (fence) {
      if (isFence) {
        blocks.push({ kind: "code", lines: fence });
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }

    if (isFence) {
      fence = [];
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", spans: parseInline(heading[1]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", depth: depthOf(bullet[1]), spans: parseInline(bullet[2]) });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      blocks.push({ kind: "numbered", depth: depthOf(numbered[1]), marker: numbered[2], spans: parseInline(numbered[3]) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      blocks.push({ kind: "quote", spans: parseInline(quote[1]) });
      continue;
    }

    blocks.push({ kind: "paragraph", spans: parseInline(line) });
  }

  if (fence) blocks.push({ kind: "code", lines: fence });
  return blocks;
}
