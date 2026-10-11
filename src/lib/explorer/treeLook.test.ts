import { describe, expect, it } from "vitest";
import type { GitStatus } from "@/lib/types";
import { activeGuideLevel, filteredListing, nameMatch, treeGitMarks } from "./treeLook";

function status(): GitStatus {
  return {
    repos: [
      {
        name: "app", branch: "main", kind: "host", dir_name: "", changed: 3, last_commit_message: "",
        staged: [{ status: "A", path: "e2e/new.test.ts", fp: "" }],
        unstaged: [
          { status: "M", path: "e2e/new.test.ts", fp: "" },
          { status: "M", path: "src/lib/a.ts", fp: "" },
          { status: "?", path: "notes.md", fp: "" },
        ],
      },
      {
        name: "api", branch: "main", kind: "worktree", dir_name: "api", changed: 1, last_commit_message: "",
        staged: [], unstaged: [{ status: "D", path: "old/gone.rs", fp: "" }],
      },
    ],
    total_changed: 4,
    repos_changed: 2,
  };
}

describe("treeGitMarks", () => {
  it("keeps a new file marked added after it is edited again", () => {
    expect(treeGitMarks(status()).marks.get("e2e/new.test.ts")).toBe("A");
  });

  it("marks untracked as added and edits as modified", () => {
    const { marks } = treeGitMarks(status());

    expect(marks.get("notes.md")).toBe("A");
    expect(marks.get("src/lib/a.ts")).toBe("M");
  });

  it("prefixes a member's paths with its folder", () => {
    expect(treeGitMarks(status()).marks.get("api/old/gone.rs")).toBe("D");
  });

  it("marks every folder above a change dirty, and nothing else", () => {
    const { dirty } = treeGitMarks(status());

    expect([...dirty].sort()).toEqual(["api", "api/old", "e2e", "src", "src/lib"]);
  });
});

describe("filteredListing", () => {
  const files = ["e2e/helpers.ts", "e2e/specs/sidebar.spec.ts", "src/App.tsx", "README.md"];

  it("lists matches with their folders, and drops the rest", () => {
    const listing = filteredListing(files, "help");

    expect(listing[""]).toEqual([{ name: "e2e", is_dir: true }]);
    expect(listing["e2e"]).toEqual([{ name: "helpers.ts", is_dir: false }]);
    expect(listing["src"]).toBeUndefined();
  });

  it("matches case-insensitively and puts folders first", () => {
    const listing = filteredListing(files, "A");

    expect(listing[""].map(entry => entry.name)).toEqual(["e2e", "src", "README.md"]);
  });
});

describe("nameMatch", () => {
  it("finds the query case-insensitively and spans its length", () => {
    expect(nameMatch("FixedWaits.test.ts", " wait ")).toEqual([5, 9]);
  });

  it("is null for an empty query or a name without it", () => {
    expect(nameMatch("helpers.ts", "  ")).toBeNull();
    expect(nameMatch("helpers.ts", "spec")).toBeNull();
  });
});

describe("activeGuideLevel", () => {
  it("lights the active folder's own guide for its children and everything below", () => {
    expect(activeGuideLevel("e2e/fixtures", "e2e/fixtures")).toBe(1);
    expect(activeGuideLevel("e2e/fixtures", "e2e/fixtures/iip")).toBe(1);
  });

  it("lights nothing outside the folder, for a sibling sharing its prefix, or at the root", () => {
    expect(activeGuideLevel("e2e/fixtures", "e2e")).toBe(-1);
    expect(activeGuideLevel("e2e/fix", "e2e/fixtures")).toBe(-1);
    expect(activeGuideLevel("", "src")).toBe(-1);
  });
});
