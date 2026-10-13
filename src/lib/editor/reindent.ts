// Reindent a file to 3 spaces in the buffer when it opens (prefs
// editorReindentToThree, off by default). Nothing here touches disk: the
// editor applies the edits as one transaction and the file changes when the
// user saves.
//
// Two jobs kept apart so the pure half is testable without an editor:
// `detectSourceIndent` / `reindentEdits` work on a string, and `planReindent`
// supplies the syntax tree that says which lines must be left alone.

import type { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";

export type SourceIndent =
  | { kind: "tabs" }
  | { kind: "spaces"; size: 2 | 3 | 4 | 8 };

export interface IndentEdit {
  from: number;
  to: number;
  insert: string;
}

/** Registry names (lib/languages) of the languages this is allowed to touch.
 *  Everything else is skipped, including the ones where indentation means
 *  something (Python, YAML, Makefile, Go, Markdown). */
export const REINDENT_LANGUAGES: ReadonlySet<string> = new Set([
  "JavaScript", "TypeScript", "JSX", "TSX", "JSON",
  "CSS", "SCSS", "LESS", "HTML",
  "Rust", "C", "C++", "Java", "Kotlin", "Swift", "PHP", "Lua",
]);

export const MAX_REINDENT_CHARS = 1024 * 1024;

const TARGET_SIZE = 3;
const PARSE_BUDGET_MS = 80;
const CANDIDATE_SIZES = [2, 3, 4, 8];
/** Share of space-indented lines that must sit on a multiple of the detected
 *  size. Alignment lines break it a little, a different style breaks it a lot. */
const MIN_ALIGNED_SHARE = 0.8;

const PROTECTED_NODE = /^(String|StringLiteral|TemplateString|RawString|HeredocString|NowdocString|TextBlock|BlockComment|LineComment|Comment)$/;
const WHITESPACE_SENSITIVE_ELEMENT = /^<(pre|textarea)[\s>]/i;

/** Calls `visit` with the offsets of each line, terminator excluded. Handles
 *  \n, \r\n and a lone \r, the three CodeMirror splits on. */
function forEachLine(text: string, visit: (start: number, end: number) => void): void {
  const length = text.length;
  let start = 0;

  while (start <= length) {
    let end = start;
    while (end < length) {
      const code = text.charCodeAt(end);
      if (code === 10 || code === 13) break;
      end++;
    }

    visit(start, end);

    const isCrlf = text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10;
    start = end + (isCrlf ? 2 : 1);
  }
}

function leadEndOf(text: string, start: number, end: number): number {
  let index = start;
  while (index < end) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9) break;
    index++;
  }
  return index;
}

/** Reads what the file is indented with, or null when it cannot say: no
 *  indentation, tabs and spaces both used, or no one width clearly wins.
 *  Only INDENT steps vote. A dedent can drop any number of levels at once, so
 *  it says nothing about the width of one. */
export function detectSourceIndent(text: string): SourceIndent | null {
  let tabLines = 0;
  let spaceLines = 0;
  let previousIndent = 0;
  const indents: number[] = [];
  const votes = new Map<number, number>();

  forEachLine(text, (start, end) => {
    const leadEnd = leadEndOf(text, start, end);
    const isBlank = leadEnd === end;
    if (isBlank) return;

    const isCommentContinuation = text.charCodeAt(leadEnd) === 42;
    if (isCommentContinuation) return;

    const lead = text.slice(start, leadEnd);
    const hasTab = lead.includes("\t");
    if (hasTab) {
      tabLines++;
      previousIndent = 0;
      return;
    }

    const indent = lead.length;
    const isIndented = indent >= 2;
    if (isIndented) {
      spaceLines++;
      indents.push(indent);
    }

    const step = indent - previousIndent;
    const isIndentStep = step > 0 && indent > 0;
    if (isIndentStep) votes.set(step, (votes.get(step) ?? 0) + 1);
    previousIndent = indent;
  });

  const isMixed = tabLines > 0 && spaceLines > 0;
  if (isMixed) return null;
  if (tabLines > 0) return { kind: "tabs" };

  let bestSize = 0;
  let bestVotes = 0;
  let runnerUpVotes = 0;
  for (const [size, count] of votes) {
    if (count > bestVotes) {
      runnerUpVotes = bestVotes;
      bestVotes = count;
      bestSize = size;
    } else if (count > runnerUpVotes) {
      runnerUpVotes = count;
    }
  }

  const hasEvidence = bestVotes >= 2;
  const isKnownSize = CANDIDATE_SIZES.includes(bestSize);
  const isClearWinner = runnerUpVotes * 2 <= bestVotes;
  if (!hasEvidence || !isKnownSize || !isClearWinner) return null;

  const alignedLines = indents.filter(indent => indent % bestSize === 0).length;
  const isAligned = alignedLines >= indents.length * MIN_ALIGNED_SHARE;
  if (!isAligned) return null;

  return { kind: "spaces", size: bestSize as 2 | 3 | 4 | 8 };
}

