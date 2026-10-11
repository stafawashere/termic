// Top-bar "N agents waiting" pill (issue #56). Renders ONLY when at least
// one agent is waiting on the user (finished a turn or blocked on input) —
// a dead button would be worse than none. Clicking jumps to the next waiting
// agent, cycling the whole queue on repeated presses (same as ⇧⌘A). Both
// the count and the jump come from `@/lib/waitingAgents` so they can't drift
// from the keyboard shortcut.

import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { Tip } from "@/components/ui/Tooltip";
import { Bell } from "lucide-react";
import { bindingGlyphs, bindingText } from "@/lib/shortcuts";
import { waitingAttentionCount, waitingDoneCount, jumpToNextWaiting } from "@/lib/waitingAgents";

export function WaitingAgentsPill() {
  const { t } = useTranslation("chrome");
  // Subscribe to the pref so toggling the work-done UI updates the pill live;
  // waitingCount also honors it, but the subscription is what re-renders us.
  const settled = usePrefs(s => s.settledHighlight);
  // Selector returns a number, so the pill only re-renders when the COUNT
  // changes, not on every unrelated app-store write.
  //
  // TWO counts, each under its own mark. It used to be one number beside a
  // bell, which said "1 needs you" for a task that had only finished, right
  // above a sidebar chip row reading Needs you 0, Done 1. The bell is for an
  // agent blocked on you and the dot for a turn you have not read, here as
  // everywhere else (docs/ui.md "One glyph per meaning").
  const attention = useApp(waitingAttentionCount);
  const done = useApp(waitingDoneCount);
  const count = attention + done;
  const binding = usePrefs(s => s.shortcuts["jump-next-waiting"]);

  if (!settled || count < 1) return null;

  const glyphs = bindingText(binding);
  const label = `${t("waitingPill.jump")}${glyphs ? ` (${glyphs})` : ""}`;

  return (
    <Tip content={label} side="bottom">
      <button
        type="button"
        data-no-drag
        onClick={() => { jumpToNextWaiting(); }}
        aria-label={label}
        data-testid="waiting-agents-pill"
        data-attention={attention}
        data-done={done}
        // Only the bell is warn-toned, and only while something is BLOCKED.
        // A pill that is amber because a turn finished cries wolf for the
        // case that matters.
        className="titlebar-well titlebar-waiting select-none"
      >
        {attention > 0 && (
          <span className="titlebar-ink flex items-center gap-1 text-[var(--color-warn)]">
            <Bell className="h-3 w-3" />
            <span className="tabular-nums leading-none">{attention}</span>
          </span>
        )}
        {done > 0 && (
          <span className="titlebar-ink flex items-center gap-1 text-[var(--color-info)]">
            <span className="h-[7px] w-[7px] rounded-full bg-current" />
            <span className="tabular-nums leading-none">{done}</span>
          </span>
        )}
      </button>
    </Tip>
  );
}
