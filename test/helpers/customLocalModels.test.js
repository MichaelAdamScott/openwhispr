const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

function loadHelper(name, overrides = {}) {
  const file = require.resolve(`../../src/helpers/${name}`);
  const module = { exports: {} };
  const realRequire = createRequire(file);
  vm.runInNewContext(
    fs.readFileSync(file, "utf8"),
    {
      module,
      exports: module.exports,
      Buffer,
      process,
      __dirname: path.dirname(file),
      setTimeout,
      clearTimeout,
      require: (id) => (Object.hasOwn(overrides, id) ? overrides[id] : realRequire(id)),
    },
    { filename: file }
  );
  return module.exports;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "custom-asr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = loadHelper("customLocalModels", {
    "./modelDirUtils": { getCacheRoot: () => path.join(root, "cache") },
  });
  return { root, registry };
}

function whisperFile(root, name = "personal.bin") {
  const file = path.join(root, name);
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0x67676d6c, 0);
  [51865, 1500, 384, 6, 4, 448, 384, 6, 4, 80, 1].forEach((n, i) =>
    bytes.writeInt32LE(n, 4 + i * 4)
  );
  fs.writeFileSync(file, bytes);
  return file;
}

function protobufField(field, data) {
  assert.ok(data.length < 128);
  return Buffer.concat([Buffer.from([field * 8 + 2, data.length]), data]);
}

function onnxFile({
  type = "nemo_transducer",
  external = false,
  nestedExternal = false,
  pad_s,
} = {}) {
  const metadata = Buffer.concat(
    Object.entries({ model_type: type, ...(pad_s === undefined ? {} : { pad_s }) }).map(
      ([key, value]) =>
        protobufField(
          14,
          Buffer.concat([protobufField(1, Buffer.from(key)), protobufField(2, Buffer.from(value))])
        )
    )
  );
  let tensor = Buffer.from([8, 1]);
  if (external || nestedExternal)
    tensor = Buffer.concat([tensor, protobufField(13, Buffer.from("outside.bin"))]);
  const graph = nestedExternal
    ? protobufField(1, protobufField(5, protobufField(5, tensor)))
    : protobufField(5, tensor);
  return Buffer.concat([Buffer.from([8, 9]), protobufField(7, graph), metadata]);
}

function onnxFolder(root, options = {}) {
  const dir = path.join(root, "custom speech");
  fs.mkdirSync(dir);
  for (const role of ["encoder", "decoder", "joiner"]) {
    fs.writeFileSync(
      path.join(dir, `${role}${options.aliases ? "" : ".int8"}.onnx`),
      onnxFile(options)
    );
  }
  fs.writeFileSync(path.join(dir, "tokens.txt"), "<blk> 0\n▁hello 1\n");
  return dir;
}

test("Whisper import copies bytes into an opaque cache ID and persists without exposing paths", (t) => {
  const { root, registry } = fixture(t);
  const source = whisperFile(root);
  const model = registry.importModel("whisper", source);
  assert.match(model.id, /^custom-[a-f0-9-]{36}$/);
  assert.equal(model.name, "personal");
  assert.equal(model.provider, "whisper");
  assert.equal(model.modelPath, undefined);
  const imported = registry.getModel(model.id);
  assert.deepEqual(fs.readFileSync(imported.modelPath), fs.readFileSync(source));
  fs.unlinkSync(source);
  assert.equal(registry.listModels()[0].id, model.id);
  assert.equal(registry.resolveModelPath(model.id, "whisper"), imported.modelPath);
  assert.throws(() => registry.resolveModelPath(model.id, "parakeet"), /not found/);
  registry.removeModel(model.id);
  assert.equal(registry.getModel(model.id), null);
  assert.equal(registry.listModels().length, 0);
});

test("Whisper rejects arbitrary .bin and original Bark/MLX/CoreML formats", (t) => {
  const { root, registry } = fixture(t);
  for (const name of ["original.bark", "model.gguf", "model.safetensors", "model.mlmodelc"]) {
    fs.writeFileSync(path.join(root, name), Buffer.alloc(100));
    assert.throws(() => registry.importModel("whisper", path.join(root, name)), /whisper.cpp GGML/);
  }
  fs.writeFileSync(path.join(root, "fake.bin"), Buffer.alloc(100));
  assert.throws(
    () => registry.importModel("whisper", path.join(root, "fake.bin")),
    /not a supported/
  );
  assert.equal(registry.listModels().length, 0);
});

