const test = require("node:test");
const assert = require("node:assert/strict");
const { registerCustomLocalSpeechIpc } = require("../../src/helpers/customLocalSpeechIpc");

function harness(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const model = {
    id: "custom-test",
    name: "My speech model",
    engine: "whisper",
    provider: "whisper",
    sizeBytes: 123,
  };
  const registry = {
    listModels: () => [model],
    getModel: (id) => (id === model.id ? model : null),
    importModel: async (...args) => {
      calls.push(["copy", ...args]);
      return model;
    },
    removeModel: async (id) => calls.push(["remove", id]),
    ...overrides.registry,
  };
  const manager = {
    resolveGpuStartOptions: () => ({ useCuda: false }),
    startServer: async (...args) => {
      calls.push(["load", ...args]);
      return { success: true };
    },
    stopServer: async () => calls.push(["stop"]),
    ...overrides.manager,
  };
  registerCustomLocalSpeechIpc({
    ipcMain: { handle: (key, handler) => handlers.set(key, handler) },
    dialog: {
      showOpenDialog: async (...args) => {
        calls.push(["dialog", ...args]);
        return { canceled: false, filePaths: ["C:\\models with spaces\\speech.bin"] };
      },
      ...overrides.dialog,
    },
    BrowserWindow: { fromWebContents: () => null },
    whisperManager: manager,
    parakeetManager: manager,
    registry,
  });
  return { calls, model, invoke: (key, ...args) => handlers.get(key)({ sender: {} }, ...args) };
}

test("import uses the native selection and loads the copied model before publishing it", async () => {
  const h = harness();
  assert.deepEqual(await h.invoke("import-custom-local-speech-model", "whisper"), {
    success: true,
    model: h.model,
  });
  assert.deepEqual(
    h.calls.map((c) => c[0]),
    ["dialog", "copy", "stop", "load"]
  );
  assert.deepEqual(h.calls[0][1].properties, ["openFile"]);
  assert.deepEqual(h.calls[1], ["copy", "whisper", "C:\\models with spaces\\speech.bin", {}]);
  assert.deepEqual(h.calls[3], ["load", h.model.id, { useCuda: false }]);
});

test("an ONNX import selects a folder and probes its own local engine", async () => {
  const h = harness();
  const result = await h.invoke("import-custom-local-speech-model", "parakeet");
  assert.equal(result.success, true);
  assert.deepEqual(h.calls[0][1].properties, ["openDirectory"]);
  assert.deepEqual(h.calls[3], ["load", h.model.id, undefined]);
});

test("canceling the native dialog makes no registry or engine changes", async () => {
  const h = harness({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  });
  assert.deepEqual(await h.invoke("import-custom-local-speech-model", "whisper"), {
    success: false,
    canceled: true,
  });
  assert.deepEqual(h.calls, []);
});

test("unsupported engines never open the dialog", async () => {
  const h = harness();
  assert.equal(
    (await h.invoke("import-custom-local-speech-model", "../../arbitrary")).success,
    false
  );
  assert.deepEqual(h.calls, []);
});

test("Bark audio padding is forwarded while paths and invalid options are rejected", async () => {
  const h = harness();
  assert.equal(
    (
      await h.invoke("import-custom-local-speech-model", "parakeet", {
        leadingSilenceSeconds: 0.25,
      })
    ).success,
    true
  );
  assert.deepEqual(h.calls[1].at(-1), { leadingSilenceSeconds: 0.25 });
  for (const options of [
    null,
    [],
    { sourcePath: "C:\\private" },
    { leadingSilenceSeconds: -1 },
    { leadingSilenceSeconds: Infinity },
  ]) {
    assert.equal(
      (await h.invoke("import-custom-local-speech-model", "parakeet", options)).success,
      false
    );
  }
  assert.equal(
    (await h.invoke("import-custom-local-speech-model", "whisper", { leadingSilenceSeconds: 0.25 }))
      .success,
    false
  );
  assert.equal(h.calls.length, 4);
});

test("a native loading failure stops the engine and rolls back the managed copy", async () => {
  const h = harness({
    manager: { startServer: async () => ({ success: false, reason: "Unsupported ONNX operator" }) },
  });
  const result = await h.invoke("import-custom-local-speech-model", "parakeet");
  assert.equal(result.success, false);
  assert.match(result.error, /Unsupported ONNX operator/);
  assert.deepEqual(h.calls.slice(-2), [["stop"], ["remove", h.model.id]]);
});

test("removal releases Windows model handles before deleting the copy", async () => {
  const h = harness();
  assert.deepEqual(await h.invoke("remove-custom-local-speech-model", h.model.id), {
    success: true,
  });
  assert.deepEqual(h.calls, [["stop"], ["remove", h.model.id]]);
  assert.equal(
    (await h.invoke("remove-custom-local-speech-model", "../other-file")).success,
    false
  );
});

test("overlapping imports are refused until the first dialog settles", async () => {
  let finish;
  const h = harness({
    dialog: {
      showOpenDialog: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });
  const first = h.invoke("import-custom-local-speech-model", "whisper");
  assert.match(
    (await h.invoke("import-custom-local-speech-model", "whisper")).error,
    /in progress/
  );
  assert.match(
    (await h.invoke("remove-custom-local-speech-model", h.model.id)).error,
    /in progress/
  );
  finish({ canceled: true });
  await first;
  assert.deepEqual(await h.invoke("list-custom-local-speech-models"), {
    success: true,
    models: [h.model],
  });
  assert.equal((await h.invoke("remove-custom-local-speech-model", h.model.id)).success, true);
});
