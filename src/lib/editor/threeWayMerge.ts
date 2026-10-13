export type MergeResult =
  | { conflict: false; text: string }
  | { conflict: true; text: string };

const MAX_LCS_CELLS = 4_000_000;

function pickLineEnding(...samples: string[]): string {
  for (const sample of samples) {
    const hasNewline = sample.includes("\n");
    if (!hasNewline) continue;

    return sample.includes("\r\n") ? "\r\n" : "\n";
  }

  return "\n";
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function sameLines(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

/** Pairs of equal line indices, ascending in both arrays, or null when the
 *  middle after trimming is too large for the table. */
function matchLines(base: string[], other: string[]): Map<number, number> | null {
  const matches = new Map<number, number>();
  const shortest = Math.min(base.length, other.length);

  let prefix = 0;
  while (prefix < shortest && base[prefix] === other[prefix]) {
    matches.set(prefix, prefix);
    prefix++;
  }

  let suffix = 0;
  const maxSuffix = shortest - prefix;
  while (suffix < maxSuffix && base[base.length - 1 - suffix] === other[other.length - 1 - suffix]) {
    matches.set(base.length - 1 - suffix, other.length - 1 - suffix);
    suffix++;
  }

  const baseMiddle = base.length - prefix - suffix;
  const otherMiddle = other.length - prefix - suffix;
  const hasMiddle = baseMiddle > 0 && otherMiddle > 0;
  if (!hasMiddle) return matches;

  const cells = (baseMiddle + 1) * (otherMiddle + 1);
  if (cells > MAX_LCS_CELLS) return null;

  const width = otherMiddle + 1;
  const table = new Uint32Array(cells);
  for (let row = baseMiddle - 1; row >= 0; row--) {
    for (let col = otherMiddle - 1; col >= 0; col--) {
      const isEqual = base[prefix + row] === other[prefix + col];
      const diagonal = table[(row + 1) * width + col + 1];
      const below = table[(row + 1) * width + col];
      const right = table[row * width + col + 1];
      table[row * width + col] = isEqual ? diagonal + 1 : Math.max(below, right);
    }
  }

  let row = 0;
  let col = 0;
  while (row < baseMiddle && col < otherMiddle) {
    const isEqual = base[prefix + row] === other[prefix + col];
    if (isEqual) {
      matches.set(prefix + row, prefix + col);
      row++;
      col++;
      continue;
    }

    const below = table[(row + 1) * width + col];
    const right = table[row * width + col + 1];
    if (below >= right) row++;
    else col++;
  }

  return matches;
}

/** Line based diff3. Regions that only one side changed merge; a region both
 *  sides changed to different text is a conflict, and the result is `ours`. */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  const lineEnding = pickLineEnding(ours, theirs, base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);

  const oursEqualsTheirs = sameLines(ourLines, theirLines);
  if (oursEqualsTheirs) return { conflict: false, text: ours };

  const baseLines = splitLines(base);
  const oursMatches = matchLines(baseLines, ourLines);
  const theirsMatches = matchLines(baseLines, theirLines);
  const isTooLarge = oursMatches === null || theirsMatches === null;
  if (isTooLarge) return { conflict: true, text: ours };

  const merged: string[] = [];
  let baseCursor = 0;
  let ourCursor = 0;
  let theirCursor = 0;
  let hasConflict = false;

  const settleRegion = (baseEnd: number, ourEnd: number, theirEnd: number) => {
    const baseRegion = baseLines.slice(baseCursor, baseEnd);
    const ourRegion = ourLines.slice(ourCursor, ourEnd);
    const theirRegion = theirLines.slice(theirCursor, theirEnd);

    const oursUntouched = sameLines(ourRegion, baseRegion);
    const theirsUntouched = sameLines(theirRegion, baseRegion);
    const bothAgree = sameLines(ourRegion, theirRegion);

    if (oursUntouched) merged.push(...theirRegion);
    else if (theirsUntouched || bothAgree) merged.push(...ourRegion);
    else {
      hasConflict = true;
      merged.push(...ourRegion);
    }
  };

  for (let baseIndex = 0; baseIndex < baseLines.length; baseIndex++) {
    const ourIndex = oursMatches.get(baseIndex);
    const theirIndex = theirsMatches.get(baseIndex);
    const isStable = ourIndex !== undefined && theirIndex !== undefined;
    if (!isStable) continue;

    settleRegion(baseIndex, ourIndex, theirIndex);
    merged.push(baseLines[baseIndex]);
    baseCursor = baseIndex + 1;
    ourCursor = ourIndex + 1;
    theirCursor = theirIndex + 1;
  }

  settleRegion(baseLines.length, ourLines.length, theirLines.length);

  if (hasConflict) return { conflict: true, text: ours };

  return { conflict: false, text: merged.join(lineEnding) };
}