test("ONNX import normalizes supported aliases, preserves license, and stores Bark padding", (t) => {
  const { root, registry } = fixture(t);
  const source = onnxFolder(root, { aliases: true });
  fs.writeFileSync(path.join(source, "LICENSE"), "model license");
  fs.writeFileSync(
    path.join(source, "openwhispr-model.json"),
    JSON.stringify({ leadingSilenceSeconds: 0.25 })
  );
  const model = registry.importModel("parakeet", source);
  assert.equal(model.provider, "nvidia");
  assert.equal(model.leadingSilenceSeconds, 0.25);
  const dir = registry.getModel(model.id).modelPath;
  assert.ok(fs.existsSync(path.join(dir, "encoder.int8.onnx")));
  assert.equal(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), "model license");
  assert.equal(
    registry.importModel("parakeet", source, { leadingSilenceSeconds: 0.5 }).leadingSilenceSeconds,
    0.5
  );
});

test("ONNX rejects missing files, arbitrary model metadata, and external weights including nested tensors", (t) => {
  const { root, registry } = fixture(t);
  const source = onnxFolder(root, { type: "text_to_speech" });
  assert.throws(() => registry.importModel("parakeet", source), /model_type=nemo_transducer/);
  fs.writeFileSync(path.join(source, "encoder.int8.onnx"), onnxFile({ external: true }));
  assert.throws(() => registry.importModel("parakeet", source), /external tensor/);
  fs.writeFileSync(path.join(source, "encoder.int8.onnx"), onnxFile({ nestedExternal: true }));
  assert.throws(() => registry.importModel("parakeet", source), /external tensor/);
  fs.unlinkSync(path.join(source, "joiner.int8.onnx"));
  assert.throws(() => registry.importModel("parakeet", source), /Missing joiner/);
  assert.equal(registry.listModels().length, 0);
});

test("ONNX rejects invalid tokens, unbounded padding, and arbitrary manifest options", (t) => {
  const { root, registry } = fixture(t);
  const source = onnxFolder(root);
  assert.throws(
    () => registry.importModel("parakeet", source, { leadingSilenceSeconds: 10 }),
    /between 0 and 1/
  );
  fs.writeFileSync(path.join(source, "openwhispr-model.json"), '{"command":"evil"}');
  assert.throws(() => registry.importModel("parakeet", source), /supports only/);
  fs.unlinkSync(path.join(source, "openwhispr-model.json"));
  fs.writeFileSync(path.join(source, "tokens.txt"), "arbitrary text");
  assert.throws(() => registry.importModel("parakeet", source), /numeric ID pairs/);
});

test("the actual Bark export's NeMo class metadata selects its declared leading padding", (t) => {
  const { root, registry } = fixture(t);
  const model = registry.importModel(
    "parakeet",
    onnxFolder(root, { type: "EncDecRNNTBPEModel", pad_s: "0.25" })
  );
  assert.equal(model.leadingSilenceSeconds, 0.25);
});

test("IDs and persisted metadata cannot select arbitrary paths or cross engines", (t) => {
  const { root, registry } = fixture(t);
  assert.equal(registry.getModel("../../secrets"), null);
  assert.throws(() => registry.removeModel("../../secrets"), /not found/);
  const model = registry.importModel("whisper", whisperFile(root));
  const meta = path.join(
    path.dirname(registry.getModel(model.id).modelPath),
    "openwhispr-import.json"
  );
  fs.writeFileSync(
    meta,
    JSON.stringify({ id: model.id, engine: "whisper", modelPath: "../../secrets" })
  );
  assert.equal(registry.getModel(model.id), null);
  assert.equal(registry.listModels().length, 0);
});

test("failed import rolls back its private copy and leaves original files intact", (t) => {
  const { root, registry } = fixture(t);
  const source = whisperFile(root);
  fs.writeFileSync(path.join(root, "LICENSE"), Buffer.alloc(1_000_001));
  assert.throws(() => registry.importModel("whisper", source), /LICENSE is too large/);
  assert.ok(fs.existsSync(source));
  assert.equal(fs.readdirSync(path.join(root, "cache", "custom-local-models")).length, 0);
});

