import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, LogOut, Loader2 } from "../icons";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useAuth } from "../../hooks/useAuth";
import { useDialogs } from "../../hooks/useDialogs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import { ConfirmDialog } from "../ui/dialog";
import { workspaceCan } from "../../lib/capabilities";
import EnterpriseConsoleRow from "./EnterpriseConsoleRow";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { useSettingsWorkspace } from "./useSettingsWorkspace";
import type { Workspace } from "../../types/electron";

export default function WorkspaceGeneralSection(): React.ReactElement | null {
  const state = useSettingsWorkspace();
  return (
    <SettingsWorkspaceFrame state={state}>
      {(workspace) => (
        <>
          <h2 dir="auto" className="text-sm font-semibold text-foreground truncate">
            {workspace.name}
          </h2>
          <GeneralTab workspace={workspace} />
        </>
      )}
    </SettingsWorkspaceFrame>
  );
}

function GeneralTab({ workspace }: { workspace: Workspace }): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);
  const [name, setName] = useState(workspace.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const canDelete = workspaceCan(workspace, "delete_workspace");
  const canLeave = workspaceCan(workspace, "leave");
  const canEdit = workspaceCan(workspace, "manage_settings");
  const dirty = name !== workspace.name;

  useEffect(() => {
    setName(workspace.name);
  }, [workspace.id, workspace.name]);

  async function handleSave() {
    setSaving(true);
    try {
      await WorkspacesService.update(workspace.id, { name });
      await refresh();
      toast({ title: t("settingsPage.workspace.general.saved") });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    showConfirmDialog({
      title: t("settingsPage.workspace.general.confirmTitle", { name: workspace.name }),
      description: t("settingsPage.workspace.general.confirmDescription"),
      confirmText: t("settingsPage.workspace.general.delete"),
      variant: "destructive",
      onConfirm: async () => {
        setDeleting(true);
        try {
          await WorkspacesService.remove(workspace.id);
          setActive(null);
          await refresh();
          toast({ title: t("settingsPage.workspace.general.deleted") });
        } catch (error) {
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setDeleting(false);
        }
      },
    });
  }

  function confirmLeave() {
    showConfirmDialog({
      title: t("settingsPage.workspace.general.leaveConfirm.title", { name: workspace.name }),
      description: t("settingsPage.workspace.general.leaveConfirm.description"),
      confirmText: t("settingsPage.workspace.general.leave"),
      variant: "destructive",
      onConfirm: async () => {
        if (!user?.id) return;
        setLeaving(true);
        try {
          await WorkspacesService.removeMember(workspace.id, user.id);
          setActive(null);
          await refresh();
          toast({ title: t("settingsPage.workspace.general.left", { name: workspace.name }) });
        } catch (error) {
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setLeaving(false);
        }
      },
    });
  }

  return (
    <div className="space-y-4">
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.workspace.general.nameLabel")}>
            <div className="flex gap-2">
              <Input
                dir="auto"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label={t("settingsPage.workspace.general.nameLabel")}
                disabled={!canEdit || saving}
                maxLength={80}
                className="h-8 w-56 text-xs"
              />
              {canEdit && (
                <Button size="sm" onClick={handleSave} disabled={!dirty || !name.trim() || saving}>
                  {saving ? t("common.saving") : t("common.save")}
                </Button>
              )}
            </div>
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      <EnterpriseConsoleRow workspace={workspace} />

      {canDelete ? (
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.workspace.general.dangerTitle")}
              description={t("settingsPage.workspace.general.dangerDescription")}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={confirmDelete}
                disabled={deleting}
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
              >
                {deleting ? (
                  <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="me-1.5 h-3.5 w-3.5" />
                )}
                {deleting
                  ? t("settingsPage.workspace.general.deleting")
                  : t("settingsPage.workspace.general.delete")}
              </Button>
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      ) : canLeave ? (
        <SettingsPanel>
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.workspace.general.leaveTitle")}
              description={t("settingsPage.workspace.general.leaveDescription")}
            >
              <Button
                variant="outline"
                size="sm"
                onClick={confirmLeave}
                disabled={leaving}
                className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
              >
                {leaving ? (
                  <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="me-1.5 h-3.5 w-3.5" />
                )}
                {leaving
                  ? t("settingsPage.workspace.general.leaving")
                  : t("settingsPage.workspace.general.leave")}
              </Button>
            </SettingsRow>
          </SettingsPanelRow>
        </SettingsPanel>
      ) : null}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
