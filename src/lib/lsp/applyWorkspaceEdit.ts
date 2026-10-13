// Applying a language server's WorkspaceEdit (GH #174).
//
// Rename and code actions both end in one: a set of text edits spread over
// several files, in either of the two shapes the protocol allows. The client
// library's own rename only handles `changes`, and silently skips every file
// that has no editor, which for a rename is most of the files. This is the one
// place that applies the whole thing, so the two features cannot disagree
// about what "applied" means.
//
// Pure on purpose. Where an open file's buffer lives and how a closed file is
// read and written are passed in (`EditTargets`), which is what lets the unit
// test drive every branch without an editor or an IPC bridge.

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspTextEdit { range: LspRange; newText: string }

interface TextDocumentEdit {
  textDocument: { uri: string };
  edits: LspTextEdit[];
}

interface ResourceOperation {
  kind: "create" | "rename" | "delete";
  uri?: string;
  oldUri?: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | ResourceOperation>;
}

export interface EditTargets {
  /** Apply to the editor showing this file. False when nothing has it open. */
  applyOpen(uri: string, edits: LspTextEdit[]): boolean;
  read(uri: string): Promise<string | null>;
  write(uri: string, text: string): Promise<void>;
}

/** Why a file was not changed. The two named ones are ours and get a
 *  translated sentence; anything else is the error's own text. */
export type FailureReason = "file-operation" | "unreadable" | (string & {});

export interface ApplyResult {
  applied: string[];
  failed: Array<{ uri: string; reason: FailureReason }>;
}

/** The edit as one list per file, whichever shape it arrived in. Resource
 *  operations (create, rename, delete a file) are not text edits and are not
 *  applied; they come back as `unsupported` so the caller can say so. */
export function editsByUri(edit: LspWorkspaceEdit): {
  byUri: Map<string, LspTextEdit[]>;
  unsupported: string[];
} {
  const byUri = new Map<string, LspTextEdit[]>();
  const unsupported: string[] = [];
  const add = (uri: string, edits: LspTextEdit[]) => {
    byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);

  for (const change of edit.documentChanges ?? []) {
    const isTextEdit = "textDocument" in change;
    if (isTextEdit) {
      add(change.textDocument.uri, change.edits);
      continue;
    }
    unsupported.push(`${change.kind} ${change.uri ?? change.oldUri ?? ""}`.trim());
  }

  return { byUri, unsupported };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const isCrlf = char === "\r" && text[index + 1] === "\n";
    if (isCrlf) index++;
    const isBreak = char === "\n" || char === "\r";
    if (isBreak) starts.push(index + 1);
  }
  return starts;
}

/** A position as an offset into `text`, clamped the way the protocol asks:
 *  a line past the end is the end, a character past the line is its end. */
export function offsetAt(text: string, starts: number[], pos: LspPosition): number {
  const isPastEnd = pos.line >= starts.length;
  if (isPastEnd) return text.length;

  const lineStart = starts[pos.line];
  const hasNextLine = pos.line + 1 < starts.length;
  let contentEnd = text.length;
  if (hasNextLine) {
    contentEnd = starts[pos.line + 1] - 1;
    const endsWithCrlf = text[contentEnd - 1] === "\r" && text[contentEnd] === "\n";
    if (endsWithCrlf) contentEnd--;
  }

  return Math.min(lineStart + pos.character, contentEnd);
}

/**
 * Apply edits to a string, last position first.
 *
 * Every range in a set of edits is expressed against the ORIGINAL text, so
 * applying them front to back would shift everything after the first one.
 * Back to front leaves the offsets of the edits still to come untouched. Two
 * inserts at one position keep the order they were sent in. Edits that overlap
 * are a malformed answer and throw, rather than producing a mangled file.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const starts = lineStarts(text);
  const resolved = edits.map((edit, order) => ({
    from: offsetAt(text, starts, edit.range.start),
    to: offsetAt(text, starts, edit.range.end),
    insert: edit.newText,
    order,
  }));

  const ascending = [...resolved].sort((a, b) => a.from - b.from || a.order - b.order);
  for (let index = 1; index < ascending.length; index++) {
    const overlaps = ascending[index].from < ascending[index - 1].to;
    if (overlaps) throw new Error("the server sent overlapping edits");
  }

  let out = text;
  const descending = [...ascending].reverse();
  for (const edit of descending) {
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }
  return out;
}

/**
 * Apply a WorkspaceEdit: open files through their editor, everything else
 * through read, edit, write. One file failing does not stop the others, and
 * nothing is dropped quietly: every file that was not changed comes back in
 * `failed` with a reason.
 */
export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  targets: EditTargets,
): Promise<ApplyResult> {
  const { byUri, unsupported } = editsByUri(edit);
  const result: ApplyResult = { applied: [], failed: [] };

  for (const operation of unsupported) {
    result.failed.push({ uri: operation, reason: "file-operation" });
  }

  for (const [uri, edits] of byUri) {
    if (!edits.length) continue;

    try {
      const wasOpen = targets.applyOpen(uri, edits);
      if (wasOpen) {
        result.applied.push(uri);
        continue;
      }

      const text = await targets.read(uri);
      if (text == null) {
        result.failed.push({ uri, reason: "unreadable" });
        continue;
      }

      await targets.write(uri, applyTextEdits(text, edits));
      result.applied.push(uri);
    } catch (err) {
      result.failed.push({ uri, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
