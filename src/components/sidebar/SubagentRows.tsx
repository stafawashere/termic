// The subagent rows under one claude tab row.
//
// Two subscriptions, split so a workflow finishing its agents one by one does
// not redraw the list: the list selects only the tab's structure key (which
// agents, under which parent), and each row selects its own record. A row
// finishing re-renders that row and nothing else; see the "subagent rows"
// case in store/selectorFanout.test.ts.
//
// Fold state is in memory only. Nothing about a subagent is persisted.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { create } from "zustand";
import { Check, ChevronDown, ChevronRight, CircleDashed, CircleSlash, Clock3, X } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { useSubagents, type SubagentState } from "@/store/subagents";
import { openSubagentPreview } from "@/store/subagentPreview";
import {
  buildSubagentTree, createSubagentStructureSelector, parseSubagentStructureKey, selectSubagentRecord,
} from "./subagentTree";

const EMPTY_FOLD: readonly string[] = Object.freeze([]);

interface SubagentFoldState {
  /** Per tab, the agents whose children are hidden. */
  byTab: Record<string, readonly string[]>;
  toggle: (tabId: string, agentId: string) => void;
}

export const useSubagentFold = create<SubagentFoldState>(set => ({
  byTab: {},

  toggle: (tabId, agentId) => set(s => {
    const current = s.byTab[tabId] ?? EMPTY_FOLD;
    const isFolded = current.includes(agentId);
    const next = isFolded ? current.filter(id => id !== agentId) : [...current, agentId];
    return { byTab: { ...s.byTab, [tabId]: Object.freeze(next) } };
  }),
}));

/** Indent per depth: depth 1 sits one step right of the tab row's ml-8. */
const DEPTH_INDENT: Record<number, string> = {
  1: "ml-11",
  2: "ml-14",
  3: "ml-17",
};

function stateCopy(state: SubagentState, t: TFunction<"sidebar">): { label: string; hint: string } {
  switch (state) {
    case "running":
      return { label: t("subagents.running"), hint: t("subagents.runningHint") };
    case "done":
      return { label: t("subagents.done"), hint: t("subagents.doneHint") };
    case "failed":
      return { label: t("subagents.failed"), hint: t("subagents.failedHint") };
    case "interrupted":
      return { label: t("subagents.interrupted"), hint: t("subagents.interruptedHint") };
    case "unknown":
      return { label: t("subagents.unknown"), hint: t("subagents.unknownHint") };
    case "expired":
      return { label: t("subagents.expired"), hint: t("subagents.expiredHint") };
  }
}

function StateMark({ state }: { state: SubagentState }) {
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

const SubagentRow = memo(function SubagentRow({ taskId, tabId, agentId, depth, hasChildren, folded, selected }: {
  taskId: string;
  tabId: string;
  agentId: string;
  depth: number;
  hasChildren: boolean;
  folded: boolean;
  selected: boolean;
}) {
  const { t } = useTranslation("sidebar");
  const selectRecord = useMemo(() => selectSubagentRecord(tabId, agentId), [tabId, agentId]);
  const record = useSubagents(selectRecord);
  const toggleFold = useSubagentFold(s => s.toggle);

  if (!record) return null;

  const copy = stateCopy(record.state, t);
  const label = record.description || record.agentType;
  const rowTitle = record.description ? `${record.agentType}: ${record.description}` : record.agentType;
  const foldLabel = folded ? t("subagents.expand") : t("subagents.collapse");

  // Activate the task first and open second: activating restores the tab the
  // task last had in front, which would otherwise cover the transcript.
  const openTranscript = () => {
    useApp.getState().setActiveTask(taskId);
    openSubagentPreview(taskId, tabId, agentId);
  };

  return (
    <div
      data-testid="subagent-row"
      data-agent-id={agentId}
      data-subagent-state={record.state}
      data-depth={depth}
      onClick={openTranscript}
      className={cn(
        "group/subagent flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] select-none transition-colors",
        DEPTH_INDENT[depth] ?? DEPTH_INDENT[3],
        selected
          ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {hasChildren ? (
        <button
          data-testid="subagent-fold"
          aria-label={foldLabel}
          aria-expanded={!folded}
          title={foldLabel}
          onClick={(e) => { e.stopPropagation(); toggleFold(tabId, agentId); }}
          className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)] transition-colors"
        >
          {folded
            ? <ChevronRight className="h-3 w-3 text-[var(--color-fg-faint)]" />
            : <ChevronDown className="h-3 w-3 text-[var(--color-fg-faint)]" />}
        </button>
      ) : (
        <span aria-hidden className="h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate" title={rowTitle}>{label}</span>
      <span
        data-testid="subagent-badge"
        data-subagent-state={record.state}
        role="img"
        aria-label={copy.label}
        title={copy.hint}
        className="flex h-4 w-4 shrink-0 items-center justify-center"
      >
        <StateMark state={record.state} />
      </span>
    </div>
  );
});

/** Every subagent row of one tab, flat and keyed by agent id, so a row that
 *  moves to a new parent is the same DOM node in its new place. */
export const SubagentRows = memo(function SubagentRows({ taskId, tabId, selectedAgentId }: {
  taskId: string;
  tabId: string;
  /** The agent whose tab is the active one, when that is in this task. */
  selectedAgentId: string | null;
}) {
  const selectStructure = useMemo(() => createSubagentStructureSelector(tabId), [tabId]);
  const structureKey = useSubagents(selectStructure);
  const foldedIds = useSubagentFold(s => s.byTab[tabId] ?? EMPTY_FOLD);

  const rows = useMemo(
    () => buildSubagentTree(parseSubagentStructureKey(structureKey), new Set(foldedIds)),
    [structureKey, foldedIds],
  );

  if (rows.length === 0) return null;

  return (
    <>
      {rows.map(row => (
        <SubagentRow
          key={row.agentId}
          taskId={taskId}
          tabId={tabId}
          agentId={row.agentId}
          depth={row.depth}
          hasChildren={row.hasChildren}
          folded={foldedIds.includes(row.agentId)}
          selected={row.agentId === selectedAgentId}
        />
      ))}
    </>
  );
});
