// The centred task title: agent glyph, task, project, branch. The whole pill
// opens the task finder, the same dialog as its shortcut, so the bar does not
// grow a second task switcher.
//
// A task whose label IS its branch (never renamed, or the "use branch as task
// name" pref, GH #260) shows the branch once: the branch segment would only
// repeat the name it follows.

import { useTranslation } from "react-i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { usePrefs } from "@/store/prefs";
import { taskLabel } from "@/lib/taskLabel";
import { bindingText } from "@/lib/shortcuts";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { Tip } from "@/components/ui/Tooltip";
import { ChevronDownGlyph, TitleBranchGlyph, TitleLinkGlyph } from "@/components/titlebar/titlebarIcons";
import { cn } from "@/lib/utils";
import type { Project, Task } from "@/lib/types";

export function FocusTitle({ task, project }: { task: Task | null; project: Project | null | undefined }) {
  const { t } = useTranslation("chrome");
  const agents = useApp(s => s.agents);
  const useBranchAsTaskName = usePrefs(s => s.useBranchAsTaskName);
  const finderBinding = usePrefs(s => s.shortcuts["task-finder"]);
  const finderOpen = useUI(s => s.taskFinderOpen);

  if (!task || !project) {
    return (
      <div data-testid="task-breadcrumb" className="titlebar-title titlebar-ink" data-empty="">
        <span className="titlebar-title-project">{t("unifiedBar.noTask")}</span>
      </div>
    );
  }

  const label = taskLabel(task, useBranchAsTaskName);
  const labelIsBranch = label === task.branch;
  const iconId = resolveIconId(task.cli, agents);
  const memberCount = task.composition?.length ?? 0;
  const glyphs = finderBinding ? bindingText(finderBinding) : "";
  const tip = glyphs ? `${t("unifiedBar.switchTask")} (${glyphs})` : t("unifiedBar.switchTask");
  const location = task.is_main_checkout ? t("taskLocation.main") : t("taskLocation.worktree");
  const renamedTitle = label === task.name ? undefined : t("taskNameTitle", { name: task.name });

  return (
    <Tip content={tip} side="bottom">
      <button
        type="button"
        data-no-drag
        data-testid="task-breadcrumb"
        aria-haspopup="dialog"
        aria-expanded={finderOpen}
        aria-label={tip}
        className="titlebar-title"
        onClick={() => useUI.getState().openTaskFinder()}
      >
        <span className={cn("titlebar-title-agent titlebar-ink", CLI_BRAND_COLOR[iconId])}>
          <CliIcon cli={iconId} className="h-[15px] w-[15px]" />
        </span>
        <span className="titlebar-title-name titlebar-ink" title={renamedTitle}>{label}</span>
        <span className="titlebar-title-rule" />
        <span className="titlebar-title-project titlebar-ink">{project.name}</span>
        {!labelIsBranch && (
          <>
            <span className="titlebar-title-rule" />
            <span className="titlebar-title-branch titlebar-mono titlebar-ink" title={task.is_main_checkout ? undefined : location}>
              <TitleBranchGlyph size={13} className="shrink-0" />
              <span className="truncate">{task.branch}</span>
            </span>
          </>
        )}
        {task.is_main_checkout && (
          <span title={location} className="titlebar-title-link titlebar-ink">
            <TitleLinkGlyph size={13} />
          </span>
        )}
        {memberCount > 0 && (
          <span
            className="sidebar-badge"
            title={task.composition!.map(m => m.mode === "worktree" ? `${m.dir_name} @${m.branch}` : `${m.dir_name} ${t("unifiedBar.live")}`).join(" · ")}
          >
            {t("unifiedBar.repoCount", { count: memberCount })}
          </span>
        )}
        <ChevronDownGlyph size={12} className="titlebar-title-chevron titlebar-ink" />
      </button>
    </Tip>
  );
}
