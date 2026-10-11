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
  | { kind: "heading"; level: number; spans: MarkdownSpan[] }
  | { kind: "bullet"; depth: number; spans: MarkdownSpan[] }
  | { kind: "numbered"; depth: number; marker: string; spans: MarkdownSpan[] }
  | { kind: "quote"; spans: MarkdownSpan[] }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "table"; lines: string[] }
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

const FENCE = /^\s*(?:```|~~~)\s*([\w+#.-]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

type Align = "left" | "center" | "right";

function cellsOf(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
}

function alignOf(rule: string): Align {
  const left = rule.startsWith(":");
  const right = rule.endsWith(":");
  if (left && right) return "center";
  return right ? "right" : "left";
}

function pad(text: string, width: number, align: Align): string {
  const room = width - text.length;
  if (align === "right") return " ".repeat(room) + text;
  if (align === "left") return text + " ".repeat(room);

  const before = Math.floor(room / 2);
  return " ".repeat(before) + text + " ".repeat(room - before);
}

const TABLE_MIN_COLUMN = 3;

/** A markdown table drawn the way claude draws one: box characters, one
 *  space of padding, a rule after every row, header cells centred and body
 *  cells aligned by the separator row. */
export function renderTable(header: readonly string[], rule: readonly string[], body: readonly (readonly string[])[]): string[] {
  const columns = header.length;
  const aligns = Array.from({ length: columns }, (_, column) => alignOf(rule[column] ?? ""));
  const rows = [header, ...body].map(row => Array.from({ length: columns }, (_, column) => row[column] ?? ""));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(TABLE_MIN_COLUMN, ...rows.map(row => row[column].length)));

  const border = (left: string, middle: string, right: string) =>
    left + widths.map(width => "\u2500".repeat(width + 2)).join(middle) + right;
  const line = (row: readonly string[], header: boolean) =>
    "\u2502" + row.map((cell, column) => ` ${pad(cell, widths[column], header ? "center" : aligns[column])} `).join("\u2502") + "\u2502";

  const lines = [border("\u250C", "\u252C", "\u2510")];
  rows.forEach((row, position) => {
    lines.push(line(row, position === 0));
    const isLast = position === rows.length - 1;
    lines.push(isLast ? border("\u2514", "\u2534", "\u2518") : border("\u251C", "\u253C", "\u2524"));
  });
  return lines;
}
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function depthOf(indent: string): number {
  return Math.floor(indent.replace(/\t/g, "  ").length / 2);
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let fence: { language: string; lines: string[] } | null = null;
  const lines = source.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fenceOpen = FENCE.exec(line);
    if (fence) {
      if (fenceOpen) {
        blocks.push({ kind: "code", ...fence });
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }

    if (fenceOpen) {
      fence = { language: fenceOpen[1], lines: [] };
      continue;
    }

    const opensTable = TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "");
    if (opensTable) {
      const header = cellsOf(line);
      const rule = cellsOf(lines[index + 1]);
      const body: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index])) body.push(cellsOf(lines[index++]));
      index--;
      blocks.push({ kind: "table", lines: renderTable(header, rule, body) });
      continue;
    }

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2]) });
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

  if (fence) blocks.push({ kind: "code", ...fence });
  return blocks;
}
