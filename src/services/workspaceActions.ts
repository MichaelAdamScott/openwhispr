import { WorkspacesService } from "./WorkspacesService";
import { syncService } from "./SyncService";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { createWorkspaceActions } from "./workspaceActionsCore";

// Single path for leaving, deleting and transferring a workspace: server call
// → workspace store refresh → sync request. The orchestration lives in an
// injectable core so ordering and failure behavior stay testable.
const actions = createWorkspaceActions({
  api: WorkspacesService,
  store: {
    getActiveWorkspaceId: () => useWorkspaceStore.getState().activeWorkspaceId,
    setActiveWorkspaceId: (id) => useWorkspaceStore.getState().setActiveWorkspaceId(id),
    forgetWorkspace: (id) => useWorkspaceStore.getState().forgetWorkspace(id),
    refresh: () => useWorkspaceStore.getState().refresh(),
    refreshMembers: (workspaceId) => useWorkspaceStore.getState().refreshMembers(workspaceId),
  },
  sync: syncService,
});

export const { leaveWorkspace, deleteWorkspace, transferOwnership } = actions;
