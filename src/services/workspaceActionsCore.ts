import logger from "../utils/logger";

export interface WorkspaceActionsDependencies {
  api: {
    removeMember(workspaceId: string, userId: string): Promise<void>;
    remove(workspaceId: string): Promise<void>;
    updateMemberRole(workspaceId: string, userId: string, role: "owner"): Promise<unknown>;
  };
  store: {
    getActiveWorkspaceId(): string | null;
    setActiveWorkspaceId(id: string | null): void;
    forgetWorkspace(id: string): void;
    refresh(): Promise<void>;
    refreshMembers(workspaceId: string): Promise<void>;
  };
  sync: { requestSyncAll(reason: string): void };
}

export interface WorkspaceActions {
  leaveWorkspace(workspaceId: string, userId: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  transferOwnership(workspaceId: string, newOwnerId: string): Promise<void>;
}

export function createWorkspaceActions(deps: WorkspaceActionsDependencies): WorkspaceActions {
  // The server change has already happened by the time a refresh runs, so a
  // refresh failure must not turn a successful action into a reported failure.
  async function refreshQuietly(label: string, refresh: () => Promise<void>): Promise<void> {
    try {
      await refresh();
    } catch (err) {
      logger.warn(
        `Workspace ${label} refresh failed after a successful change`,
        { error: err instanceof Error ? err.message : String(err) },
        "workspaces"
      );
    }
  }

  // After the caller loses a workspace, `syncSpaces` purges the team spaces
  // that `/me/spaces` no longer lists, so the sync request cleans up the local mirror.
  // The store's refresh keeps its old list when it fails, so the lost workspace is
  // dropped first; otherwise it could still be picked as the current one.
  async function afterLosingWorkspace(workspaceId: string): Promise<void> {
    if (deps.store.getActiveWorkspaceId() === workspaceId) {
      deps.store.setActiveWorkspaceId(null);
    }
    deps.store.forgetWorkspace(workspaceId);
    await refreshQuietly("list", () => deps.store.refresh());
    deps.sync.requestSyncAll("manual");
  }

  async function leaveWorkspace(workspaceId: string, userId: string): Promise<void> {
    await deps.api.removeMember(workspaceId, userId);
    await afterLosingWorkspace(workspaceId);
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    await deps.api.remove(workspaceId);
    await afterLosingWorkspace(workspaceId);
  }

  // The server demotes the previous owner in the same transaction, so the
  // caller's capabilities and the member roles both need a fresh read.
  async function transferOwnership(workspaceId: string, newOwnerId: string): Promise<void> {
    await deps.api.updateMemberRole(workspaceId, newOwnerId, "owner");
    await refreshQuietly("list", () => deps.store.refresh());
    await refreshQuietly("members", () => deps.store.refreshMembers(workspaceId));
  }

  return { leaveWorkspace, deleteWorkspace, transferOwnership };
}
