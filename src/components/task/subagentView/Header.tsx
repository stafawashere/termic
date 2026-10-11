import type { TFunction } from "i18next";
import { GLYPH } from "./glyphs";

/** The rounded box Claude Code opens a session with: the star and a title,
 *  and a dim line of facts under it. */
export function Header({ title, agentType, model, workflowPhase, t }: {
  title: string;
  agentType: string | null;
  model: string | null;
  workflowPhase: string | null;
  t: TFunction<"task">;
}) {
  const typeIsTitle = agentType === title;
  const facts = [typeIsTitle ? null : agentType, model, workflowPhase, t("subagentView.readOnly")]
    .filter((fact): fact is string => !!fact)
    .join(` ${GLYPH.middot} `);

  return (
    <div
      data-testid="subagent-header"
      className="mx-3 mt-[0.6em] mb-[1.2em] shrink-0 rounded-md border border-[var(--color-cli-claude)] px-[1ch] py-[0.3em]"
    >
      <div className="flex min-w-0">
        <span aria-hidden className="w-[2ch] shrink-0 text-[var(--color-cli-claude)]">{GLYPH.star}</span>
        <span className="truncate font-bold text-[var(--color-fg)]">{title}</span>
      </div>
      <div className="truncate pl-[2ch] text-[var(--color-fg-dim)]">{facts}</div>
    </div>
  );
}
