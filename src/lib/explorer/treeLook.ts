// How a file tree row looks beyond its icon and name: the git mark a changed
// path carries, and which entries draw dimmer (the right panel's "All files"
// tab).

import type { GitStatus } from "@/lib/types";

export type TreeGitMark = "A" | "M" | "D";

/** True for folders that hold tooling rather than the project's own code:
 *  dot-folders and node_modules. They draw dimmer than the rest. */
export function isQuietEntry(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

const MARK_RANK: Record<TreeGitMark, number> = { D: 0, M: 1, A: 2 };

function markFor(status: string): TreeGitMark {
  const isNew = status === "A" || status === "?";

  if (isNew) return "A";
  if (status === "D") return "D";

  return "M";
}

/** Task-relative path to its git mark, plus every folder that holds one.
 *  A file staged as added and edited since stays "A": it is still new. */
export function treeGitMarks(status: GitStatus | null): { marks: Map<string, TreeGitMark>; dirty: Set<string> } {
  const marks = new Map<string, TreeGitMark>();
  const dirty = new Set<string>();

  for (const repo of status?.repos ?? []) {
    const prefix = repo.dir_name ? `${repo.dir_name}/` : "";

    for (const file of [...repo.staged, ...repo.unstaged]) {
      const rel = prefix + file.path.replace(/\/$/, "");
      const next = markFor(file.status);
      const current = marks.get(rel);
      const outranks = !current || MARK_RANK[next] > MARK_RANK[current];

      if (outranks) marks.set(rel, next);

      const parts = rel.split("/");

      for (let depth = 1; depth < parts.length; depth++) {
        dirty.add(parts.slice(0, depth).join("/"));
      }
    }
  }

  return { marks, dirty };
}

/** The colour a git mark paints its row's name and letter in. */
export function gitMarkColor(mark: TreeGitMark): string {
  if (mark === "A") return "var(--ui-git-added)";
  if (mark === "D") return "var(--ui-git-deleted)";

  return "var(--ui-git-modified)";
}

/** Paths to show while the tree is filtered: every file whose name, or any
 *  of whose folders' names, contains the query, with all their ancestors.
 *  Returned as a listing per folder, the shape the tree renders from. */
export function filteredListing(files: readonly string[], query: string): Record<string, { name: string; is_dir: boolean }[]> {
  const needle = query.trim().toLowerCase();
  const listing: Record<string, { name: string; is_dir: boolean }[]> = { "": [] };
  const seen = new Set<string>();

  if (!needle) return listing;

  for (const path of files) {
    const parts = path.split("/");
    const matchAt = parts.findIndex(part => part.toLowerCase().includes(needle));

    if (matchAt === -1) continue;

    for (let depth = 0; depth < parts.length; depth++) {
      const rel = parts.slice(0, depth + 1).join("/");

      if (seen.has(rel)) continue;

      seen.add(rel);
      const parent = parts.slice(0, depth).join("/");
      const isDir = depth < parts.length - 1;

      (listing[parent] ??= []).push({ name: parts[depth], is_dir: isDir });
      if (isDir) listing[rel] ??= [];
    }
  }

  for (const entries of Object.values(listing)) {
    entries.sort((left, right) => Number(right.is_dir) - Number(left.is_dir) || left.name.localeCompare(right.name));
  }

  return listing;
}

/** Where a filter query sits in a name, as [start, end), or null when it
 *  does not. Case-insensitive, like the filter itself. */
export function nameMatch(name: string, query: string): [number, number] | null {
  const needle = query.trim().toLowerCase();

  if (!needle) return null;

  const start = name.toLowerCase().indexOf(needle);

  if (start === -1) return null;

  return [start, start + needle.length];
}

/** Which indent guide to light for a row whose folder is `parentRel`: the
 *  level of `activeDir`'s children when the row sits anywhere below it, -1
 *  otherwise. `activeDir` is the folder holding the selection ("" is the
 *  root, whose children draw no guide). */
export function activeGuideLevel(activeDir: string | null, parentRel: string): number {
  if (!activeDir) return -1;

  const isInside = parentRel === activeDir || parentRel.startsWith(`${activeDir}/`);

  if (!isInside) return -1;

  return activeDir.split("/").length - 1;
}
