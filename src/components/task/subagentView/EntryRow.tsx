// One transcript entry drawn the way Claude Code's terminal draws it: a dot
// in a two-cell gutter, the text from cell 2, and a tool's result hanging
// from a hook at cell 2 with its text from cell 5. Widths are multiples of
// `--cell`, the terminal's measured cell width, and colours are claude's
// theme roles (`--cc-*`), both set on the pane root.

import { memo, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { type ToolCallState, type TranscriptRow } from "@/lib/subagentTranscript";
import {
  countGroup, formatElapsed, groupSummaryParts, toolDisplay, toolSummary, type DiffLine, type TodoItem, type ToolSummary,
} from "@/lib/subagentCliView";
import type { ViewRow } from "@/lib/subagentTranscript";
import { GLYPH } from "./glyphs";
import { Markdown } from "./Markdown";

const OUTPUT_FOLD_LINES = 3;
const PROMPT_FOLD_LINES = 6;
const DIFF_FOLD_LINES = 20;
const WRITE_FOLD_LINES = 10;

type Translate = TFunction<"task">;

export interface EntryRowOptions {
  showToolInput: boolean;
  showToolOutput: boolean;
  /** Tool output past this many lines is cut; 0 never cuts. */
  maxOutputLines: number;
  worktreePath: string | null;
}

function Gutter({ children, className }: { children?: ReactNode; className?: string }) {
  return <span aria-hidden className={cn("w-[calc(var(--cell)*2)] shrink-0 select-none", className)}>{children}</span>;
}

function HookBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-testid="subagent-tool-result" className={cn("flex pl-[calc(var(--cell)*2)]", className)}>
      <span aria-hidden className="w-[calc(var(--cell)*3)] shrink-0 select-none text-[var(--cc-dim)]">{GLYPH.hook}</span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
}

function MoreLinesToggle({ count, onToggle, t }: { count: number; onToggle: () => void; t: Translate }) {
  return (
    <button
      type="button"
      data-testid="subagent-entry-expand"
      onClick={onToggle}
      className="block text-left text-[var(--cc-dim)] hover:text-[var(--cc-dim)]"
    >
      {GLYPH.ellipsis} {t("subagentView.moreLines", { count })}
    </button>
  );
}

/** Lines that start folded to `foldAt` with a dim "+N lines" under them.
 *  Unfolded, the Settings line cap still applies. */
function FoldedLines({ lines, foldAt, expanded, onToggle, maxOutputLines, t, renderLine }: {
  lines: readonly string[];
  foldAt: number;
  expanded: boolean;
  onToggle: () => void;
  maxOutputLines: number;
  t: Translate;
  renderLine?: (line: string, position: number) => ReactNode;
}) {
  const cap = maxOutputLines > 0 ? Math.min(maxOutputLines, lines.length) : lines.length;
  const limit = expanded ? cap : Math.min(foldAt, cap);
  const shown = lines.slice(0, limit);
  const foldedAway = cap - limit;
  const cutBySetting = lines.length - cap;
  const showsCutNote = expanded && cutBySetting > 0;

  return (
    <>
      {shown.map((line, position) => (
        <div key={position}>{renderLine ? renderLine(line, position) : line || "\u00A0"}</div>
      ))}
      {foldedAway > 0 && <MoreLinesToggle count={foldedAway} onToggle={onToggle} t={t} />}
      {showsCutNote && (
        <div data-testid="subagent-lines-cut" className="text-[var(--cc-dim)]">
          {t("subagentView.linesCut", { count: cutBySetting })}
        </div>
      )}
    </>
  );
}

function DiffRow({ line, numberWidth }: { line: DiffLine; numberWidth: number }) {
  const isAdd = line.kind === "add";
  const isRemove = line.kind === "remove";
  const isContext = line.kind === "context";
  const sign = isAdd ? "+" : isRemove ? "-" : " ";

  return (
    <div
      data-testid="subagent-diff-line"
      data-diff={line.kind}
      className={cn(
        "flex",
        isAdd && "bg-[var(--cc-diffAdded)]",
        isRemove && "bg-[var(--cc-diffRemoved)]",
        isContext && "text-[var(--cc-dim)]",
      )}
    >
      {numberWidth > 0 && (
        <span className="shrink-0 whitespace-nowrap text-right text-[var(--cc-dim)]" style={{ width: `calc(var(--cell) * ${numberWidth})` }}>
          {line.lineNumber ?? ""}
        </span>
      )}
      <span aria-hidden className="w-[calc(var(--cell)*3)] shrink-0 text-center">{sign}</span>
      <span className="min-w-0 flex-1">{line.text || "\u00A0"}</span>
    </div>
  );
}

