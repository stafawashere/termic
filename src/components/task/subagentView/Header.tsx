import type { TFunction } from "i18next";
import { modelDisplayName } from "@/lib/subagentCliView";
import { BLOCK_QUADRANTS, GLYPH, MASCOT_ROWS, MASCOT_WIDTH } from "./glyphs";

const MASCOT_GAP_CELLS = 2;

/** The mascot on a grid of half cells, one box per filled quarter. */
function Mascot() {
  const quarters = MASCOT_ROWS.flatMap((row, rowIndex) =>
    [...row].flatMap((glyph, column) => {
      const fills = BLOCK_QUADRANTS[glyph];
      if (!fills) return [];

      return fills.flatMap((filled, quarter) => {
        if (!filled) return [];

        const isRight = quarter % 2 === 1;
        const isBottom = quarter >= 2;
        return [{
          key: `${rowIndex}-${column}-${quarter}`,
          gridColumn: column * 2 + (isRight ? 2 : 1),
          gridRow: rowIndex * 2 + (isBottom ? 2 : 1),
        }];
      });
    }),
  );

  return (
    <div
      aria-hidden
      data-testid="subagent-mascot"
      className="grid shrink-0"
      style={{
        gridTemplateColumns: `repeat(${MASCOT_WIDTH * 2}, calc(var(--cell) / 2))`,
        gridTemplateRows: `repeat(${MASCOT_ROWS.length * 2}, calc(var(--row) / 2))`,
        width: `calc(var(--cell) * ${MASCOT_WIDTH})`,
      }}
    >
      {quarters.map(cell => (
        <span
          key={cell.key}
          className="bg-[var(--cc-claude)]"
          style={{ gridColumn: cell.gridColumn, gridRow: cell.gridRow }}
        />
      ))}
    </div>
  );
}

/** Claude's welcome banner for the agent this tab shows: the mascot, the
 *  product and version, the model and agent type, and one line about the
 *  view itself. */
export function Header({ agentType, description, model, version, workflowPhase, t }: {
  agentType: string | null;
  description: string | null;
  model: string | null;
  version: string | null;
  workflowPhase: string | null;
  t: TFunction<"task">;
}) {
  const separator = ` ${GLYPH.middot} `;
  const modelLine = [model ? modelDisplayName(model) : null, agentType]
    .filter((fact): fact is string => !!fact)
    .join(separator);
  const aboutLine = [description, workflowPhase, t("subagentView.readOnly")]
    .filter((fact): fact is string => !!fact)
    .join(separator);

  return (
    <div data-testid="subagent-header" className="flex shrink-0 pb-[calc(var(--row)*2)] pt-[var(--row)]">
      <Mascot />
      <div className="min-w-0 flex-1" style={{ paddingLeft: `calc(var(--cell) * ${MASCOT_GAP_CELLS})` }}>
        <div className="truncate whitespace-pre">
          <span className="font-bold text-[var(--cc-text)]">{t("subagentView.bannerProduct")}</span>
          {version && <span className="text-[var(--cc-dim)]"> v{version}</span>}
        </div>
        <div data-testid="subagent-header-model" className="truncate whitespace-pre text-[var(--cc-dim)]">{modelLine || "\u00A0"}</div>
        <div className="truncate whitespace-pre text-[var(--cc-dim)]">{aboutLine}</div>
      </div>
    </div>
  );
}
