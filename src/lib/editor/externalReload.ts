export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** The text as CodeMirror's document sees it: every break is one `\n`. */
export function toDocSpace(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The smallest single replacement that turns `before` into `after`, or null
 *  when they are equal. Keeps the selection and scroll of everything outside
 *  the changed span, which a whole-document replace would throw away. */
export function minimalChange(before: string, after: string): TextChange | null {
  if (before === after) return null;

  const shortest = Math.min(before.length, after.length);

  let prefix = 0;
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  const maxSuffix = shortest - prefix;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: before.length - suffix,
    insert: after.slice(prefix, after.length - suffix),
  };
}

const MISSING_FILE_PATTERN = /no such file|os error 2\b|os error 3\b|not found/i;

export function isMissingFileError(error: unknown): boolean {
  return MISSING_FILE_PATTERN.test(String(error));
}

/** Monotonic ticket for async reads: only the newest one may apply. */
export function createReadTicket() {
  let latest = 0;

  return {
    next: () => ++latest,
    isLatest: (ticket: number) => ticket === latest,
  };
}

export type DiskAction = "adopt" | "ignore" | "unchanged" | "replace" | "merge";

/** What to do with freshly read disk text, all in document space. `ignore` is
 *  the echo of this editor's own write in flight, `unchanged` is disk still
 *  holding the base (a reindented or edited buffer differing from disk is then
 *  our own doing, not an outside change), `adopt` is disk equal to the buffer. */
export function decideDiskAction(input: {
  disk: string;
  buffer: string;
  base: string;
  inFlightWrite: string | null;
  isDirty: boolean;
}): DiskAction {
  if (input.disk === input.buffer) return "adopt";
  if (input.disk === input.inFlightWrite) return "ignore";
  if (input.disk === input.base) return "unchanged";

  return input.isDirty ? "merge" : "replace";
}

/** Runs a write so that any disk read in flight across it is dropped: the
 *  ticket moves when the write starts and again when it ends, so a read that
 *  began before the save cannot resolve after it and put old text back. */
export function guardWriteAgainstStaleReads<T>(
  tickets: ReturnType<typeof createReadTicket>,
  write: () => Promise<T>,
): Promise<T> {
  tickets.next();

  return write().finally(() => {
    tickets.next();
  });
}