test("CLI uses argument arrays, pads every decode, parses real JSON shape, and cleans audio", async (t) => {
  const { root, registry } = fixture(t);
  const model = registry.importModel("parakeet", onnxFolder(root), { leadingSilenceSeconds: 0.25 });
  const calls = [];
  const Cli = loadHelper("customParakeetCli", {
    "./customLocalModels": registry,
    "./safeTempDir": { getSafeTempDir: () => root },
    "../utils/serverUtils": {
      resolveBinaryPath: () => "private-runtime.exe",
      getAvailableParallelism: () => 2,
    },
    child_process: {
      execFile(binary, args, options, callback) {
        const child = new EventEmitter();
        const inputPath = args.at(-1);
        calls.push({ binary, args, options, inputPath, wav: fs.readFileSync(inputPath) });
        setImmediate(() => {
          callback(null, '{"text":"hello","tokens":[],"timestamps":[]}\n', "");
          child.emit("close", 0);
        });
        return child;
      },
    },
  });
  const cli = new Cli();
  await cli.start(model.id);
  const samples = Buffer.alloc(16000 * 4);
  samples.writeFloatLE(0.5, 0);
  assert.equal((await cli.transcribe(model.id, samples)).text, "hello");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.wav.readUInt32LE(40), (16000 + 4000) * 2);
    assert.ok(call.wav.subarray(44, 44 + 8000).every((n) => n === 0));
    assert.ok(call.args.includes("--model-type=nemo_transducer"));
    assert.ok(!call.args.some((arg) => /--port|--host/.test(arg)));
    assert.equal(call.options.shell, undefined);
    assert.equal(fs.existsSync(call.inputPath), false);
  }
  assert.equal(cli.getStatus().port, null);
});

test("CLI stop waits for process close before reporting safe removal", async (t) => {
  const { root, registry } = fixture(t);
  const model = registry.importModel("parakeet", onnxFolder(root));
  let running;
  let callback;
  const spawned = new Promise((resolve) => {
    running = resolve;
  });
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () =>
    setImmediate(() => {
      child.emit("close", 1);
      callback(new Error("killed"), "", "cancelled");
    });
  const Cli = loadHelper("customParakeetCli", {
    "./customLocalModels": registry,
    "./safeTempDir": { getSafeTempDir: () => root },
    "../utils/serverUtils": {
      resolveBinaryPath: () => "private-runtime.exe",
      getAvailableParallelism: () => 2,
    },
    child_process: {
      execFile(_binary, _args, _options, cb) {
        callback = cb;
        running();
        return child;
      },
    },
  });
  const cli = new Cli();
  const decode = cli.transcribe(model.id, Buffer.alloc(16000 * 4));
  const rejected = assert.rejects(decode, /could not run/);
  await spawned;
  await cli.stop();
  await rejected;
  assert.equal(cli.getStatus().running, false);
});

