const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/workspaceActionsCore.ts");

function makeHarness({ activeId = "ws-1", failures = {} } = {}) {
  const calls = [];
  let active = activeId;
  const step = (name, ...args) => {
    calls.push([name, ...args]);
    if (failures[name]) throw failures[name];
  };
  const deps = {
    api: {
      removeMember: async (workspaceId, userId) => step("removeMember", workspaceId, userId),
      remove: async (workspaceId) => step("remove", workspaceId),
      updateMemberRole: async (workspaceId, userId, role) =>
        step("updateMemberRole", workspaceId, userId, role),
    },
    store: {
      getActiveWorkspaceId: () => active,
      setActiveWorkspaceId: (id) => {
        calls.push(["setActive", id]);
        active = id;
      },
      refresh: async () => step("refresh"),
      refreshMembers: async (workspaceId) => step("refreshMembers", workspaceId),
    },
    sync: { requestSyncAll: (reason) => calls.push(["requestSyncAll", reason]) },
  };
  return { calls, deps, getActive: () => active };
}

test("leave calls the API before touching the store", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness();
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.deepEqual(calls, [
    ["removeMember", "ws-1", "user-1"],
    ["setActive", null],
    ["refresh"],
    ["requestSyncAll", "manual"],
  ]);
});

test("leave keeps the active id when another workspace is active", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps, getActive } = makeHarness({ activeId: "ws-2" });
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.equal(
    calls.some(([name]) => name === "setActive"),
    false
  );
  assert.equal(getActive(), "ws-2");
});

test("leave succeeds even when the workspace refresh fails", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({ failures: { refresh: new Error("offline") } });
  await createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1");
  assert.deepEqual(calls.at(-1), ["requestSyncAll", "manual"]);
  assert.ok(calls.some(([name]) => name === "refresh"));
});

test("a failed leave changes nothing locally", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("server said no");
  const { calls, deps, getActive } = makeHarness({ failures: { removeMember: failure } });
  await assert.rejects(createWorkspaceActions(deps).leaveWorkspace("ws-1", "user-1"), failure);
  assert.deepEqual(calls, [["removeMember", "ws-1", "user-1"]]);
  assert.equal(getActive(), "ws-1");
});

test("delete follows the same order", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness();
  await createWorkspaceActions(deps).deleteWorkspace("ws-1");
  assert.deepEqual(calls, [
    ["remove", "ws-1"],
    ["setActive", null],
    ["refresh"],
    ["requestSyncAll", "manual"],
  ]);
});

test("a failed delete changes nothing locally", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("server said no");
  const { calls, deps } = makeHarness({ failures: { remove: failure } });
  await assert.rejects(createWorkspaceActions(deps).deleteWorkspace("ws-1"), failure);
  assert.deepEqual(calls, [["remove", "ws-1"]]);
});

test("delete succeeds even when the workspace refresh fails", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({ failures: { refresh: new Error("offline") } });
  await createWorkspaceActions(deps).deleteWorkspace("ws-1");
  assert.deepEqual(calls.at(-1), ["requestSyncAll", "manual"]);
});

test("transfer refreshes workspaces and members, and requests no sync", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness();
  await createWorkspaceActions(deps).transferOwnership("ws-1", "user-2");
  assert.deepEqual(calls, [
    ["updateMemberRole", "ws-1", "user-2", "owner"],
    ["refresh"],
    ["refreshMembers", "ws-1"],
  ]);
});

test("transfer succeeds even when the refreshes fail", async () => {
  const { createWorkspaceActions } = await load();
  const { calls, deps } = makeHarness({
    failures: { refresh: new Error("offline"), refreshMembers: new Error("offline") },
  });
  await createWorkspaceActions(deps).transferOwnership("ws-1", "user-2");
  assert.deepEqual(
    calls.map(([name]) => name),
    ["updateMemberRole", "refresh", "refreshMembers"]
  );
});

test("a failed transfer changes nothing locally", async () => {
  const { createWorkspaceActions } = await load();
  const failure = new Error("server said no");
  const { calls, deps } = makeHarness({ failures: { updateMemberRole: failure } });
  await assert.rejects(createWorkspaceActions(deps).transferOwnership("ws-1", "user-2"), failure);
  assert.deepEqual(calls, [["updateMemberRole", "ws-1", "user-2", "owner"]]);
});
