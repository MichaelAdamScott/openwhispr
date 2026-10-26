// Two local accounts on one device, end to end: the real SyncService over the
// real cloudApi/FoldersService/NotesService stack and a real DatabaseManager,
// with one fake cloud per account. Signing in or out follows useAuth: the
// main-process account scope changes, the renderer's validated auth context
// is rebound, and localStorage (including the pull cursors) carries over.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: browserWindow,
  localStorage: browserLocalStorage,
} = require("./harness/browserGlobals.js");
const { createElectronApi } = require("./harness/electronApiBridge.js");
const { createFakeCloud } = require("./harness/fakeCloud.js");

installBrowserGlobals();

const loadSync = () => import("../../src/services/SyncService.ts");
const DEFAULT_NAMES = ["Personal", "Meetings", "Videos"];

function accountCloud(userId, { serverDefaults }) {
  const cloud = createFakeCloud({ userId, adoptDefaultFolders: true });
  if (serverDefaults) {
    DEFAULT_NAMES.forEach((name, index) =>
      cloud.seedFolder({
        client_folder_id: `${userId}-${name.toLowerCase()}`,
        name,
        is_default: true,
        sort_order: index,
        created_at: "2026-01-01T00:00:00.000Z",
      })
    );
  }
  return cloud;
}

async function signIn(t, db, accountId, cloud) {
  db.setActiveAccountId(accountId);
  browserWindow.electronAPI = createElectronApi(db, { cloud });
  enableSync();
  await establishValidatedAuth(accountId);
  return sync(t);
}

function signOut(db) {
  db.setActiveAccountId(null);
  browserLocalStorage.setItem("isSignedIn", "false");
}

async function sync(t) {
  const { SyncService } = await loadSync();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  await service.syncAll(true);
  return service;
}

function visibleDefaults(db) {
  return db
    .getFolders()
    .filter((folder) => folder.is_default)
    .map((folder) => `${folder.name}:${folder.account_id}`)
    .sort();
}

function ownDefaults(accountId) {
  return DEFAULT_NAMES.map((name) => `${name}:${accountId}`).sort();
}

function folderOf(db, accountId, name) {
  return db.db
    .prepare("SELECT * FROM folders WHERE name = ? AND is_default = 1 AND account_id IS ?")
    .get(name, accountId);
}

function notesFor(db) {
  return db
    .getNotes(null, 100)
    .map((note) => note.title)
    .sort();
}

function cloudFolderId(cloud, name) {
  return cloud.folders().find((folder) => folder.name === name && !folder.deleted_at).id;
}

function cloudNote(cloud, title) {
  return cloud.notes().find((note) => note.title === title);
}

// B's account was created after A last synced on this device, so B's cloud rows
// are newer than the pull cursor A left behind and a delta pull delivers them.
function seedLaterAccount(userId) {
  const cloud = createFakeCloud({ userId, adoptDefaultFolders: true });
  DEFAULT_NAMES.forEach((name, index) =>
    cloud.seedFolder({
      client_folder_id: `${userId}-${name.toLowerCase()}`,
      name,
      is_default: true,
      sort_order: index,
    })
  );
  return cloud;
}

