// The pieces every subagent sidebar row shares: its indent, its fold
// chevron, its leading icon and its state mark.

import type { MouseEvent } from "react";
import {
  BookOpen, Bot, Check, ChevronDown, ChevronRight, CircleDashed, CircleSlash, Clock3, Layers, ListTodo, Search, Workflow, X,
  type LucideIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import type { SubagentState } from "@/store/subagents";
import type { SubagentRowIconName } from "./subagentRowIcon";

/** Indent per depth: depth 1 sits one step right of the tab row's ml-8. */
export const DEPTH_INDENT: Record<number, string> = {
  1: "ml-11",
  2: "ml-14",
  3: "ml-17",
};

export function indentClass(depth: number): string {
  return DEPTH_INDENT[depth] ?? DEPTH_INDENT[3];
}

const ROW_ICONS: Record<SubagentRowIconName, LucideIcon> = {
  "workflow": Workflow,
  "layers": Layers,
  "search": Search,
  "list-todo": ListTodo,
  "book-open": BookOpen,
  "bot": Bot,
};

/** The row's kind at a glance, in the faint foreground so the state mark on
 *  the right stays the only colour. Thinner strokes keep it under the weight
 *  of the tab row's brand mark; a phase is thinner still than its run. */
export function RowIcon({ name, light = false }: { name: SubagentRowIconName; light?: boolean }) {
  const Icon = ROW_ICONS[name];
  const strokeWidth = light ? 1.5 : 1.75;

  return (
    <span
      data-testid="subagent-row-icon"
      data-icon={name}
      aria-hidden
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[var(--color-fg-faint)]"
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={strokeWidth} />
    </span>
  );
}

export function StateMark({ state }: { state: SubagentState }) {
  switch (state) {
    case "running":
      return <Spinner size={10} className="text-[var(--color-fg-dim)]" />;
    case "done":
      return <Check className="h-3 w-3 text-[var(--color-ok)]" />;
    case "failed":
      return <X className="h-3 w-3 text-[var(--color-err)]" />;
    case "interrupted":
      return <CircleSlash className="h-3 w-3 text-[var(--color-warn)]" />;
    case "unknown":
      return <CircleDashed className="h-3 w-3 text-[var(--color-fg-faint)]" />;
    case "expired":
      return <Clock3 className="h-3 w-3 text-[var(--color-fg-faint)]" />;
  }
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
      data-testid={testId}
      aria-label={label}
      aria-expanded={!folded}
      title={label}
      onClick={handleClick}
      className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)] transition-colors"
    >
      {folded
        ? <ChevronRight className="h-3 w-3 text-[var(--color-fg-faint)]" />
        : <ChevronDown className="h-3 w-3 text-[var(--color-fg-faint)]" />}
    </button>
  );
}
