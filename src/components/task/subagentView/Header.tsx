import type { TFunction } from "i18next";
import { GLYPH } from "./glyphs";

/** One dim row naming what this tab shows. Claude's own transcript has no
 *  header; this row keeps the tab's context without drawing a box. */
export function Header({ title, agentType, model, workflowPhase, t }: {
  title: string;
  agentType: string | null;
  model: string | null;
  workflowPhase: string | null;
  t: TFunction<"task">;
}) {
  const typeIsTitle = agentType === title;
  const facts = [title, typeIsTitle ? null : agentType, model, workflowPhase, t("subagentView.readOnly")]
    .filter((fact): fact is string => !!fact)
    .join(` ${GLYPH.middot} `);

  return (
    <div data-testid="subagent-header" className="shrink-0 truncate px-[var(--cell)] pb-[var(--row)] text-[var(--cc-dim)]">
      {facts}
    </div>
  );
}
