import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  cosineFrameStops, countGroup, displayPath, formatElapsed, formatTokens, groupSummaryParts, lineDiff, spinnerMessage, spinnerSuffix, toolDisplay, toolSummary, transcriptStats, wordSpans,
} from "@/lib/subagentCliView";
import { toTranscriptRows } from "@/lib/subagentTranscript";

const WORKTREE = "/Users/u/dev/acme";

function input(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function ok(text: string) {
  return { text, isError: false };
}

describe("toolDisplay", () => {
  const shown = (name: string, fields: Record<string, unknown>) => {
    const display = toolDisplay(name, input(fields), WORKTREE);
    return display.args === "" ? display.label : `${display.label}(${display.args})`;
  };

  it("heads each built-in tool the way Claude Code does", () => {
    expect(shown("Read", { file_path: `${WORKTREE}/src/config.ts` })).toBe("Read(src/config.ts)");
    expect(shown("Write", { file_path: `${WORKTREE}/a.md`, content: "x" })).toBe("Write(a.md)");
    expect(shown("Edit", { file_path: `${WORKTREE}/a.ts` })).toBe("Update(a.ts)");
    expect(shown("MultiEdit", { file_path: `${WORKTREE}/a.ts`, edits: [] })).toBe("Update(a.ts)");
    expect(shown("Bash", { command: "npm run build", timeout: 5 })).toBe("Bash(npm run build)");
    expect(shown("Grep", { pattern: "port", path: `${WORKTREE}/src` })).toBe("Search(pattern: \"port\", path: \"src\")");
    expect(shown("Glob", { pattern: "**/*.ts" })).toBe("Search(pattern: \"**/*.ts\")");
    expect(shown("LS", { path: `${WORKTREE}/src` })).toBe("List(src)");
    expect(shown("WebFetch", { url: "https://acme.com", prompt: "read it" })).toBe("Fetch(https://acme.com)");
    expect(shown("WebSearch", { query: "acme release" })).toBe("Web Search(\"acme release\")");
    expect(shown("TodoWrite", { todos: [] })).toBe("Update Todos");
    expect(shown("Task", { description: "explore acme", prompt: "long" })).toBe("Task(explore acme)");
    expect(shown("Agent", { description: "explore acme" })).toBe("Task(explore acme)");
    expect(shown("NotebookEdit", { notebook_path: `${WORKTREE}/n.ipynb` })).toBe("Edit Notebook(n.ipynb)");
    expect(shown("Skill", { skill: "release" })).toBe("Skill(release)");
  });

  it("names an MCP tool by server and tool", () => {
    expect(shown("mcp__acme__find_issue", { id: 7, title: "x" })).toBe("acme - find_issue (MCP)(id: 7, title: \"x\")");
  });

  it("falls back to the flat values for a tool it does not know", () => {
    expect(shown("Frobnicate", { level: 3, mode: "fast" })).toBe("Frobnicate(3, fast)");
  });

  it("keeps a path outside the worktree whole, and clips a long command to one line", () => {
    expect(shown("Read", { file_path: "/Users/u/dev/other/a.ts" })).toBe("Read(/Users/u/dev/other/a.ts)");

    const long = toolDisplay("Bash", input({ command: `echo ${"x".repeat(400)}\nls` }), WORKTREE);
    expect(long.args.includes("\n")).toBe(false);
    expect(long.args.endsWith("...")).toBe(true);
  });
});

describe("displayPath", () => {
  it("does not treat a sibling directory with the same prefix as inside the worktree", () => {
    expect(displayPath("/Users/u/dev/acme-two/a.ts", WORKTREE)).toBe("/Users/u/dev/acme-two/a.ts");
    expect(displayPath(WORKTREE, `${WORKTREE}/`)).toBe(".");
  });
});

describe("lineDiff", () => {
  it("keeps common lines as context and marks the rest", () => {
    const diff = lineDiff("a\nb\nc", "a\nB\nc\nd");
    expect(diff.map(line => `${line.kind}:${line.text}`)).toEqual(["context:a", "remove:b", "add:B", "context:c", "add:d"]);
  });

  it("handles an empty side", () => {
    expect(lineDiff("", "x").map(line => line.kind)).toEqual(["add"]);
    expect(lineDiff("x", "").map(line => line.kind)).toEqual(["remove"]);
  });

  it("falls back to remove-all then add-all past the size cap", () => {
    const big = Array.from({ length: 600 }, (_, n) => `line ${n}`).join("\n");
    const diff = lineDiff(big, `${big}\nmore`);
    expect(diff.filter(line => line.kind === "remove")).toHaveLength(600);
    expect(diff.filter(line => line.kind === "add")).toHaveLength(601);
  });
});

describe("toolSummary", () => {
  it("is pending until a result arrives", () => {
    expect(toolSummary("Read", "{}", null, WORKTREE)).toEqual({ kind: "pending" });
  });

  it("puts an error's lines first, with the tool_use_error tags gone", () => {
    const summary = toolSummary("Bash", "{}", { text: "<tool_use_error>2 tests failed\nat x</tool_use_error>", isError: true }, null);
    expect(summary).toEqual({ kind: "error", lines: ["2 tests failed", "at x"] });
  });

  it("counts lines read, without a trailing system reminder", () => {
    const text = "     1\u2192one\n     2\u2192two\n\n<system-reminder>\nnote\n</system-reminder>";
    expect(toolSummary("Read", "{}", ok(text), null)).toEqual({ kind: "readLines", count: 2 });
  });

  it("counts files found from the header, a none message, or the listed paths", () => {
    expect(toolSummary("Grep", "{}", ok("Found 3 files\na\nb\nc"), null)).toEqual({ kind: "foundFiles", count: 3 });
    expect(toolSummary("Glob", "{}", ok("No files found"), null)).toEqual({ kind: "foundFiles", count: 0 });
    expect(toolSummary("Glob", "{}", ok("/a.ts\n/b.ts\n"), null)).toEqual({ kind: "foundFiles", count: 2 });
  });

  it("builds the checklist from the TodoWrite input", () => {
    const todos = input({ todos: [
      { content: "Read config", status: "completed" },
      { content: "Change the port", status: "in_progress" },
      { content: "Run the build", status: "pending" },
      { content: "Odd", status: "later" },
      { status: "completed" },
    ] });
    const summary = toolSummary("TodoWrite", todos, ok("Todos have been modified"), null);
    expect(summary).toEqual({ kind: "todos", todos: [
      { content: "Read config", status: "completed" },
      { content: "Change the port", status: "in_progress" },
      { content: "Run the build", status: "pending" },
      { content: "Odd", status: "pending" },
    ] });
  });

  it("reports a Write with its line count and the lines written", () => {
    const summary = toolSummary("Write", input({ file_path: `${WORKTREE}/notes.md`, content: "a\nb\n" }), ok("File created"), WORKTREE);
    expect(summary).toEqual({ kind: "wrote", path: "notes.md", count: 2, lines: ["a", "b"] });
  });

  it("diffs an Edit and numbers it from the snippet in the result", () => {
    const edit = input({
      file_path: `${WORKTREE}/src/config.ts`,
      old_string: "const port = 3000",
      new_string: "const port = 4000\nconst host = \"localhost\"",
    });
    const snippet = "The file has been updated. Here's the result:\n    11\t// config\n    12\tconst port = 4000\n    13\tconst host = \"localhost\"";
    const summary = toolSummary("Edit", edit, ok(snippet), WORKTREE);

    expect(summary.kind).toBe("updated");
    if (summary.kind !== "updated") return;
    expect(summary).toMatchObject({ path: "src/config.ts", additions: 2, removals: 1 });
    expect(summary.diff.map(line => [line.lineNumber, line.kind])).toEqual([[12, "remove"], [12, "add"], [13, "add"]]);
  });

  it("diffs every edit of a MultiEdit and leaves lines unnumbered when the snippet does not show them", () => {
    const edits = input({ file_path: "/x.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "" }] });
    const summary = toolSummary("MultiEdit", edits, ok("Applied 2 edits"), null);

    expect(summary).toMatchObject({ kind: "updated", additions: 1, removals: 2 });
    if (summary.kind !== "updated") return;
    expect(summary.diff.every(line => line.lineNumber === null)).toBe(true);
  });

  it("shows any other output as its lines, and says when there is none", () => {
    expect(toolSummary("Bash", "{}", ok("> acme@1.0.0 build\n> vite build\n"), null))
      .toEqual({ kind: "output", lines: ["> acme@1.0.0 build", "> vite build"] });
    expect(toolSummary("Bash", "{}", ok("  \n"), null)).toEqual({ kind: "noContent" });
  });
});

describe("formatElapsed and formatTokens", () => {
  it("prints times the way Claude Code does", () => {
    expect(formatElapsed(42_400)).toBe("42s");
    expect(formatElapsed(63_000)).toBe("1m 3s");
    expect(formatElapsed(2 * 3600_000 + 5 * 60_000)).toBe("2h 5m 0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(119_600)).toBe("2m 0s");
    expect(formatElapsed(3 * 86_400_000 + 4 * 3600_000 + 7 * 60_000)).toBe("3d 4h 7m");
    expect(formatElapsed(-5)).toBe("0s");
  });

  it("prints token counts short", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(3_100)).toBe("3.1k");
    expect(formatTokens(1_000)).toBe("1.0k");
    expect(formatTokens(34_000)).toBe("34.0k");
    expect(formatTokens(233_840)).toBe("233.8k");
    expect(formatTokens(999_960)).toBe("1.0m");
    expect(formatTokens(1_200_000)).toBe("1.2m");
  });
});

describe("transcriptStats", () => {
  it("counts tool calls, sums output tokens, and spans the timestamps", () => {
    const rows = toTranscriptRows([
      { kind: "userText", text: "go", truncated: false, name: null, isError: false, timestamp: "2026-01-01T00:00:00.000Z" },
      { kind: "toolUse", text: "{}", truncated: false, name: "Read", isError: false, timestamp: null, model: "m1", outputTokens: 100 },
      { kind: "toolResult", text: "x", truncated: false, name: null, isError: false, timestamp: "bad date" },
      { kind: "assistantText", text: "ok", truncated: false, name: null, isError: false, timestamp: "2026-01-01T00:01:03.000Z", model: "m2", outputTokens: 50 },
    ], 0);

    expect(transcriptStats(rows)).toEqual({
      toolUses: 1,
      outputTokens: 150,
      model: "m2",
      firstAtMs: Date.parse("2026-01-01T00:00:00.000Z"),
      lastAtMs: Date.parse("2026-01-01T00:01:03.000Z"),
    });
  });
});

describe("countGroup and groupSummaryParts", () => {
  const call = (name: string, input: Record<string, unknown> = {}) =>
    ({ kind: "toolUse" as const, toolName: name, text: JSON.stringify(input), durationMs: null });
  const thought = (durationMs: number | null) =>
    ({ kind: "thinking" as const, toolName: null, text: "", durationMs });
  const sentence = (rows: Parameters<typeof countGroup>[0], active = false) =>
    groupSummaryParts(countGroup(rows), active)
      .map(part => `${part.lead}${part.count ?? ""}${part.tail}${part.added ? ` +${part.added}` : ""}${part.removed ? ` -${part.removed}` : ""}`)
      .join(", ");

  it("writes Claude Code's clauses in its order, the first capitalised", () => {
    const rows = [
      thought(1500), thought(900), call("Agent", { description: "x" }), call("Bash", { command: "ls" }),
    ];
    expect(sentence(rows)).toBe("Thought for 2s, ran 1 agent, called 1 tool");
  });

  it("counts reads, searches, lists, edits with their line stat, and MCP servers", () => {
    const rows = [
      call("Read"), call("Read"), call("Grep"), call("LS"),
      call("Edit", { old_string: "a", new_string: "b\nc" }), call("Write", { content: "x\ny\n" }),
      call("mcp__acme__find"), call("mcp__acme__get"),
    ];
    expect(sentence(rows)).toBe(
      "Edited 2 files +4 -1, searched for 1 pattern, read 2 files, listed 1 directory, called acme 2 times",
    );
  });

  it("uses the -ing forms while the group is the active one, and a one-second floor on thinking", () => {
    expect(sentence([thought(null), call("Read"), call("Task")], true)).toBe("Thinking for 1s, reading 1 file, running 1 agent");
  });

  it("names a single MCP call without a count", () => {
    expect(sentence([call("mcp__acme__find")])).toBe("Called acme");
  });
});

describe("the spinner row", () => {
  it("steps six frames out and back on a cosine, dwelling at the ends", () => {
    expect(cosineFrameStops(6)).toEqual([
      { percent: 0, frame: 0 },
      { percent: 10.24, frame: 1 },
      { percent: 18.45, frame: 2 },
      { percent: 25, frame: 3 },
      { percent: 31.55, frame: 4 },
      { percent: 39.76, frame: 5 },
      { percent: 60.24, frame: 4 },
      { percent: 68.45, frame: 3 },
      { percent: 75, frame: 2 },
      { percent: 81.55, frame: 1 },
      { percent: 89.76, frame: 0 },
    ]);
  });

  it("is the cosine index.css plays", () => {
    const css = readFileSync(path.join(__dirname, "../index.css"), "utf8");
    const block = /@keyframes termic-cli-spinner \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const stops = [...block.matchAll(/([\d.]+)% \{ transform: translateY\(calc\(var\(--row\) \* -?(\d)\)\); \}/g)]
      .map(([, percent, frame]) => ({ percent: Number(percent), frame: Number(frame) }));
    expect(stops).toEqual(cosineFrameStops(6));
  });

  it("shows the suffix once there are tokens, past 16 seconds, or while thinking", () => {
    expect(spinnerSuffix(5_000, 0, false)).toBeNull();
    expect(spinnerSuffix(16_001, 0, false)).toBe("(16s)");
    expect(spinnerSuffix(42_000, 1_100, false)).toBe("(42s \u00B7 \u2193 1.1k tokens)");
    expect(spinnerSuffix(3_000, 0, true)).toBe("(3s \u00B7 thinking)");
  });

  it("reads the in-progress todo's activeForm from the newest TodoWrite, else Working", () => {
    const todo = (todos: unknown[]) => ({ kind: "toolUse" as const, toolName: "TodoWrite", text: JSON.stringify({ todos }) });
    const older = todo([{ content: "a", status: "in_progress", activeForm: "Reading config" }]);
    const newer = todo([{ content: "b", status: "in_progress", activeForm: "Changing the port" }]);

    expect(spinnerMessage([])).toBe("Working\u2026");
    expect(spinnerMessage([older, newer])).toBe("Changing the port\u2026");
    expect(spinnerMessage([newer, todo([{ content: "c", status: "completed", activeForm: "Done" }])])).toBe("Working\u2026");
    expect(spinnerMessage([todo([{ content: "d", status: "in_progress", activeForm: "Waiting..." }])])).toBe("Waiting...");
  });
});

describe("wordSpans", () => {
  it("marks the changed middle of a removed and added pair when little of it changed", () => {
    const diff = lineDiff("const port = 3000\nkeep", "const port = 4000\nkeep");
    expect(wordSpans(diff)).toEqual([{ start: 13, end: 14 }, { start: 13, end: 14 }, null]);
  });

  it("leaves a pair alone when more than 40% of it changed, and an unpaired line too", () => {
    expect(wordSpans(lineDiff("abc", "xyz"))).toEqual([null, null]);
    expect(wordSpans(lineDiff("abcdef", "abcxyz"))).toEqual([null, null]);
    expect(wordSpans(lineDiff("port = 1\nport = 2", "port = 3"))).toEqual([{ start: 7, end: 8 }, null, { start: 7, end: 8 }]);
    expect(wordSpans(lineDiff("a\nb", "a\nb\nextra line"))).toEqual([null, null, null]);
  });
});