function Todo({ todo }: { todo: TodoItem }) {
  const isDone = todo.status === "completed";
  const isActive = todo.status === "in_progress";
  const isPending = todo.status === "pending";

  return (
    <div
      data-testid="subagent-todo"
      data-todo-status={todo.status}
      className={cn(
        "flex",
        isDone && "text-[var(--cc-dim)]",
        isActive && "font-bold text-[var(--cc-text)]",
        isPending && "text-[var(--cc-text)]",
      )}
    >
      <span aria-hidden className="w-[calc(var(--cell)*2)] shrink-0">{isDone ? GLYPH.boxDone : GLYPH.boxOpen}</span>
      <span className={cn("min-w-0 flex-1", isDone && "line-through")}>{todo.content}</span>
    </div>
  );
}

function updatedHeadline(summary: Extract<ToolSummary, { kind: "updated" }>, t: Translate): string {
  const additions = t("subagentView.additions", { count: summary.additions });
  const removals = t("subagentView.removals", { count: summary.removals });
  const path = summary.path;

  if (summary.additions > 0 && summary.removals > 0) return t("subagentView.updatedBoth", { path, additions, removals });
  if (summary.removals > 0) return t("subagentView.updatedOne", { path, change: removals });
  return t("subagentView.updatedOne", { path, change: additions });
}

function errorHeadline(line: string, t: Translate): string {
  const saysError = /^error\b/i.test(line);
  return saysError ? line : t("subagentView.errorLine", { text: line });
}

function SummaryBody({ summary, expanded, onToggle, maxOutputLines, t }: {
  summary: ToolSummary;
  expanded: boolean;
  onToggle: () => void;
  maxOutputLines: number;
  t: Translate;
}) {
  const fold = (lines: readonly string[], foldAt: number, renderLine?: (line: string, position: number) => ReactNode) => (
    <FoldedLines
      lines={lines}
      foldAt={foldAt}
      expanded={expanded}
      onToggle={onToggle}
      maxOutputLines={maxOutputLines}
      t={t}
      renderLine={renderLine}
    />
  );

  switch (summary.kind) {
    case "pending":
      return <span className="text-[var(--cc-dim)]">{t("subagentView.running")}{GLYPH.ellipsis}</span>;

    case "error":
      return (
        <div className="text-[var(--cc-error)]">
          <div>{errorHeadline(summary.lines[0], t)}</div>
          {fold(summary.lines.slice(1), 0)}
        </div>
      );

    case "readLines":
      return <span className="text-[var(--cc-dim)]">{t("subagentView.readLines", { count: summary.count })}</span>;

    case "foundFiles":
      return <span className="text-[var(--cc-dim)]">{t("subagentView.foundFiles", { count: summary.count })}</span>;

    case "noContent":
      return <span className="text-[var(--cc-dim)]">{t("subagentView.noContent")}</span>;

    case "output":
      return <div className="text-[var(--cc-dim)]">{fold(summary.lines, OUTPUT_FOLD_LINES)}</div>;

    case "todos":
      return <div>{summary.todos.map((todo, position) => <Todo key={position} todo={todo} />)}</div>;

    case "wrote": {
      const numberWidth = String(summary.lines.length).length;
      return (
        <div>
          <div className="text-[var(--cc-dim)]">
            {t("subagentView.wroteLines", { count: summary.count, path: summary.path })}
          </div>
          {fold(summary.lines, WRITE_FOLD_LINES, (line, position) => (
            <div className="flex">
              <span className="shrink-0 whitespace-nowrap text-right text-[var(--cc-dim)]" style={{ width: `calc(var(--cell) * ${numberWidth})` }}>
                {position + 1}
              </span>
              <span className="min-w-0 flex-1 pl-[var(--cell)]">{line || "\u00A0"}</span>
            </div>
          ))}
        </div>
      );
    }

    case "updated": {
      const highestNumber = summary.diff.reduce((highest, line) => Math.max(highest, line.lineNumber ?? 0), 0);
      const numberWidth = highestNumber > 0 ? String(highestNumber).length : 0;
      const keyed = summary.diff.map((_, position) => String(position));
      return (
        <div>
          <div className="text-[var(--cc-dim)]">{updatedHeadline(summary, t)}</div>
          {fold(keyed, DIFF_FOLD_LINES, (_, position) => (
            <DiffRow line={summary.diff[position]} numberWidth={numberWidth} />
          ))}
        </div>
      );
    }
  }
}