/** The edits that move `text` from `from` to 3 spaces. Only the leading
 *  whitespace of a line is replaced, so content, blank lines, line endings and
 *  a missing trailing newline are never touched. `isProtected` is asked about
 *  each candidate line (its start and first non-space offset) and a true
 *  answer leaves that line alone. */
export function reindentEdits(
  text: string,
  from: SourceIndent,
  isProtected?: (lineStart: number, leadEnd: number) => boolean,
): IndentEdit[] {
  const edits: IndentEdit[] = [];
  const isAlreadyTarget = from.kind === "spaces" && from.size === TARGET_SIZE;
  if (isAlreadyTarget) return edits;

  forEachLine(text, (start, end) => {
    const leadEnd = leadEndOf(text, start, end);
    const isBlank = leadEnd === end;
    const isFlush = leadEnd === start;
    if (isBlank || isFlush) return;

    const lead = text.slice(start, leadEnd);
    const hasTab = lead.includes("\t");
    const isLeftAlone = isProtected?.(start, leadEnd) ?? false;
    if (isLeftAlone) return;

    if (from.kind === "tabs") {
      const tabCount = /^\t*/.exec(lead)![0].length;
      if (tabCount === 0) return;

      edits.push({ from: start, to: start + tabCount, insert: " ".repeat(tabCount * TARGET_SIZE) });
      return;
    }

    if (hasTab) return;

    const levels = Math.floor(lead.length / from.size);
    const remainder = lead.length % from.size;
    const insert = " ".repeat(levels * TARGET_SIZE + remainder);
    if (insert === lead) return;

    edits.push({ from: start, to: leadEnd, insert });
  });

  return edits;
}

export function applyEdits(text: string, edits: readonly IndentEdit[]): string {
  let result = "";
  let cursor = 0;

  for (const edit of edits) {
    result += text.slice(cursor, edit.from) + edit.insert;
    cursor = edit.to;
  }

  return result + text.slice(cursor);
}

export function reindentToThree(
  text: string,
  from: SourceIndent,
  isProtected?: (lineStart: number, leadEnd: number) => boolean,
): string {
  return applyEdits(text, reindentEdits(text, from, isProtected));
}

/** Lines of the three languages whose grammar is a CodeMirror 5 stream
 *  tokenizer (Kotlin, Swift, Lua) cannot be asked, because a stream token
 *  never crosses a line and so never covers the start of a continuation line.
 *  A small scanner finds the multi-line strings and comments instead. */
