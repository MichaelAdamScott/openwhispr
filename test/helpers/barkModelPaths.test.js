const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { isBarkModel, getBarkModelPath } = require("../../src/helpers/barkModelPaths");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-bark-paths-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    barkDir: path.join(root, "bark-models"),
    legacyDir: path.join(root, "parakeet-models"),
  };
}

function writeModel(directory, id, bytes) {
  const target = path.join(directory, id);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "encoder.int8.onnx"), bytes);
  return target;
}

test("all catalog Bark models migrate intact and retain their IDs, leaving Parakeet alone", (t) => {
  const dirs = fixture(t);
  const parakeet = writeModel(dirs.legacyDir, "parakeet-tdt-0.6b-v3", "parakeet");
  for (const id of ["bark-3-0", "bark-3-0-plus", "bark-3-0-clean"]) {
    const source = writeModel(dirs.legacyDir, id, id);
    const target = getBarkModelPath(id, dirs);
    assert.equal(target, path.join(dirs.barkDir, id));
    assert.equal(fs.readFileSync(path.join(target, "encoder.int8.onnx"), "utf8"), id);
    assert.equal(fs.existsSync(source), false);
    assert.equal(getBarkModelPath(id, dirs), target);
  }
  assert.equal(fs.readFileSync(path.join(parakeet, "encoder.int8.onnx"), "utf8"), "parakeet");
});

test("new Bark downloads resolve to their own cache without needing a legacy model", (t) => {
  const dirs = fixture(t);
  assert.equal(getBarkModelPath("bark-3-0-clean", dirs), path.join(dirs.barkDir, "bark-3-0-clean"));
});

test("an existing destination is never overwritten and the legacy copy is retained", (t) => {
  const dirs = fixture(t);
  const source = writeModel(dirs.legacyDir, "bark-3-0-clean", "old");
  const target = writeModel(dirs.barkDir, "bark-3-0-clean", "new");
  assert.equal(getBarkModelPath("bark-3-0-clean", dirs), target);
  assert.equal(fs.readFileSync(path.join(source, "encoder.int8.onnx"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(target, "encoder.int8.onnx"), "utf8"), "new");
});

test("unknown IDs and traversal cannot move arbitrary cache directories", (t) => {
  const dirs = fixture(t);
  for (const id of ["../bark-3-0", "bark-3-0/../other", "parakeet-tdt-0.6b-v3", "bark-unknown"]) {
    assert.equal(isBarkModel(id), false);
    assert.throws(() => getBarkModelPath(id, dirs), /Unknown Bark/);
  }
});

test("failed Windows moves leave the original model available for retry", (t) => {
  const dirs = fixture(t);
  const source = writeModel(dirs.legacyDir, "bark-3-0-clean", "keep");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", () => {
    throw new Error("EPERM: file is busy");
  });
  assert.throws(() => getBarkModelPath("bark-3-0-clean", dirs), /Close other copies/);
  assert.equal(fs.readFileSync(path.join(source, "encoder.int8.onnx"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(dirs.barkDir, "bark-3-0-clean")), false);
  fs.renameSync = rename;
  assert.equal(getBarkModelPath("bark-3-0-clean", dirs), path.join(dirs.barkDir, "bark-3-0-clean"));
});

test("a legacy cache file cannot be mistaken for a model directory", (t) => {
  const dirs = fixture(t);
  fs.mkdirSync(dirs.legacyDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.legacyDir, "bark-3-0-clean"), "keep");
  assert.throws(() => getBarkModelPath("bark-3-0-clean", dirs), /regular model directory/);
});

test("the shared manager downloads into Bark storage and clears both model families", async (t) => {
  const dirs = fixture(t);
  const file = require.resolve("../../src/helpers/parakeet");
  const realRequire = createRequire(file);
  const module = { exports: {} };
  let stopped = 0;
  const overrides = {
    "./modelDirUtils": {
      getModelsDirForService: (service) => (service === "bark" ? dirs.barkDir : dirs.legacyDir),
    },
    "./customLocalModels": { isCustomModelId: () => false, listModels: () => [] },
    "./parakeetCapability": { assertParakeetSupported() {} },
    "./parakeetServer": class {
      isModelDownloaded() {
        return false;
      }
      async stop() {
        stopped++;
      }
    },
    "./downloadUtils": {
      createDownloadSignal: () => ({ signal: new AbortController().signal, abort() {} }),
      checkDiskSpace: async () => ({ ok: true }),
    },
    "./barkModelDownload": {
      downloadBarkModel: async ({ modelsDir, modelName }) => {
        assert.equal(modelsDir, dirs.barkDir);
        writeModel(modelsDir, modelName, "new bark");
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(file, "utf8"),
    {
      module,
      process,
      Buffer,
      __dirname: path.dirname(file),
      require: (id) => (Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id)),
    },
    { filename: file }
  );
  const manager = new module.exports();
  manager.stopServer = async () => {
    stopped++;
  };
  const installed = await manager.downloadParakeetModel("bark-3-0-clean");
  assert.equal(installed.success, true);
  assert.equal(manager.getModelPath("bark-3-0-clean"), path.join(dirs.barkDir, "bark-3-0-clean"));
  const parakeet = writeModel(dirs.legacyDir, "parakeet-tdt-0.6b-v3", "stock");
  const removed = await manager.deleteAllParakeetModels();
  assert.equal(removed.success, true);
  assert.equal(removed.deleted_count, 2);
  assert.equal(removed.freed_bytes, Buffer.byteLength("new barkstock"));
  assert.equal(fs.existsSync(manager.getModelPath("bark-3-0-clean")), false);
  assert.equal(fs.existsSync(parakeet), false);
  assert.equal(stopped, 1);
});
