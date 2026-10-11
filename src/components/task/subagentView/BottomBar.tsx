import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { nextTruncateLines } from "@/lib/subagentPrefs";
import type { SubagentViewConfig, SubagentViewOverrides } from "@/lib/subagentViewConfig";
import { GLYPH } from "./glyphs";

function Toggle({ id, label, on, onFlip, value, t }: {
  id: string;
  label: string;
  on: boolean;
  onFlip: () => void;
  /** Shown in place of on/off, for a setting that is not a switch. */
  value?: string;
  t: TFunction<"task">;
}) {
  return (
    <button
      type="button"
      data-testid={`subagent-bar-${id}`}
      data-on={on}
      aria-pressed={on}
      onClick={onFlip}
      className="shrink-0 whitespace-pre text-[var(--cc-dim)] hover:text-[var(--cc-text)]"
    >
      {label}{" "}
      <span className={cn(on ? "text-[var(--cc-suggestion)]" : "text-[var(--cc-dim)]")}>
        {value ?? (on ? t("subagentView.barOn") : t("subagentView.barOff"))}
      </span>
    </button>
  );
}

/** The view's own settings as one dim row in the place and style claude
 *  keeps its mode line: a blank row above, two cells in, one line, parts
 *  joined by a middle dot, then a blank row before the agent list. A
 *  toggle changes this agent's view only and is remembered across loads;
 *  Settings holds the defaults. */
export function BottomBar({ config, onChange, onToggleVerbose, t }: {
  config: SubagentViewConfig;
  onChange: (patch: SubagentViewOverrides) => void;
  onToggleVerbose: () => void;
  t: TFunction<"task">;
}) {
  const { verbose, showThinking, showToolInputs, showToolOutputs, truncateLines, autoScroll } = config;
  const cuts = truncateLines > 0;
  const cutValue = cuts ? t("subagentView.barLines", { count: truncateLines }) : t("subagentView.barOff");
  const separator = <span aria-hidden className="shrink-0 whitespace-pre text-[var(--cc-dim)]">{` ${GLYPH.middot} `}</span>;

  return (
    <div
      data-testid="subagent-bottom-bar"
      role="toolbar"
      aria-label={t("subagentView.barLabel")}
      className="flex min-w-0 overflow-hidden whitespace-pre pt-[var(--row)]"
      style={{ paddingLeft: "calc(var(--cell) * 2)", paddingRight: "calc(var(--cell) * 2)" }}
    >
      <Toggle id="verbose" label={t("subagentView.barVerbose")} on={verbose} onFlip={onToggleVerbose} t={t} />
      <span aria-hidden className="shrink-0 whitespace-pre text-[var(--cc-dim)]"> {t("subagentView.barVerboseHint")}</span>
      {separator}
      <Toggle id="thinking" label={t("subagentView.barThinking")} on={showThinking} onFlip={() => onChange({ showThinking: !showThinking })} t={t} />
      {separator}
      <Toggle id="inputs" label={t("subagentView.barInputs")} on={showToolInputs} onFlip={() => onChange({ showToolInputs: !showToolInputs })} t={t} />
      {separator}
      <Toggle id="outputs" label={t("subagentView.barOutputs")} on={showToolOutputs} onFlip={() => onChange({ showToolOutputs: !showToolOutputs })} t={t} />
      {separator}
      <Toggle
        id="cut"
        label={t("subagentView.barCut")}
        on={cuts}
        value={cutValue}
        onFlip={() => onChange({ truncateLines: nextTruncateLines(truncateLines) })}
        t={t}
      />
      {separator}
      <Toggle id="follow" label={t("subagentView.barFollow")} on={autoScroll} onFlip={() => onChange({ autoScroll: !autoScroll })} t={t} />
    </div>
  );
}