function streamProtection(text: string, languageId: string): (lineStart: number, leadEnd: number) => boolean {
  const spans: Array<[number, number]> = [];
  const isLua = languageId === "Lua";
  const length = text.length;
  let index = 0;

  const isBreak = (code: number) => code === 10 || code === 13;

  const endOfLine = (from: number): number => {
    let cursor = from;
    while (cursor < length && !isBreak(text.charCodeAt(cursor))) cursor++;
    return cursor;
  };

  const recordSpan = (open: number, close: number) => {
    for (let cursor = open; cursor < close; cursor++) {
      if (isBreak(text.charCodeAt(cursor))) {
        spans.push([open, close]);
        return;
      }
    }
  };

  const skipQuoted = (open: number, quote: string): number => {
    let cursor = open + 1;
    while (cursor < length) {
      const char = text[cursor];
      if (char === "\\") { cursor += 2; continue; }
      if (char === quote) return cursor + 1;
      if (isBreak(text.charCodeAt(cursor))) return cursor;
      cursor++;
    }
    return length;
  };

  const skipLongBracket = (open: number, bracketAt: number): number | null => {
    longBracket.lastIndex = bracketAt;
    const bracket = longBracket.exec(text);
    if (!bracket) return null;

    const closer = `]${bracket[1]}]`;
    const closeAt = text.indexOf(closer, longBracket.lastIndex);
    const stop = closeAt === -1 ? length : closeAt + closer.length;
    recordSpan(open, stop);
    return stop;
  };

  const longBracket = /\[(=*)\[/y;

  while (index < length) {
    const char = text[index];
    const next = text[index + 1];

    if (isLua) {
      const isComment = char === "-" && next === "-";
      if (isComment) {
        const stop = skipLongBracket(index, index + 2);
        index = stop ?? endOfLine(index);
        continue;
      }

      if (char === "[") {
        const stop = skipLongBracket(index, index);
        if (stop !== null) {
          index = stop;
          continue;
        }
      }

      const isLuaQuote = char === "\"" || char === "'";
      if (isLuaQuote) {
        const stop = skipQuoted(index, char);
        recordSpan(index, stop);
        index = stop;
        continue;
      }

      index++;
      continue;
    }

    const isLineComment = char === "/" && next === "/";
    if (isLineComment) {
      index = endOfLine(index);
      continue;
    }

    const isBlockComment = char === "/" && next === "*";
    if (isBlockComment) {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < length && depth > 0) {
        const isOpen = text[cursor] === "/" && text[cursor + 1] === "*";
        const isClose = text[cursor] === "*" && text[cursor + 1] === "/";
        if (isOpen) { depth++; cursor += 2; continue; }
        if (isClose) { depth--; cursor += 2; continue; }
        cursor++;
      }
      recordSpan(index, cursor);
      index = cursor;
      continue;
    }

    const opensString = char === "\"" || char === "#" || char === "'";
    if (!opensString) {
      index++;
      continue;
    }

    let quoteAt = index;
    while (text[quoteAt] === "#") quoteAt++;
    const hashes = text.slice(index, quoteAt);
    const isTripleQuote = text.startsWith("\"\"\"", quoteAt);
    if (isTripleQuote) {
      const closer = "\"\"\"" + hashes;
      const closeAt = text.indexOf(closer, quoteAt + 3);
      const stop = closeAt === -1 ? length : closeAt + closer.length;
      recordSpan(index, stop);
      index = stop;
      continue;
    }

    const isQuote = text[quoteAt] === "\"" || text[quoteAt] === "'";
    index = isQuote ? skipQuoted(quoteAt, text[quoteAt]) : index + 1;
  }

  return (lineStart: number) => spans.some(([open, close]) => open < lineStart && lineStart < close);
}

const STREAM_LANGUAGES: ReadonlySet<string> = new Set(["Kotlin", "Swift", "Lua"]);

function treeProtection(state: EditorState, languageId: string): ((lineStart: number, leadEnd: number) => boolean) | null {
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS);
  if (!tree) return null;

  const isPhp = languageId === "PHP";

  return (lineStart, leadEnd) => {
    for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(leadEnd, 1); node; node = node.parent) {
      const startsBeforeLine = node.from < lineStart;
      if (!startsBeforeLine) continue;

      const isProtectedName = PROTECTED_NODE.test(node.name) || (isPhp && node.name === "Text");
      if (isProtectedName) return true;

      const isElement = node.name === "Element";
      const isPreformatted = isElement && WHITESPACE_SENSITIVE_ELEMENT.test(state.sliceDoc(node.from, node.from + 12));
      if (isPreformatted) return true;
    }
    return false;
  };
}

export interface ReindentPlan {
  edits: IndentEdit[];
  from: SourceIndent;
}

/** What to change in `state` (already holding its language) to reindent it, or
 *  null when it should be left alone: a language outside the allow list, too
 *  large, no clear indentation or already 3, or a parse that did not finish
 *  inside the budget. */
export function planReindent(state: EditorState, languageId: string): ReindentPlan | null {
  const isAllowed = REINDENT_LANGUAGES.has(languageId);
  const isTooLarge = state.doc.length > MAX_REINDENT_CHARS;
  if (!isAllowed || isTooLarge) return null;

  const text = state.doc.toString();
  const from = detectSourceIndent(text);
  if (!from) return null;

  const isAlreadyTarget = from.kind === "spaces" && from.size === TARGET_SIZE;
  if (isAlreadyTarget) return null;

  const isStream = STREAM_LANGUAGES.has(languageId);
  const protection = isStream ? streamProtection(text, languageId) : treeProtection(state, languageId);
  if (!protection) return null;

  const edits = reindentEdits(text, from, protection);
  if (edits.length === 0) return null;

  return { edits, from };
}
