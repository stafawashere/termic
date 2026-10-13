// Create, rename, delete and fill workspaces (the sidebar's workspace view).
// Mounted lazily by WorkspaceSection, so the dialog's code is not part of the
// sidebar's first paint. Everything it edits lives in store/workspaces.ts.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { useApp } from "@/store/app";
import { useWorkspaces } from "@/store/workspaces";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/utils";

export default function WorkspaceManagerDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation("dialogs");
  const projects = useApp(s => s.projects);
  const workspaces = useWorkspaces(s => s.workspaces);
  const activeId = useWorkspaces(s => s.activeId);

  const [selectedId, setSelectedId] = useState<string | null>(activeId);
  const [newName, setNewName] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const selected = workspaces.find(workspace => workspace.id === selectedId) ?? null;
  const selectedName = selected?.name ?? "";

  useEffect(() => {
    if (open) setSelectedId(useWorkspaces.getState().activeId);
  }, [open]);

  useEffect(() => {
    setRenameDraft(selectedName);
  }, [selectedId, selectedName]);

  useEffect(() => {
    setConfirmingDelete(false);
  }, [selectedId, open]);

  const canCreate = newName.trim() !== "";
  const canRename = !!selected && renameDraft.trim() !== "" && renameDraft.trim() !== selectedName;

  const create = () => {
    if (!canCreate) return;
    const id = useWorkspaces.getState().create(newName);
    if (id) setSelectedId(id);
    setNewName("");
  };

  const rename = () => {
    if (!selected || !canRename) return;
    useWorkspaces.getState().rename(selected.id, renameDraft);
  };

  const remove = () => {
    if (!selected) return;
    useWorkspaces.getState().remove(selected.id);
    setConfirmingDelete(false);
    setSelectedId(useWorkspaces.getState().activeId);
  };

  const toggleProject = (projectId: string, included: boolean) => {
    if (!selected) return;
    const actions = useWorkspaces.getState();
    if (included) actions.addProject(selected.id, projectId);
    else actions.removeProject(selected.id, projectId);
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("workspaceManager.title")}
      description={t("workspaceManager.description")}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4" data-testid="workspace-manager">
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") create(); }}
            placeholder={t("workspaceManager.newPlaceholder")}
            data-testid="workspace-new-name"
          />
          <Button onClick={create} disabled={!canCreate} data-testid="workspace-new-create">
            {t("workspaceManager.create")}
          </Button>
        </div>

        {workspaces.length === 0 ? (
          <div data-testid="workspace-manager-empty" className="text-[13px] text-[var(--color-fg-dim)]">
            {t("workspaceManager.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-[180px_1fr] gap-4">
            <div role="listbox" className="flex flex-col gap-1">
              {workspaces.map(workspace => {
                const isSelected = workspace.id === selectedId;
                return (
                  <button
                    key={workspace.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    data-testid="workspace-manager-item"
                    data-workspace-id={workspace.id}
                    onClick={() => setSelectedId(workspace.id)}
                    className={cn(
                      "truncate rounded-md px-2.5 py-1.5 text-left text-[13px] transition-[color,background-color]",
                      isSelected
                        ? "bg-[var(--color-bg-3)] text-[var(--color-fg)]"
                        : "text-[var(--color-fg-dim)] hover:bg-[var(--color-bg-2)]",
                    )}
                  >
                    {workspace.name}
                  </button>
                );
              })}
            </div>

            {selected ? (
              <div className="flex min-w-0 flex-col gap-3" data-testid="workspace-manager-detail">
                <div className="flex gap-2">
                  <Input
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") rename(); }}
                    data-testid="workspace-rename-input"
                  />
                  <Button variant="ghost" onClick={rename} disabled={!canRename} data-testid="workspace-rename-save">
                    {t("workspaceManager.rename")}
                  </Button>
                  {confirmingDelete ? (
                    <>
                      <Button variant="danger" onClick={remove} data-testid="workspace-delete-confirm">
                        {t("workspaceManager.deleteConfirm")}
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirmingDelete(false)} data-testid="workspace-delete-cancel">
                        {t("cancel", { ns: "common" })}
                      </Button>
                    </>
                  ) : (
                    <Button variant="danger" onClick={() => setConfirmingDelete(true)} data-testid="workspace-delete">
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("workspaceManager.delete")}
                    </Button>
                  )}
                </div>

                <div className="text-[12px] font-medium text-[var(--color-fg-dim)]">
                  {t("workspaceManager.projects")}
                </div>
                <div className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
                  {projects.length === 0 && (
                    <div className="text-[13px] text-[var(--color-fg-dim)]">{t("workspaceManager.noProjects")}</div>
                  )}
                  {projects.map(project => {
                    const included = selected.projectIds.includes(project.id);
                    return (
                      <label
                        key={project.id}
                        data-testid="workspace-project-row"
                        data-workspace-project-id={project.id}
                        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-[var(--color-bg-2)]"
                      >
                        <Checkbox
                          checked={included}
                          onChange={next => toggleProject(project.id, next)}
                          data-testid="workspace-project-toggle"
                        />
                        <span className="truncate">{project.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-[var(--color-fg-dim)]">{t("workspaceManager.pick")}</div>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="workspace-manager-close">
            {t("done", { ns: "common" })}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