const TOOL_DOT_CLASS: Record<ToolCallState, string> = {
  pending: "text-[var(--cc-dim)] termic-cli-blink",
  ok: "text-[var(--cc-success)]",
  error: "text-[var(--cc-error)]",
};

function ToolCall({ row, result, state, expanded, onToggle, options, t }: {
  row: TranscriptRow;
  result: TranscriptRow | null;
  state: ToolCallState;
  expanded: boolean;
  onToggle: () => void;
  options: EntryRowOptions;
  t: Translate;
}) {
  const name = row.toolName ?? "?";
  const display = toolDisplay(name, row.text, options.worktreePath);
  const showsArgs = options.showToolInput && display.args !== "";
  const summary = toolSummary(name, row.text, result, options.worktreePath);

  return (
    <div className="text-[var(--cc-text)]">
      <div className="flex">
        <Gutter>
          <span data-testid="subagent-tool-state" data-tool-state={state} className={cn("inline-block", TOOL_DOT_CLASS[state])}>
            {GLYPH.entry}
          </span>
        </Gutter>
        <div className="min-w-0 flex-1 break-words">
          <span data-testid="subagent-tool-name" className="font-bold">{display.label}</span>
          {showsArgs && <span data-testid="subagent-tool-input">({display.args})</span>}
          {showsArgs && row.truncated && (
            <span className="text-[var(--cc-dim)]"> ({t("subagentView.truncated")})</span>
          )}
        </div>
      </div>
      {options.showToolOutput && (
        <HookBlock>
          <SummaryBody
            summary={summary}
            expanded={expanded}
            onToggle={onToggle}
            maxOutputLines={options.maxOutputLines}
            t={t}
          />
        </HookBlock>
      )}
    </div>
  );
}

function thinkingLabel(row: TranscriptRow, t: Translate): string {
  if (row.durationMs === null) return `${t("subagentView.thinking")}${GLYPH.ellipsis}`;
  return t("subagentView.thoughtFor", { duration: formatElapsed(row.durationMs) });
}

function textLines(text: string): string[] {
  return text.replace(/\s+$/, "").split("\n");
}

