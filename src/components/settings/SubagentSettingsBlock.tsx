// Settings > Tasks > Claude subagents: the master toggle, which kinds of
// subagent get a sidebar row, how long finished rows stay, whether a tab's
// group starts folded, and how the transcript view draws. Every control
// applies to the running window at once.
//
// The row settings are profile-scoped and the view settings are global; see
// the prefs they write in store/prefs.ts.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";
import type { SubagentKind } from "@/lib/subagentKind";
import {
  SUBAGENT_AUTO_COLLAPSES, SUBAGENT_RETENTIONS, type SubagentAutoCollapse, type SubagentRetention,
} from "@/lib/subagentPrefs";
import { usePrefs } from "@/store/prefs";
import { Block, Toggle } from "./Controls";

function Segmented<T extends string>({ testId, options, value, onChange, disabled }: {
  testId: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-stretch rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-[3px]",
        disabled && "opacity-40",
      )}
    >
      {options.map(([id, label]) => {
        const isSelected = value === id;
        return (
          <button
            key={id}
            type="button"
            data-value={id}
            aria-pressed={isSelected}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={cn(
              "h-7 rounded-[5px] px-2.5 text-[12px] transition-colors",
              isSelected
                ? "bg-[var(--color-accent-deep)] text-white"
                : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
            )}
          >{label}</button>
        );
      })}
    </div>
  );
}

function ChoiceRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">{label}</div>
        <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{hint}</div>
      </div>
      {children}
    </div>
  );
}

const EDITABLE_KINDS: readonly SubagentKind[] = ["builtIn", "custom", "fork", "workflow"];

