// The row of one workflow run under a claude tab. A run can hold hundreds of
// agents, so the row reads one counts string and its name, never an agent
// record: an agent starting or stopping inside the run re-renders this row
// only when a count moves (see "workflow runs" in store/selectorFanout.test.ts).
//
// The row is not a tab. Clicking it folds or unfolds the run and opens
// nothing.

import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useSubagents, type SubagentState } from "@/store/subagents";
import {
  createWorkflowRunCountsSelector, selectWorkflowRunName, type SubagentGuideLines, type SubagentRowRules,
} from "./subagentTree";
import { FoldChevron, RowIcon, StateWord, subagentRowClass, subagentRowStyle, TreeLines } from "./subagentRowParts";

type RunState = Extract<SubagentState, "running" | "failed" | "done">;

interface RunCounts {
  running: number;
  total: number;
  failed: number;
}

function parseRunCounts(counts: string): RunCounts {
  const [running, total, failed] = counts.split("/").map(Number);
  return { running, total, failed };
}

/** Running while any agent runs, failed once one failed, done otherwise. */
function runStateOf(counts: RunCounts): RunState {
  if (counts.running > 0) return "running";
  if (counts.failed > 0) return "failed";
  return "done";
}

function runStateCopy(state: RunState, t: TFunction<"sidebar">): { label: string; hint: string } {
  switch (state) {
    case "running":
      return { label: t("subagents.running"), hint: t("subagents.runRunningHint") };
    case "failed":
      return { label: t("subagents.failed"), hint: t("subagents.runFailedHint") };
    case "done":
      return { label: t("subagents.done"), hint: t("subagents.runDoneHint") };
  }
}

export const WorkflowRunRow = memo(function WorkflowRunRow({ tabId, runId, indent, lines, open, selected, rules, onToggle }: {
  tabId: string;
  runId: string;
  indent: number;
  lines: SubagentGuideLines;
  open: boolean;
  /** True while the run is folded over the agent whose tab is active. */
  selected: boolean;
  rules: SubagentRowRules;
  onToggle: (tabId: string, runId: string) => void;
}) {
  const { t } = useTranslation("sidebar");
  const selectCounts = useMemo(() => createWorkflowRunCountsSelector(tabId, runId, rules), [tabId, runId, rules]);
  const selectName = useMemo(() => selectWorkflowRunName(tabId, runId), [tabId, runId]);
  const countsKey = useSubagents(selectCounts);
  const name = useSubagents(selectName);

  const counts = parseRunCounts(countsKey);
  const runState = runStateOf(counts);
  const copy = runStateCopy(runState, t);
  const countHint = t("subagents.runCountHint", { running: counts.running, total: counts.total });
  const foldLabel = open ? t("subagents.collapseRun") : t("subagents.expandRun");
  const toggle = () => onToggle(tabId, runId);

  return (
    <div
      data-testid="workflow-run-row"
      data-run-id={runId}
      data-run-state={runState}
      aria-expanded={open}
      onClick={toggle}
      className={subagentRowClass(selected, "text-[var(--sidebar-ink)]")}
      style={subagentRowStyle(indent)}
    >
      <TreeLines depth={indent} lines={lines} />
      <FoldChevron testId="workflow-run-fold" folded={!open} label={foldLabel} onToggle={toggle} />
      <RowIcon name="workflow" selected={selected} />
      <span className="min-w-0 flex-1 truncate font-medium" title={name}>{name}</span>
      <span
        data-testid="workflow-run-count"
        title={countHint}
        className="sidebar-badge"
      >
        {counts.running}/{counts.total}
      </span>
      <span
        data-testid="workflow-run-badge"
        data-run-state={runState}
        role="img"
        aria-label={copy.label}
        title={copy.hint}
        className="flex shrink-0 items-center justify-end"
      >
        <StateWord state={runState} />
      </span>
    </div>
  );
});