export const EntryRow = memo(function EntryRow({ row, result, toolState, expanded, onToggle, options, t }: {
  row: TranscriptRow;
  result: TranscriptRow | null;
  toolState: ToolCallState | null;
  expanded: boolean;
  onToggle: (index: number) => void;
  options: EntryRowOptions;
  t: Translate;
}) {
  const toggle = () => onToggle(row.index);

  switch (row.kind) {
    case "userText":
      return (
        <div className="flex bg-[var(--cc-userMessageBackground)] pr-[var(--cell)] text-[var(--cc-text)]">
          <Gutter className="text-[var(--cc-inactive)]">{GLYPH.pointer}</Gutter>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            <FoldedLines
              lines={textLines(row.text)}
              foldAt={PROMPT_FOLD_LINES}
              expanded={expanded}
              onToggle={toggle}
              maxOutputLines={0}
              t={t}
            />
          </div>
        </div>
      );

    case "assistantText":
      return (
        <div className="flex text-[var(--cc-text)]">
          <Gutter>{GLYPH.bullet}</Gutter>
          <Markdown text={row.text} />
        </div>
      );

    case "thinking":
      return (
        <div className="italic text-[var(--cc-dim)]">
          <button
            type="button"
            data-testid="subagent-thinking-toggle"
            aria-expanded={expanded}
            onClick={toggle}
            className="flex text-left italic hover:text-[var(--cc-text)]"
          >
            <Gutter>{GLYPH.star}</Gutter>
            <span>{thinkingLabel(row, t)}</span>
          </button>
          {expanded && (
            <div className="whitespace-pre-wrap break-words pl-[calc(var(--cell)*2)]">{row.text}</div>
          )}
        </div>
      );

    case "redactedThinking":
      return (
        <div data-testid="subagent-redacted-thinking" className="flex italic text-[var(--cc-dim)]">
          <Gutter>{GLYPH.star}</Gutter>
          <span>{t("subagentView.redactedThinking")}</span>
        </div>
      );

    case "toolUse":
      return (
        <ToolCall
          row={row}
          result={result}
          state={toolState ?? "pending"}
          expanded={expanded}
          onToggle={toggle}
          options={options}
          t={t}
        />
      );

    case "toolResult": {
      const summary = toolSummary("", "", row, options.worktreePath);
      return (
        <HookBlock>
          <SummaryBody
            summary={summary}
            expanded={expanded}
            onToggle={toggle}
            maxOutputLines={options.maxOutputLines}
            t={t}
          />
        </HookBlock>
      );
    }

    case "error":
      return (
        <div className="flex text-[var(--cc-error)]">
          <Gutter>{GLYPH.entry}</Gutter>
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            <FoldedLines
              lines={textLines(row.text)}
              foldAt={PROMPT_FOLD_LINES}
              expanded={expanded}
              onToggle={toggle}
              maxOutputLines={0}
              t={t}
            />
          </div>
        </div>
      );

    case "compactBoundary":
      return (
        <div
          data-testid="subagent-compact-divider"
          role="separator"
          className="flex items-center gap-[var(--cell)] text-[var(--cc-dim)]"
        >
          <span aria-hidden className="h-[3px] flex-1 border-y border-[var(--cc-dim)]" />
          <span>{t("subagentView.compacted")}</span>
          <span aria-hidden className="h-[3px] flex-1 border-y border-[var(--cc-dim)]" />
        </div>
      );

    case "unknown":
      return (
        <div className="text-[var(--cc-dim)]">
          <button
            type="button"
            data-testid="subagent-entry-expand"
            onClick={toggle}
            aria-expanded={expanded}
            className="flex text-left hover:text-[var(--cc-dim)]"
          >
            <Gutter>{expanded ? GLYPH.expanded : GLYPH.collapsed}</Gutter>
            <span>{t("subagentView.unknownEntry", { kind: row.sourceKind || "?" })}</span>
          </button>
          {expanded && row.text && <div className="whitespace-pre-wrap break-words pl-[calc(var(--cell)*2)]">{row.text}</div>}
        </div>
      );
  }
});

function Stat({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {added > 0 && <span className="text-[var(--cc-diffAddedWord)]"> +{added}</span>}
      {removed > 0 && <span className="text-[var(--cc-diffRemovedWord)]"> -{removed}</span>}
    </>
  );
}

/** A run of tool calls and thinking, collapsed to Claude Code's one dim
 *  summary line ("Thought for 2s, read 2 files"), or unfolded into the
 *  calls themselves. A click on the line flips it, as ctrl+o does. */
export const GroupRow = memo(function GroupRow({ index, members, unfolded, active, expandedEntries, onToggleGroup, onToggleEntry, options, t }: {
  index: number;
  members: readonly ViewRow[];
  unfolded: boolean;
  active: boolean;
  expandedEntries: ReadonlySet<number>;
  onToggleGroup: (index: number) => void;
  onToggleEntry: (index: number) => void;
  options: EntryRowOptions;
  t: Translate;
}) {
  const parts = groupSummaryParts(countGroup(members.map(member => member.row)), active);

  return (
    <div>
      <button
        type="button"
        data-testid="subagent-group"
        data-group-unfolded={unfolded}
        aria-expanded={unfolded}
        onClick={() => onToggleGroup(index)}
        className="flex w-full text-left text-[var(--cc-dim)] hover:text-[var(--cc-inactive)]"
      >
        <Gutter />
        <span className="min-w-0 flex-1">
          {parts.map((part, position) => (
            <span key={position}>
              {position > 0 && ", "}
              {part.lead}
              {part.count !== null && <span className="font-bold">{part.count}</span>}
              {part.tail}
              <Stat added={part.added} removed={part.removed} />
            </span>
          ))}
          {active && GLYPH.ellipsis}
        </span>
      </button>
      {unfolded && members.map(member => (
        <div key={member.index} data-testid="subagent-group-member" data-entry-kind={member.kind} className="pt-[var(--row)]">
          <EntryRow
            row={member.row}
            result={member.result}
            toolState={member.toolState}
            expanded={expandedEntries.has(member.index)}
            onToggle={onToggleEntry}
            options={options}
            t={t}
          />
        </div>
      ))}
    </div>
  );
});
