import { isPureCrlf } from "@/lib/lineEndings";

export interface ExcerptMatch {
  path: string;
  /** 1-based line of the hit. */
  line: number;
}

export interface Excerpt {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Edited lines joined with `\n`, no trailing break. */
  text: string;
  /** The file's lines over the same range when the excerpt was built. */
  baseText: string;
}

export type SaveTarget =
  | { path: string; status: "write"; content: string }
  | { path: string; status: "conflict" };

interface SplitFile {
  lines: string[];
  eol: string;
  hasTrailingNewline: boolean;
}

function splitFile(text: string): SplitFile {
  const eol = isPureCrlf(text) ? "\r\n" : "\n";
  const parts = text.split(eol);
  const endsWithBreak = parts.length > 1 && parts[parts.length - 1] === "";
  const lines = endsWithBreak ? parts.slice(0, -1) : parts;
  const isEmptyFile = text === "";

  return { lines: isEmptyFile ? [] : lines, eol, hasTrailingNewline: endsWithBreak };
}

function joinFile({ lines, eol, hasTrailingNewline }: SplitFile): string {
  const body = lines.join(eol);
  const needsBreak = hasTrailingNewline && lines.length > 0;

  return needsBreak ? body + eol : body;
}

export function buildExcerpts(
  matches: ExcerptMatch[],
  fileTexts: Record<string, string>,
  context = 3,
): Excerpt[] {
  const linesByPath = new Map<string, Set<number>>();

  for (const match of matches) {
    const known = linesByPath.get(match.path);
    if (known) known.add(match.line);
    else linesByPath.set(match.path, new Set([match.line]));
  }

  const excerpts: Excerpt[] = [];

  for (const [path, hitLines] of linesByPath) {
    const fileText = fileTexts[path];
    if (fileText === undefined) continue;

    const { lines } = splitFile(fileText);
    const validHits = [...hitLines]
      .filter((line) => Number.isInteger(line) && line >= 1 && line <= lines.length)
      .sort((a, b) => a - b);

    const ranges: Array<[number, number]> = [];

    for (const hit of validHits) {
      const start = Math.max(1, hit - context);
      const end = Math.min(lines.length, hit + context);
      const last = ranges[ranges.length - 1];
      const touchesLast = last !== undefined && start <= last[1] + 1;

      if (touchesLast) last[1] = Math.max(last[1], end);
      else ranges.push([start, end]);
    }

    for (const [startLine, endLine] of ranges) {
      const baseText = lines.slice(startLine - 1, endLine).join("\n");
      excerpts.push({ path, startLine, endLine, text: baseText, baseText });
    }
  }

  return excerpts;
}

function editedLines(text: string, eol: string): string[] {
  const separator = eol === "\r\n" ? /\r?\n/ : "\n";

  return text.split(separator);
}

export function spliceExcerpts(fileText: string, excerpts: Excerpt[]): string {
  const file = splitFile(fileText);
  const bottomUp = [...excerpts].sort((a, b) => b.startLine - a.startLine);

  for (const excerpt of bottomUp) {
    const removeCount = excerpt.endLine - excerpt.startLine + 1;
    file.lines.splice(excerpt.startLine - 1, removeCount, ...editedLines(excerpt.text, file.eol));
  }

  return joinFile(file);
}

function matchesBase(diskLines: string[], excerpt: Excerpt): boolean {
  const current = diskLines.slice(excerpt.startLine - 1, excerpt.endLine).join("\n");
  const rangeInBounds = excerpt.endLine <= diskLines.length;

  return rangeInBounds && current === excerpt.baseText;
}

export function saveTargets(
  excerpts: Excerpt[],
  diskTexts: Record<string, string>,
): SaveTarget[] {
  const excerptsByPath = new Map<string, Excerpt[]>();

  for (const excerpt of excerpts) {
    const group = excerptsByPath.get(excerpt.path);
    if (group) group.push(excerpt);
    else excerptsByPath.set(excerpt.path, [excerpt]);
  }

  const targets: SaveTarget[] = [];

  for (const [path, group] of excerptsByPath) {
    const isEdited = group.some((excerpt) => excerpt.text !== excerpt.baseText);
    if (!isEdited) continue;

    const diskText = diskTexts[path];
    if (diskText === undefined) {
      targets.push({ path, status: "conflict" });
      continue;
    }

    const { lines } = splitFile(diskText);
    const isStale = group.some((excerpt) => !matchesBase(lines, excerpt));

    if (isStale) targets.push({ path, status: "conflict" });
    else targets.push({ path, status: "write", content: spliceExcerpts(diskText, group) });
  }

  return targets;
}
