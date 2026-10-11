// The slice of markdown Claude Code draws in its terminal, parsed into plain
// data for the subagent view to turn into React elements. There is no HTML
// path anywhere: a tag in the text is text, and stays text.

export interface MarkdownSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  strike: boolean;
  link: boolean;
}

export type MarkdownBlock =
  | { kind: "paragraph"; spans: MarkdownSpan[] }
  | { kind: "heading"; level: number; spans: MarkdownSpan[] }
  | { kind: "bullet"; depth: number; indent: number; spans: MarkdownSpan[] }
  | { kind: "numbered"; depth: number; indent: number; marker: string; spans: MarkdownSpan[] }
  | { kind: "quote"; depth: number; spans: MarkdownSpan[] }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "table"; lines: string[] }
  | { kind: "blank" };

const INLINE = new RegExp([
  /(?<escape>\\[!-/:-@[-`{-~])/.source,
  /(?<code>`[^`\n]+`)/.source,
  /(?<link>\[(?<linkText>[^\]\n]+)\]\((?<linkHref>[^)\s]+)(?:\s+"[^"\n]*")?\))/.source,
  /(?<autolink><https?:\/\/[^>\s]+>)/.source,
  /(?<url>https?:\/\/[^\s<]*[^\s<.,:;"')\]])/.source,
  /(?<starBold>\*\*[^*\n]+\*\*)/.source,
  /(?<underBold>__[^_\n]+__)/.source,
  /(?<strike>~~[^~\n]+~~)/.source,
  /(?<![\w*])(?<starItalic>\*[^*\s][^*\n]*\*)(?!\w)/.source,
  /(?<!\w)(?<underItalic>_[^_\s][^_\n]*_)(?!\w)/.source,
].join("|"), "g");

function span(text: string, style: Partial<MarkdownSpan> = {}): MarkdownSpan {
  return { text, bold: false, italic: false, code: false, strike: false, link: false, ...style };
}

function styledSpan(token: string, groups: Record<string, string | undefined>): MarkdownSpan {
  if (groups.escape) return span(token.slice(1));
  if (groups.code) return span(token.slice(1, -1), { code: true });
  if (groups.link) return span(groups.linkText ?? "", { link: true });
  if (groups.autolink) return span(token.slice(1, -1), { link: true });
  if (groups.url) return span(token, { link: true });
  if (groups.starBold || groups.underBold) return span(token.slice(2, -2), { bold: true });
  if (groups.strike) return span(token.slice(2, -2), { strike: true });
  return span(token.slice(1, -1), { italic: true });
}

export function parseInline(line: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let consumed = 0;

  for (const match of line.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > consumed) spans.push(span(line.slice(consumed, at)));

    spans.push(styledSpan(match[0], match.groups ?? {}));
    consumed = at + match[0].length;
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
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*((?:>\s?)+)(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** One open list while lines are read: where its items start in the
 *  source, where claude draws them, and how wide the last marker was, since
 *  a nested list sits one cell past its parent's marker. */
interface OpenList {
  sourceIndent: number;
  indent: number;
  ordered: boolean;
  start: number;
  items: number;
  markerWidth: number;
}

function indentWidth(indent: string): number {
  return indent.replace(/\t/g, "    ").length;
}

function letters(value: number): string {
  let remaining = value;
  let text = "";
  while (remaining > 0) {
    remaining--;
    text = String.fromCharCode(97 + (remaining % 26)) + text;
    remaining = Math.floor(remaining / 26);
  }
  return text;
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
  [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

function roman(value: number): string {
  let remaining = value;
  let text = "";
  for (const [amount, numeral] of ROMAN) {
    while (remaining >= amount) {
      text += numeral;
      remaining -= amount;
    }
  }
  return text;
}

/** Claude numbers an ordered list from its first item and counts on from
 *  there whatever the source says, in letters one level down and roman
 *  numerals two levels down. */
function orderedMarker(depth: number, start: number, number: number): string {
  const countsFromOne = start >= 1;
  if (depth === 1 && countsFromOne) return `${letters(number)}.`;
  if (depth === 2 && countsFromOne && number <= 3999) return `${roman(number)}.`;
  return `${number}.`;
}

function openListFor(lists: OpenList[], sourceIndent: number, ordered: boolean, start: number): { list: OpenList; depth: number } {
  while (lists.length > 0 && lists[lists.length - 1].sourceIndent > sourceIndent) lists.pop();

  const top = lists[lists.length - 1];
  const continuesTop = top !== undefined && top.sourceIndent === sourceIndent && top.ordered === ordered;
  if (continuesTop) return { list: top, depth: lists.length - 1 };

  const sameLevelOtherKind = top !== undefined && top.sourceIndent === sourceIndent;
  if (sameLevelOtherKind) lists.pop();

  const parent = lists[lists.length - 1];
  const indent = parent ? parent.indent + parent.markerWidth + 1 : 0;
  const list: OpenList = { sourceIndent, indent, ordered, start, items: 0, markerWidth: 1 };
  lists.push(list);
  return { list, depth: lists.length - 1 };
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let fence: { language: string; lines: string[] } | null = null;
  const lists: OpenList[] = [];
  const lines = source.replace(/^(?:[ \t]*\n)+/, "").split("\n");

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
      lists.length = 0;
      fence = { language: fenceOpen[1], lines: [] };
      continue;
    }

    const opensTable = TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "");
    if (opensTable) {
      lists.length = 0;
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
      lists.length = 0;
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2]) });

      // A heading always ends on one blank row, however many the source had.
      while (index + 1 < lines.length && lines[index + 1].trim() === "") index++;
      const isLast = index + 1 >= lines.length;
      if (!isLast) blocks.push({ kind: "blank" });
      continue;
    }

    if (RULE.test(line)) {
      lists.length = 0;
      blocks.push({ kind: "paragraph", spans: [span("---")] });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const { list, depth } = openListFor(lists, indentWidth(bullet[1]), false, 1);
      list.items++;
      list.markerWidth = 1;
      blocks.push({ kind: "bullet", depth, indent: list.indent, spans: parseInline(bullet[2]) });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      const { list, depth } = openListFor(lists, indentWidth(numbered[1]), true, Number(numbered[2]));
      const marker = orderedMarker(depth, list.start, list.start + list.items);
      list.items++;
      list.markerWidth = marker.length;
      blocks.push({ kind: "numbered", depth, indent: list.indent, marker, spans: parseInline(numbered[3]) });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      lists.length = 0;
      const depth = (quote[1].match(/>/g) ?? []).length;
      blocks.push({ kind: "quote", depth, spans: parseInline(quote[2]) });
      continue;
    }

    const continuesItem = lists.length > 0 && /^\s/.test(line);
    if (!continuesItem) lists.length = 0;
    blocks.push({ kind: "paragraph", spans: parseInline(line) });
  }

  if (fence) blocks.push({ kind: "code", ...fence });
  return blocks;
}
