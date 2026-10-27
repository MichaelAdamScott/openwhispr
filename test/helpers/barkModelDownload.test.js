const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { downloadBarkModel } = require("../../src/helpers/barkModelDownload");
const catalog = require("../../src/models/modelRegistryData.json").parakeetModels;
const { usesPrivateOnnxRuntime } = require("../../src/helpers/parakeetModelInfo");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-bark-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("test speech model file");
  const names = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "LICENSE",
    "NOTICE",
  ];
  const info = {
    downloadFiles: names.map((name) => ({
      name,
      url: "https://model.invalid/" + name,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  return {
    root,
    info,
    download: async (_url, output, options) => {
      fs.writeFileSync(output, bytes);
      options.onProgress(bytes.length);
    },
  };
}

test("Bark catalog offers Standard, Plus and Clean with pinned, checked ONNX files and private inference", () => {
  const models = Object.entries(catalog).filter(([, model]) => model.organization?.id === "bark");
  assert.equal(models.length, 3);
  for (const [id, model] of models) {
    assert.equal(usesPrivateOnnxRuntime(id), true);
    assert.equal(model.downloadFiles.length, 6);
    assert.ok(
      model.downloadFiles.every(
        (file) => /\/resolve\/[a-f0-9]{40}\//.test(file.url) && /^[a-f0-9]{64}$/.test(file.sha256)
      )
    );
  }
  assert.equal(catalog["bark-3-0-clean"].recommended, true);
  assert.equal(catalog["bark-3-0-clean"].leadingSilenceSeconds, 0);
  assert.equal(catalog["bark-3-0"].leadingSilenceSeconds, 0.25);
  assert.equal(catalog["bark-3-0-plus"].leadingSilenceSeconds, 0.25);
});

test("downloads all files, reports cumulative progress and loads the complete installed model before success", async (t) => {
  const f = fixture(t);
  const progress = [];
  const target = await downloadBarkModel({
    modelName: "bark-3-0-clean",
    info: f.info,
    modelsDir: f.root,
    download: f.download,
    onProgress: (...args) => progress.push(args),
    probe: async () => {
      assert.equal(fs.readdirSync(path.join(f.root, "bark-3-0-clean")).length, 6);
      return { success: true };
    },
  });
  assert.equal(target, path.join(f.root, "bark-3-0-clean"));
  assert.equal(progress.at(-1)[0], progress.at(-1)[1]);
  assert.deepEqual(fs.readdirSync(f.root), ["bark-3-0-clean"]);
});

test("checksum failure rolls back the staged download without publishing a model", async (t) => {
  const f = fixture(t);
  f.info.downloadFiles[0].sha256 = "0".repeat(64);
  await assert.rejects(
    downloadBarkModel({
      modelName: "bark-3-0",
      info: f.info,
      modelsDir: f.root,
      download: f.download,
      probe: () => assert.fail("must not load corrupt files"),
    }),
    /checksum/
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("a native engine loading error rolls back the installed model", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    downloadBarkModel({
      modelName: "bark-3-0",
      info: f.info,
      modelsDir: f.root,
      download: f.download,
      probe: async () => ({ success: false, reason: "Unsupported model graph" }),
    }),
    /Unsupported model graph/
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("cancelling between files removes the partial model and never probes", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  await assert.rejects(
    downloadBarkModel({
      modelName: "bark-3-0",
      info: f.info,
      modelsDir: f.root,
      signal: controller.signal,
      download: async (...args) => {
        await f.download(...args);
        controller.abort();
      },
      probe: () => assert.fail("must not probe canceled downloads"),
    }),
    /interrupted/
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("manifest path traversal is rejected before downloading", async (t) => {
  const f = fixture(t);
  f.info.downloadFiles[0].name = "../outside";
  await assert.rejects(
    downloadBarkModel({
      modelName: "bark-3-0",
      info: f.info,
      modelsDir: f.root,
      download: () => assert.fail("must reject manifest"),
    }),
    /manifest/
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
});
