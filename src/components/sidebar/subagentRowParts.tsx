// The pieces every subagent sidebar row shares: its indent, its fold
// chevron and its state mark.

import type { MouseEvent } from "react";
import { Check, ChevronDown, ChevronRight, CircleDashed, CircleSlash, Clock3, X } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import type { SubagentState } from "@/store/subagents";

/** Indent per depth: depth 1 sits one step right of the tab row's ml-8. */
export const DEPTH_INDENT: Record<number, string> = {
  1: "ml-11",
  2: "ml-14",
  3: "ml-17",
};

export function indentClass(depth: number): string {
  return DEPTH_INDENT[depth] ?? DEPTH_INDENT[3];
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