export function SubagentSettingsBlock() {
  const { t } = useTranslation("settings");

  const enabled = usePrefs(s => s.subagentsEnabled);
  const setEnabled = usePrefs(s => s.setSubagentsEnabled);
  const typeFilter = usePrefs(s => s.subagentTypeFilter);
  const setTypeFilter = usePrefs(s => s.setSubagentTypeFilter);
  const retention = usePrefs(s => s.subagentRetention);
  const setRetention = usePrefs(s => s.setSubagentRetention);
  const autoCollapse = usePrefs(s => s.subagentAutoCollapse);
  const setAutoCollapse = usePrefs(s => s.setSubagentAutoCollapse);
  const showThinking = usePrefs(s => s.subagentViewShowThinking);
  const setShowThinking = usePrefs(s => s.setSubagentViewShowThinking);
  const showToolInputs = usePrefs(s => s.subagentViewShowToolInputs);
  const setShowToolInputs = usePrefs(s => s.setSubagentViewShowToolInputs);
  const showToolOutputs = usePrefs(s => s.subagentViewShowToolOutputs);
  const setShowToolOutputs = usePrefs(s => s.setSubagentViewShowToolOutputs);
  const truncateLines = usePrefs(s => s.subagentViewTruncateLines);
  const setTruncateLines = usePrefs(s => s.setSubagentViewTruncateLines);
  const autoScroll = usePrefs(s => s.subagentViewAutoScroll);
  const setAutoScroll = usePrefs(s => s.setSubagentViewAutoScroll);

  // Same draft as the board limit above it: clearing the field to retype must
  // not store 0, which here would mean "never cut".
  const [linesDraft, setLinesDraft] = useState<string | null>(null);

  const rowsDisabled = !enabled;

  const retentionOptions = SUBAGENT_RETENTIONS.map(
    id => [id, t(`tasks.subagents.retention.${id}`)] as const,
  ) as readonly (readonly [SubagentRetention, string])[];
  const autoCollapseOptions = SUBAGENT_AUTO_COLLAPSES.map(
    id => [id, t(`tasks.subagents.autoCollapse.${id}`)] as const,
  ) as readonly (readonly [SubagentAutoCollapse, string])[];

  const onLinesInput = (raw: string) => {
    setLinesDraft(raw);

    const lines = Number(raw);
    const isWholeCount = raw.trim() !== "" && Number.isInteger(lines) && lines >= 0;
    if (isWholeCount) setTruncateLines(lines);
  };

  return (
    <Block id="settings-claude-subagents">
      <div data-testid="subagent-settings" className="flex flex-col gap-5">
        <div>
          <div className="text-[14px] font-medium">{t("tasks.subagents.title")}</div>
          <div className="mt-0.5 text-[12.5px] text-[var(--color-fg-dim)]">{t("tasks.subagents.hint")}</div>
        </div>

        <div data-testid="subagent-setting-enabled">
          <Toggle
            label={t("tasks.subagents.enabled.label")}
            hint={t("tasks.subagents.enabled.hint")}
            value={enabled}
            onChange={setEnabled}
          />
        </div>

        <div className="flex flex-col gap-4">
          <div className="text-[13px] font-medium text-[var(--color-fg-dim)]">{t("tasks.subagents.types.title")}</div>
          {EDITABLE_KINDS.map(kind => (
            <div key={kind} data-testid={`subagent-setting-type-${kind}`}>
              <Toggle
                label={t(`tasks.subagents.types.${kind}.label`)}
                hint={t(`tasks.subagents.types.${kind}.hint`)}
                value={typeFilter[kind]}
                onChange={value => setTypeFilter(kind, value)}
                disabled={rowsDisabled}
              />
            </div>
          ))}
        </div>

        <ChoiceRow label={t("tasks.subagents.retention.label")} hint={t("tasks.subagents.retention.hint")}>
          <Segmented
            testId="subagent-setting-retention"
            options={retentionOptions}
            value={retention}
            onChange={setRetention}
            disabled={rowsDisabled}
          />
        </ChoiceRow>

        <ChoiceRow label={t("tasks.subagents.autoCollapse.label")} hint={t("tasks.subagents.autoCollapse.hint")}>
          <Segmented
            testId="subagent-setting-auto-collapse"
            options={autoCollapseOptions}
            value={autoCollapse}
            onChange={setAutoCollapse}
            disabled={rowsDisabled}
          />
        </ChoiceRow>

        <div className="flex flex-col gap-4">
          <div className="text-[13px] font-medium text-[var(--color-fg-dim)]">{t("tasks.subagents.view.title")}</div>
          <div data-testid="subagent-setting-view-thinking">
            <Toggle
              label={t("tasks.subagents.view.thinking.label")}
              hint={t("tasks.subagents.view.thinking.hint")}
              value={showThinking}
              onChange={setShowThinking}
            />
          </div>
          <div data-testid="subagent-setting-view-tool-inputs">
            <Toggle
              label={t("tasks.subagents.view.toolInputs.label")}
              hint={t("tasks.subagents.view.toolInputs.hint")}
              value={showToolInputs}
              onChange={setShowToolInputs}
            />
          </div>
          <div data-testid="subagent-setting-view-tool-outputs">
            <Toggle
              label={t("tasks.subagents.view.toolOutputs.label")}
              hint={t("tasks.subagents.view.toolOutputs.hint")}
              value={showToolOutputs}
              onChange={setShowToolOutputs}
            />
          </div>
          <ChoiceRow label={t("tasks.subagents.view.truncate.label")} hint={t("tasks.subagents.view.truncate.hint")}>
            <div className="flex shrink-0 items-center gap-2">
              <Input
                type="number"
                min={0}
                value={linesDraft ?? String(truncateLines)}
                onChange={(e) => onLinesInput(e.target.value)}
                onBlur={() => setLinesDraft(null)}
                className="w-20 font-mono"
                data-testid="subagent-setting-view-truncate"
              />
              <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("tasks.subagents.view.truncate.lines")}</span>
            </div>
          </ChoiceRow>
          <div data-testid="subagent-setting-view-auto-scroll">
            <Toggle
              label={t("tasks.subagents.view.autoScroll.label")}
              hint={t("tasks.subagents.view.autoScroll.hint")}
              value={autoScroll}
              onChange={setAutoScroll}
            />
          </div>
        </div>
      </div>
    </Block>
  );
}
