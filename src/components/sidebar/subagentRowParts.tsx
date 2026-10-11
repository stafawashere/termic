// The pieces every subagent sidebar row shares: its indent and tree lines,
// its fold chevron, its leading icon and its state.

import type { CSSProperties, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen, Bot, Layers, ListTodo, Search, Workflow,
  type LucideIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import type { SubagentState } from "@/store/subagents";
import type { SubagentRowIconName } from "./subagentRowIcon";
import type { SubagentGuideLines } from "./subagentTree";
import { TreeChevron } from "./sidebarIcons";

/** The tree's step. A session row sits one step in from its task, depth 1
 *  one step in from the session, and so on down to the depth clamp. */
const TREE_STEP = 18;

/** Where the guide for rows at `level` runs, from the task's indent. Level 1
 *  is the session's guide for its subagents. */
function guideLeft(level: number): string {
  return `calc(var(--sb-task-pad, 42px) + ${TREE_STEP * level + 4}px)`;
}

/** The row box every subagent, run and phase row shares: the session rows'
 *  28px rhythm, one tree step deeper per depth. */
export function subagentRowClass(selected: boolean, restInk: string): string {
  return cn(
    "relative flex h-[var(--sidebar-row-h)] cursor-pointer select-none items-center gap-[8px] rounded-[6px] pr-[8px] text-[13px] transition-[color,background-color] duration-[120ms]",
    selected ? "sidebar-selected text-[var(--sidebar-sel-ink)]" : cn(restInk, "hover:bg-[var(--sidebar-row-hover)]"),
  );
}

/** Depth 1 starts two steps in from the task (78px under a project at the
 *  top level), each depth one step further. */
export function subagentRowStyle(depth: number): CSSProperties {
  return { paddingLeft: `calc(var(--sb-task-pad, 42px) + ${TREE_STEP * (depth + 1)}px)` };
}

/** The guide and 9px elbow from the row's parent, plus the guides of open
 *  ancestors passing beside it. The row must be `relative`. */
export function TreeLines({ depth, lines }: { depth: number; lines: SubagentGuideLines }) {
  const line = "pointer-events-none absolute w-px bg-[var(--sidebar-connector)]";

  return (
    <>
      {lines.through.map(level => (
        <span key={level} aria-hidden className={cn(line, "bottom-0 top-0")} style={{ left: guideLeft(level) }} />
      ))}
      <span
        aria-hidden
        className={cn(line, lines.last ? "top-0 h-[14px]" : "bottom-0 top-0")}
        style={{ left: guideLeft(depth) }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-[14px] h-px w-[9px] bg-[var(--sidebar-connector)]"
        style={{ left: guideLeft(depth) }}
      />
    </>
  );
}

const ROW_ICONS: Record<SubagentRowIconName, LucideIcon> = {
  "workflow": Workflow,
  "layers": Layers,
  "search": Search,
  "list-todo": ListTodo,
  "book-open": BookOpen,
  "bot": Bot,
};

/** The row's kind at a glance, in the tree's icon grey so the state on the
 *  right stays the only colour. 16px, the width of the session row's
 *  critter above it. */
export function RowIcon({ name, selected = false }: { name: SubagentRowIconName; selected?: boolean }) {
  const Icon = ROW_ICONS[name];

  return (
    <span
      data-testid="subagent-row-icon"
      data-icon={name}
      aria-hidden
      className={cn(
        "flex h-[16px] w-[16px] shrink-0 items-center justify-center",
        selected ? "text-[var(--sidebar-sel-icon)]" : "text-[var(--sidebar-icon)]",
      )}
    >
      <Icon className="h-[16px] w-[16px]" strokeWidth={1.8} />
    </span>
  );
}

const STATE_INK: Record<SubagentState, string> = {
  running: "text-[var(--sidebar-running)]",
  done: "text-[var(--sidebar-settled)]",
  failed: "text-[var(--color-err)]",
  interrupted: "text-[var(--color-warn)]",
  unknown: "text-[var(--sidebar-faint)]",
  expired: "text-[var(--sidebar-faint)]",
};

/** The state as a lowercase word, the way a session row reads; running also
 *  carries its spinner. */
export function StateWord({ state }: { state: SubagentState }) {
  const { t } = useTranslation("sidebar");
  const isRunning = state === "running";

  return (
    <span className={cn("flex items-center gap-[5px] text-[11px]", STATE_INK[state])}>
      {isRunning && <Spinner size={10} />}
      {t(`subagents.stateWord.${state}`)}
    </span>
  );
}

export function FoldChevron({ testId, folded, label, onToggle }: {
  testId: string;
  folded: boolean;
  label: string;
  onToggle: () => void;
}) {
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    onToggle();
  };

  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      aria-expanded={!folded}
      title={label}
      onClick={handleClick}
      className="flex h-[20px] w-[10px] shrink-0 items-center justify-center text-[var(--sidebar-chevron)]"
    >
      <TreeChevron open={!folded} />
    </button>
  );
}

/** Holds the chevron's column on a row with nothing to fold, so icons line
 *  up down the tree. */
export function ChevronSpacer() {
  return <span aria-hidden className="w-[10px] shrink-0" />;
}
