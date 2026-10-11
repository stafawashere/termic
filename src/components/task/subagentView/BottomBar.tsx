import type { TFunction } from "i18next";
import { cn } from "@/lib/utils";
import { nextTruncateLines } from "@/lib/subagentPrefs";
import { usePrefs } from "@/store/prefs";
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

/** The view's own settings as one dim row under the agent list, in the
 *  place and style claude keeps its mode line. Every toggle writes the
 *  same pref Settings does, so the two always agree. Verbose is ctrl+o's
 *  state and belongs to this pane only. */
export function BottomBar({ verbose, onToggleVerbose, t }: {
  verbose: boolean;
  onToggleVerbose: () => void;
  t: TFunction<"task">;
}) {
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

  const cuts = truncateLines > 0;
  const cutValue = cuts ? t("subagentView.barLines", { count: truncateLines }) : t("subagentView.barOff");
  const separator = <span aria-hidden className="shrink-0 whitespace-pre text-[var(--cc-dim)]">{` ${GLYPH.middot} `}</span>;

  return (
    <div
      data-testid="subagent-bottom-bar"
      role="toolbar"
      aria-label={t("subagentView.barLabel")}
      className="flex min-w-0 flex-wrap pt-[var(--row)]"
      style={{ paddingLeft: "calc(var(--cell) * 2)", paddingRight: "calc(var(--cell) * 2)" }}
    >
      <Toggle id="verbose" label={t("subagentView.barVerbose")} on={verbose} onFlip={onToggleVerbose} t={t} />
      <span aria-hidden className="shrink-0 whitespace-pre text-[var(--cc-dim)]"> {t("subagentView.barVerboseHint")}</span>
      {separator}
      <Toggle id="thinking" label={t("subagentView.barThinking")} on={showThinking} onFlip={() => setShowThinking(!showThinking)} t={t} />
      {separator}
      <Toggle id="inputs" label={t("subagentView.barInputs")} on={showToolInputs} onFlip={() => setShowToolInputs(!showToolInputs)} t={t} />
      {separator}
      <Toggle id="outputs" label={t("subagentView.barOutputs")} on={showToolOutputs} onFlip={() => setShowToolOutputs(!showToolOutputs)} t={t} />
      {separator}
      <Toggle
        id="cut"
        label={t("subagentView.barCut")}
        on={cuts}
        value={cutValue}
        onFlip={() => setTruncateLines(nextTruncateLines(truncateLines))}
        t={t}
      />
      {separator}
      <Toggle id="follow" label={t("subagentView.barFollow")} on={autoScroll} onFlip={() => setAutoScroll(!autoScroll)} t={t} />
    </div>
  );
}
