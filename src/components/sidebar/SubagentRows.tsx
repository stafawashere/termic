// The subagent rows under one claude tab row.
//
// Two subscriptions, split so a workflow finishing its agents one by one does
// not redraw the list: the list selects only the tab's structure key (which
// agents, under which parent), and each row selects its own record. A row
// finishing re-renders that row and nothing else; see the "subagent rows"
// case in store/selectorFanout.test.ts.
//
// What shows follows Settings > Tasks > Claude subagents: the type filters
// and retention decide which agents get a row, and auto-collapse decides
// whether a tab's group starts folded. Retention runs on one timer per tab,
// scheduled only while an ended row is waiting to go, never a poll.
//
// Fold state is in memory only. Nothing about a subagent is persisted.

import { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { create } from "zustand";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { retentionWindowMs } from "@/lib/subagentPrefs";
import { useSubagents, type SubagentState } from "@/store/subagents";
import { foldAllSubagents, type GroupFold } from "./subagentFold";
import { openSubagentPreview } from "@/store/subagentPreview";
import {
  createRetentionExpirySelector, createSubagentStructureSelector, hasSubagentRow, selectSubagentRecord,
  subagentGroupStartsCollapsed, subagentRowIndent, subagentRowsOfKey, type SubagentPhaseRow, type SubagentRowRules,
} from "./subagentTree";
import { FoldChevron, indentClass, RowIcon, StateMark } from "./subagentRowParts";
import { subagentAgentIconName } from "./subagentRowIcon";
import { WorkflowRunRow } from "./WorkflowRunRow";

const EMPTY_FOLD: readonly string[] = Object.freeze([]);

interface SubagentFoldState {
  /** Per tab, the agents whose children are hidden, and the phases (by
   *  phase row key) whose agents are. A phase starts open. */
  byTab: Record<string, readonly string[]>;
  /** Per tab, the workflow runs opened by hand. A run starts collapsed
   *  whatever the auto-collapse setting, since it can hold hundreds of
   *  agents. */
  openRunsByTab: Record<string, readonly string[]>;
  groupByTab: Record<string, GroupFold>;
  toggle: (tabId: string, foldId: string) => void;
  toggleRun: (tabId: string, runId: string) => void;
  setGroupCollapsed: (tabId: string, sessionId: string, collapsed: boolean) => void;
  /** Expand or Collapse all agents: every tab's subagent group and every
   *  workflow run, from the subagents the store holds now. */
  setAllCollapsed: (collapsed: boolean) => void;
}


function toggled(list: readonly string[], id: string): readonly string[] {
  const has = list.includes(id);
  return Object.freeze(has ? list.filter(item => item !== id) : [...list, id]);
}

export const useSubagentFold = create<SubagentFoldState>((set, get) => ({
  byTab: {},
  openRunsByTab: {},
  groupByTab: {},

  toggle: (tabId, foldId) => set(s => ({
    byTab: { ...s.byTab, [tabId]: toggled(s.byTab[tabId] ?? EMPTY_FOLD, foldId) },
  })),

  toggleRun: (tabId, runId) => set(s => ({
    openRunsByTab: { ...s.openRunsByTab, [tabId]: toggled(s.openRunsByTab[tabId] ?? EMPTY_FOLD, runId) },
  })),

  setGroupCollapsed: (tabId, sessionId, collapsed) => {
    const current = get().groupByTab[tabId];
    const isSame = current?.sessionId === sessionId && current.collapsed === collapsed;
    if (isSame) return;

    set(s => ({ groupByTab: { ...s.groupByTab, [tabId]: { sessionId, collapsed } } }));
  },

  setAllCollapsed: (collapsed) => {
    const next = foldAllSubagents(get(), useSubagents.getState().byTab, collapsed);
    if (next) set(next);
  },
}));

/** The structure key of the rows a tab shows under the current settings,
 *  and those settings, re-evaluated when retention next takes a row away. */
function useVisibleSubagentStructure(tabId: string): { structureKey: string; rules: SubagentRowRules } {
  const typeFilter = usePrefs(s => s.subagentTypeFilter);
  const retention = usePrefs(s => s.subagentRetention);
  const openRunIds = useSubagentFold(s => s.openRunsByTab[tabId] ?? EMPTY_FOLD);
  const [now, setNow] = useState(() => Date.now());

  const rules = useMemo<SubagentRowRules>(
    () => ({ typeFilter, retentionMs: retentionWindowMs(retention), now }),
    [typeFilter, retention, now],
  );
  const selectStructure = useMemo(
    () => createSubagentStructureSelector(tabId, rules, new Set(openRunIds)),
    [tabId, rules, openRunIds],
  );
  const selectExpiry = useMemo(() => createRetentionExpirySelector(tabId, rules), [tabId, rules]);
  const structureKey = useSubagents(selectStructure);
  const nextExpiry = useSubagents(selectExpiry);

  useEffect(() => {
    if (nextExpiry === null) return;

    const delay = Math.max(0, nextExpiry - Date.now());
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [nextExpiry]);

  return { structureKey, rules };
}

/** Whether a tab's subagent group is folded, and the session that answer
 *  belongs to (null before the tab has any subagent). */
function useSubagentGroupFold(
  tabId: string,
  rules: SubagentRowRules,
): { collapsed: boolean; sessionId: string | null } {
  const mode = usePrefs(s => s.subagentAutoCollapse);
  const sessionId = useSubagents(s => s.byTab[tabId]?.sessionId ?? null);
  const startsCollapsed = useSubagents(s => subagentGroupStartsCollapsed(s.byTab[tabId], mode, rules));
  const manual = useSubagentFold(s => s.groupByTab[tabId]);

  const manualHolds = !!manual && manual.sessionId === sessionId;
  const collapsed = manualHolds ? manual.collapsed : startsCollapsed;
  return { collapsed, sessionId };
}

/** The chevron on a claude tab's row that folds its subagent group. Draws
 *  nothing while the tab shows no subagent row. */
export const SubagentGroupToggle = memo(function SubagentGroupToggle({ tabId }: { tabId: string }) {
  const { t } = useTranslation("sidebar");
  const { structureKey, rules } = useVisibleSubagentStructure(tabId);
  const { collapsed, sessionId } = useSubagentGroupFold(tabId, rules);
  const setGroupCollapsed = useSubagentFold(s => s.setGroupCollapsed);

  const hasRows = structureKey !== "";
  if (!hasRows || sessionId === null) return null;

  const label = collapsed ? t("subagents.expandGroup") : t("subagents.collapseGroup");

  return (
    <button
      data-testid="subagent-group-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      onClick={(e) => { e.stopPropagation(); setGroupCollapsed(tabId, sessionId, !collapsed); }}
      className="shrink-0 rounded p-0.5 hover:bg-[var(--color-bg-3)] transition-colors"
    >
      {collapsed
        ? <ChevronRight className="h-3 w-3 text-[var(--color-fg-faint)]" />
        : <ChevronDown className="h-3 w-3 text-[var(--color-fg-faint)]" />}
    </button>
  );
});

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
        indentClass(depth),
        selected
          ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      {hasChildren ? (
        <FoldChevron
          testId="subagent-fold"
          folded={folded}
          label={foldLabel}
          onToggle={() => toggleFold(tabId, agentId)}
        />
      ) : (
        <span aria-hidden className="h-4 w-4 shrink-0" />
      )}
      <RowIcon name={subagentAgentIconName(record.agentType)} />
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

const PhaseRow = memo(function PhaseRow({ tabId, phaseKey, title, indent, folded, selected, onToggle }: {
  tabId: string;
  phaseKey: string;
  title: string;
  indent: number;
  folded: boolean;
  /** True while the phase is folded over the agent whose tab is active. */
  selected: boolean;
  onToggle: (tabId: string, foldId: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  const label = title || t("subagents.noPhase");
  const foldLabel = folded ? t("subagents.expandPhase") : t("subagents.collapsePhase");
  const toggle = () => onToggle(tabId, phaseKey);

  return (
    <div
      data-testid="workflow-phase-row"
      data-phase-key={phaseKey}
      aria-expanded={!folded}
      onClick={toggle}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-[3px] text-[12.5px] select-none transition-colors",
        indentClass(indent),
        selected
          ? "bg-[var(--color-sel)] text-[var(--color-fg)]"
          : "text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]",
      )}
    >
      <FoldChevron testId="workflow-phase-fold" folded={folded} label={foldLabel} onToggle={toggle} />
      <RowIcon name="layers" light />
      <span className="min-w-0 flex-1 truncate" title={label}>{label}</span>
    </div>
  );
});

/** Where the selected agent sits in a run, as strings so the list moves
 *  only when the selection itself moves to another run or phase. */
function useSelectedRunPlace(tabId: string, selectedAgentId: string | null): { runId: string | null; phase: string | null } {
  const runId = useSubagents(s => {
    if (selectedAgentId === null) return null;
    return s.byTab[tabId]?.agents[selectedAgentId]?.workflowRunId ?? null;
  });
  const phase = useSubagents(s => {
    if (selectedAgentId === null) return null;
    return s.byTab[tabId]?.agents[selectedAgentId]?.workflowPhase ?? null;
  });
  return { runId, phase };
}

function isPhaseOverSelection(row: SubagentPhaseRow, folded: boolean, place: { runId: string | null; phase: string | null }): boolean {
  const isSelectedRun = place.runId === row.runId;
  const isSelectedPhase = place.phase === row.title;
  return folded && isSelectedRun && isSelectedPhase;
}

/** Every subagent row of one tab, flat and keyed: an agent by its id, a run
 *  and a phase by their own keys. A row that moves to a new parent is the
 *  same DOM node in its new place. */
export const SubagentRows = memo(function SubagentRows({ taskId, tabId, selectedAgentId }: {
  taskId: string;
  tabId: string;
  /** The agent whose tab is the active one, when that is in this task. */
  selectedAgentId: string | null;
}) {
  const { structureKey, rules } = useVisibleSubagentStructure(tabId);
  const { collapsed } = useSubagentGroupFold(tabId, rules);
  const foldedIds = useSubagentFold(s => s.byTab[tabId] ?? EMPTY_FOLD);
  const toggleFold = useSubagentFold(s => s.toggle);
  const toggleRun = useSubagentFold(s => s.toggleRun);
  const selectedPlace = useSelectedRunPlace(tabId, selectedAgentId);

  const rows = useMemo(() => subagentRowsOfKey(structureKey, new Set(foldedIds)), [structureKey, foldedIds]);

  if (rows.length === 0 || collapsed) return null;

  return (
    <>
      {rows.map(row => {
        const indent = subagentRowIndent(row);

        if (row.kind === "run") {
          const isOverSelection = !row.open && selectedPlace.runId === row.runId;
          return (
            <WorkflowRunRow
              key={row.key}
              tabId={tabId}
              runId={row.runId}
              indent={indent}
              open={row.open}
              selected={isOverSelection}
              rules={rules}
              onToggle={toggleRun}
            />
          );
        }

        if (row.kind === "phase") {
          const folded = foldedIds.includes(row.key);
          return (
            <PhaseRow
              key={row.key}
              tabId={tabId}
              phaseKey={row.key}
              title={row.title}
              indent={indent}
              folded={folded}
              selected={isPhaseOverSelection(row, folded, selectedPlace)}
              onToggle={toggleFold}
            />
          );
        }

        return (
          <SubagentRow
            key={row.key}
            taskId={taskId}
            tabId={tabId}
            agentId={row.agentId}
            depth={indent}
            hasChildren={row.hasChildren}
            folded={foldedIds.includes(row.agentId)}
            selected={row.agentId === selectedAgentId}
          />
        );
      })}
    </>
  );
});

/** Whether the agent whose tab is active has a row under one of `tabIds`
 *  under the current type filter and retention, for the task header's
 *  highlight. A boolean, so a subagent starting or finishing re-renders no
 *  task row. Retention is measured as of the task row's last render. */
export function useSubagentHasRow(tabIds: readonly string[], agentId: string | null): boolean {
  const typeFilter = usePrefs(s => s.subagentTypeFilter);
  const retention = usePrefs(s => s.subagentRetention);
  const retentionMs = retentionWindowMs(retention);
  const now = Date.now();

  return useSubagents(s => hasSubagentRow(s.byTab, tabIds, agentId, { typeFilter, retentionMs, now }));
}