for (const serverDefaults of [true, false]) {
  test(`two accounts on one device each get only their own defaults and notes (A's server defaults: ${serverDefaults})`, async (t) => {
    resetBrowserGlobals();
    const db = createDb(t);
    if (!db) return;
    const cloudA = accountCloud("account-a", { serverDefaults });

    db.setActiveAccountId(null);
    db.saveNote("Guest note", "before signing in", "personal");

    await signIn(t, db, "account-a", cloudA);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
    assert.equal(cloudA.folders().length, 3, "A's cloud gets exactly one copy of each default");
    db.saveNote("A note", "a", "personal");
    db.saveNote("A meeting", "a", "meeting");
    await sync(t);
    assert.equal(cloudNote(cloudA, "Guest note").folder_id, cloudFolderId(cloudA, "Personal"));
    assert.equal(cloudNote(cloudA, "A meeting").folder_id, cloudFolderId(cloudA, "Meetings"));

    signOut(db);
    assert.deepEqual(visibleDefaults(db), [], "a signed-out guest sees no account's defaults");
    assert.deepEqual(notesFor(db), []);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const cloudB = seedLaterAccount("account-b");
    await signIn(t, db, "account-b", cloudB);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
    assert.deepEqual(notesFor(db), []);

    const bNote = db.saveNote("B note", "b", "personal").note;
    const bMeeting = db.saveNote("B meeting", "b", "meeting").note;
    assert.equal(bNote.folder_id, folderOf(db, "account-b", "Personal").id);
    assert.equal(bMeeting.folder_id, folderOf(db, "account-b", "Meetings").id);
    assert.equal(db.getMeetingsFolder().id, folderOf(db, "account-b", "Meetings").id);
    await sync(t);
    assert.equal(cloudNote(cloudB, "B note").folder_id, cloudFolderId(cloudB, "Personal"));
    assert.equal(cloudNote(cloudB, "B meeting").folder_id, cloudFolderId(cloudB, "Meetings"));
    assert.equal(cloudB.folders().length, 3, "B pushes none of A's folders");
    assert.deepEqual(
      cloudB
        .notes()
        .map((note) => note.title)
        .sort(),
      ["B meeting", "B note"]
    );

    signOut(db);
    await signIn(t, db, "account-a", cloudA);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
    assert.deepEqual(notesFor(db), ["A meeting", "A note", "Guest note"]);
    assert.deepEqual(
      cloudA
        .notes()
        .map((note) => note.title)
        .sort(),
      ["A meeting", "A note", "Guest note"]
    );

    // Deleting A's account keeps B's rows and leaves B's view untouched.
    db.deleteAccountData("account-a");
    signOut(db);
    await signIn(t, db, "account-b", cloudB);
    assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
    assert.deepEqual(notesFor(db), ["B meeting", "B note"]);
    assert.equal(
      db.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE account_id = 'account-a'").get()
        .count,
      0
    );
  });
}

test("a device synced by a pre-fix build is repaired and both accounts converge", async (t) => {
  resetBrowserGlobals();
  const db = createDb(t);
  if (!db) return;
  const cloudA = accountCloud("account-a", { serverDefaults: true });

  // Reproduce the pre-fix data through real sync: nothing claims bound rows.
  db._claimLegacyPrivateRow = () => {};
  db.setActiveAccountId(null);
  db.saveNote("Guest note", "before signing in", "personal");
  await signIn(t, db, "account-a", cloudA);
  db.saveNote("A note", "a", "personal");
  await sync(t);
  signOut(db);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cloudB = seedLaterAccount("account-b");
  await signIn(t, db, "account-b", cloudB);
  // The pre-fix default-folder lookup took the lowest id: A's seeded Personal.
  db.saveNote("B misrouted", "b", "personal", null, null, folderOf(db, null, "Personal").id);
  await sync(t);

  assert.equal(
    db.getFolders().filter((folder) => folder.is_default && folder.name === "Personal").length,
    2,
    "pre-fix: B sees A's Personal beside its own"
  );
  const misrouted = db.db.prepare("SELECT * FROM notes WHERE title = 'B misrouted'").get();
  assert.equal(
    misrouted.folder_id,
    folderOf(db, null, "Personal").id,
    "pre-fix: B's note lands in A's"
  );

  // Upgrade: the launch repair runs, then each account syncs again.
  delete db._claimLegacyPrivateRow;
  signOut(db);
  db._repairCloudBoundLegacyRows();

  await signIn(t, db, "account-b", cloudB);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-b"));
  assert.deepEqual(notesFor(db), ["B misrouted"]);
  const rehomed = db.db.prepare("SELECT * FROM notes WHERE title = 'B misrouted'").get();
  assert.equal(rehomed.folder_id, folderOf(db, "account-b", "Personal").id);
  assert.equal(rehomed.sync_status, "synced", "the move reaches B's cloud");
  assert.equal(cloudNote(cloudB, "B misrouted").folder_id, cloudFolderId(cloudB, "Personal"));
  assert.equal(db.saveNote("B new", "b", "personal").note.folder_id, rehomed.folder_id);

  signOut(db);
  await signIn(t, db, "account-a", cloudA);
  assert.deepEqual(visibleDefaults(db), ownDefaults("account-a"));
  assert.deepEqual(notesFor(db), ["A note", "Guest note"]);
  assert.deepEqual(
    cloudA
      .notes()
      .map((note) => note.title)
      .sort(),
    ["A note", "Guest note"]
  );
  assert.equal(cloudNote(cloudA, "Guest note").folder_id, cloudFolderId(cloudA, "Personal"));
});