test("CLI cancellation retains the WAV and process tracking until close follows the abort error", async (t) => {
  const { root, registry } = fixture(t);
  const model = registry.importModel("parakeet", onnxFolder(root));
  const controller = new AbortController();
  let spawnResolve;
  const spawned = new Promise((resolve) => {
    spawnResolve = resolve;
  });
  let inputPath;
  const child = new EventEmitter();
  const Cli = loadHelper("customParakeetCli", {
    "./customLocalModels": registry,
    "./safeTempDir": { getSafeTempDir: () => root },
    "../utils/serverUtils": {
      resolveBinaryPath: () => "private-runtime.exe",
      getAvailableParallelism: () => 2,
    },
    child_process: {
      execFile(_binary, args, options, callback) {
        inputPath = args.at(-1);
        options.signal.addEventListener("abort", () => {
          callback(new Error("AbortError"), "", "");
          assert.ok(fs.existsSync(inputPath));
          assert.equal(cli.children.size, 1);
          setImmediate(() => child.emit("close", 1));
        });
        spawnResolve();
        return child;
      },
    },
  });
  const cli = new Cli();
  const decode = cli.transcribe(model.id, Buffer.alloc(16000 * 4), 16000, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(decode, { name: "AbortError" });
  await spawned;
  controller.abort();
  await rejected;
  assert.equal(cli.children.size, 0);
  assert.equal(fs.existsSync(inputPath), false);
});

test("custom Parakeet start and transcription use the private CLI without starting a websocket", async (t) => {
  const { root, registry } = fixture(t);
  const model = registry.importModel("parakeet", onnxFolder(root));
  let wsStops = 0;
  let cliDecodes = 0;
  const samples = Buffer.alloc(16000 * 4);
  const Manager = loadHelper("parakeetServer", {
    "./customLocalModels": registry,
    "./debugLogger": { debug() {}, warn() {}, info() {}, error() {} },
    "./parakeetWsServer": class {
      async start() {
        assert.fail("custom imports must not create a network listener");
      }
      async stop() {
        wsStops++;
      }
    },
    "./customParakeetCli": class {
      async start(id) {
        assert.equal(id, model.id);
      }
      async transcribe(id) {
        assert.equal(id, model.id);
        cliDecodes++;
        return { text: "custom speech", elapsed: 1 };
      }
      getStatus() {
        return { port: null };
      }
    },
    "./ffmpegUtils": {
      isPcm16Mono16kWav: () => true,
      isWavFormat: () => true,
      wavToFloat32Samples: () => samples,
      computeFloat32RMS: () => 1,
    },
  });
  const manager = new Manager();
  assert.equal((await manager.startServer(model.id)).success, true);
  const result = await manager.transcribe(Buffer.from("wav"), { modelName: model.id });
  assert.equal(result.text, "custom speech");
  assert.equal(cliDecodes, 1);
  assert.equal(wsStops, 2);
  assert.equal(manager.getServerStatus().port, null);
});

test("Whisper manager resolves imported bytes through start, status, list, and removal", async (t) => {
  const { root, registry } = fixture(t);
  const source = whisperFile(root);
  const model = registry.importModel("whisper", source);
  let loadedPath;
  let stopped = false;
  const Manager = loadHelper("whisper", {
    "./customLocalModels": registry,
    "./debugLogger": { info() {}, error() {} },
    "./whisperServer": class {
      isAvailable() {
        return true;
      }
      async start(file) {
        loadedPath = file;
      }
      async stop() {
        stopped = true;
      }
    },
  });
  const manager = new Manager();
  manager.getModelsDir = () => path.join(root, "stock");
  assert.equal((await manager.startServer(model.id)).success, true);
  assert.equal(loadedPath, registry.getModel(model.id).modelPath);
  assert.equal((await manager.checkModelStatus(model.id)).downloaded, true);
  assert.ok((await manager.listWhisperModels()).models.some((entry) => entry.model === model.id));
  await assert.rejects(manager.downloadWhisperModel(model.id), /cannot be downloaded/);
  assert.equal((await manager.deleteWhisperModel(model.id)).deleted, true);
  assert.equal(stopped, true);
  assert.equal(registry.getModel(model.id), null);
  assert.ok(fs.existsSync(source));
});

test("Parakeet manager can transcribe imported speech with no websocket runtime installed", async (t) => {
  const { root, registry } = fixture(t);
  const model = registry.importModel("parakeet", onnxFolder(root));
  const Manager = loadHelper("parakeet", {
    "./customLocalModels": registry,
    "./debugLogger": { logSTTPipeline() {}, debug() {} },
    "./parakeetCapability": { assertParakeetSupported() {} },
    "./parakeetServer": class {
      constructor() {
        this.customCli = { isAvailable: () => true };
      }
      isAvailable() {
        return false;
      }
      isModelDownloaded(id) {
        return !!registry.getModel(id);
      }
      async transcribe(_audio, options) {
        assert.equal(options.modelName, model.id);
        return { text: "private speech" };
      }
    },
  });
  const manager = new Manager();
  assert.equal(
    (await manager.transcribeLocalParakeet(Buffer.from("audio"), { model: model.id })).text,
    "private speech"
  );
  await assert.rejects(manager.downloadParakeetModel(model.id), /cannot be downloaded/);
});
