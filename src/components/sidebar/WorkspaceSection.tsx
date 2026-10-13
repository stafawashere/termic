// The sidebar's workspace view header: the saved workspaces as a row of
// chips (one active), the button that opens the manager, and the two empty
// states. The projects themselves are the sidebar's own tree, filtered by
// the active workspace's ids in Sidebar.tsx. This file owns only the picker.

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings2 } from "lucide-react";
import { useWorkspaces } from "@/store/workspaces";
import { Tip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/utils";

const WorkspaceManagerDialog = lazy(() => import("@/components/dialogs/WorkspaceManagerDialog"));

export function WorkspaceSection() {
  const { t } = useTranslation("sidebar");
  const workspaces = useWorkspaces(s => s.workspaces);
  const activeId = useWorkspaces(s => s.activeId);
  const setActive = useWorkspaces(s => s.setActive);
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerMounted, setManagerMounted] = useState(false);

  const active = workspaces.find(workspace => workspace.id === activeId) ?? null;
  const hasWorkspaces = workspaces.length > 0;
  const activeIsEmpty = !!active && active.projectIds.length === 0;

  const openManager = () => {
    setManagerMounted(true);
    setManagerOpen(true);
  };

  return (
    <div data-testid="workspace-section" className="flex flex-col gap-2 px-[10px] pb-2 pt-1">
      <div className="flex items-center gap-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1" role="tablist" aria-label={t("workspaceHeader")}>
          {workspaces.map(workspace => {
            const isActive = workspace.id === activeId;
            return (
              <button
                key={workspace.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid="workspace-chip"
                data-workspace-id={workspace.id}
                data-active={isActive || undefined}
                onClick={() => setActive(workspace.id)}
                className={cn(
                  "max-w-full truncate rounded-[6px] px-2 py-[3px] text-[12px] transition-[color,background-color]",
                  isActive
                    ? "bg-[var(--sidebar-row-active)] font-medium text-[var(--sidebar-btn-hover-ink)]"
                    : "text-[var(--sidebar-muted)] hover:bg-[var(--sidebar-row-hover)]",
                )}
              >
                {workspace.name}
              </button>
            );
          })}
        </div>
        <Tip content={t("workspaceManage")} side="bottom">
          <button
            type="button"
            aria-label={t("workspaceManage")}
            data-testid="workspace-manage"
            onClick={openManager}
            className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[5px] text-[var(--sidebar-icon)] hover:bg-[var(--sidebar-row-hover)] hover:text-[var(--sidebar-btn-hover-ink)]"
          >
            <Settings2 className="h-[14px] w-[14px]" />
          </button>
        </Tip>
      </div>

      {!hasWorkspaces && (
        <div data-testid="workspace-empty-none" className="text-[12px] leading-[1.4] text-[var(--sidebar-muted)]">
          {t("workspaceNone")}
        </div>
      )}
      {hasWorkspaces && !active && (
        <div data-testid="workspace-empty-unselected" className="text-[12px] leading-[1.4] text-[var(--sidebar-muted)]">
          {t("workspacePick")}
        </div>
      )}
      {activeIsEmpty && (
        <div data-testid="workspace-empty-projects" className="text-[12px] leading-[1.4] text-[var(--sidebar-muted)]">
          {t("workspaceNoProjects")}
        </div>
      )}

      {managerMounted && (
        <Suspense fallback={null}>
          <WorkspaceManagerDialog open={managerOpen} onOpenChange={setManagerOpen} />
        </Suspense>
      )}
    </div>
  );
}
