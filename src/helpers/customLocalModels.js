const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { getCacheRoot } = require("./modelDirUtils");

const CUSTOM_ID = /^custom-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL_FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"];
const METADATA_FILE = "openwhispr-import.json";
// NeMo exports may record the Python model class rather than sherpa's decoder
// hint. Both RNNT and TDT variants use the offline nemo_transducer runtime.
const NEMO_MODEL_TYPES = new Set(["nemo_transducer", "EncDecRNNTBPEModel", "EncDecTDTBPEModel"]);

function isCustomModelId(id) {
  return typeof id === "string" && CUSTOM_ID.test(id);
}

function getRoot() {
  const root = path.join(getCacheRoot(), "custom-local-models");
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink())
    throw new Error("Imported model cache must not be a symbolic link");
  return root;
}

function regularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`Expected a non-empty regular file: ${path.basename(filePath)}`);
  }
  return stat;
}

function modelDirectory(id) {
  if (!isCustomModelId(id)) throw new Error("Invalid imported model ID");
  const root = path.resolve(getRoot());
  const dir = path.resolve(root, id);
  if (path.dirname(dir) !== root) throw new Error("Invalid imported model directory");
  return dir;
}

function descriptor(metadata) {
  const { id, name, engine, provider, sizeBytes, leadingSilenceSeconds } = metadata;
  return {
    id,
    name,
    engine,
    provider,
    sizeBytes,
    ...(leadingSilenceSeconds ? { leadingSilenceSeconds } : {}),
  };
}

function getModel(id) {
  if (!isCustomModelId(id)) return null;
  try {
    const dir = modelDirectory(id);
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) return null;
    const metaPath = path.join(dir, METADATA_FILE);
    if (regularFile(metaPath).size > 16_384) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (
      meta.schemaVersion !== 1 ||
      meta.id !== id ||
      !["whisper", "parakeet"].includes(meta.engine) ||
      meta.provider !== (meta.engine === "whisper" ? "whisper" : "nvidia") ||
      typeof meta.name !== "string" ||
      !meta.name.trim() ||
      meta.name.length > 100 ||
      !Number.isSafeInteger(meta.sizeBytes) ||
      meta.sizeBytes <= 0 ||
      !Number.isFinite(meta.leadingSilenceSeconds) ||
      meta.leadingSilenceSeconds < 0 ||
      meta.leadingSilenceSeconds > 1
    )
      return null;
    const files = meta.engine === "whisper" ? ["model.bin"] : MODEL_FILES;
    for (const file of files) regularFile(path.join(dir, file));
    return {
      ...descriptor(meta),
      modelPath: meta.engine === "whisper" ? path.join(dir, "model.bin") : dir,
    };
  } catch {
    return null;
  }
}

function resolveModelPath(id, engine) {
  const model = getModel(id);
  if (!model || model.engine !== engine)
    throw new Error("Imported model not found. Import it again in Settings.");
  return model.modelPath;
}

function listModels() {
  try {
    return fs.readdirSync(getRoot()).map(getModel).filter(Boolean).map(descriptor);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Skip tensor payloads instead of loading a multi-GB ONNX graph into memory.
// This reads protobuf structure only; the actual native runtime validates graphs.
function inspectOnnx(filePath) {
  const size = regularFile(filePath).size;
  const fd = fs.openSync(filePath, "r");
  let cache = Buffer.alloc(0);
  let cacheStart = -1;
  let fields = 0;
  const metadata = {};
  function bytes(offset, length) {
    if (length < 0 || offset < 0 || offset + length > size)
      throw new Error("Truncated ONNX protobuf");
    if (offset < cacheStart || offset + length > cacheStart + cache.length) {
      cacheStart = offset;
      cache = Buffer.alloc(Math.min(Math.max(65_536, length), size - offset));
      const count = fs.readSync(fd, cache, 0, cache.length, offset);
      if (count !== cache.length) throw new Error("Truncated ONNX file");
    }
    return cache.subarray(offset - cacheStart, offset - cacheStart + length);
  }
  function varint(cursor, end, bounded = true) {
    let value = 0;
    let multiplier = 1;
    for (let n = 0; n < 10 && cursor.offset < end; n++) {
      const byte = bytes(cursor.offset++, 1)[0];
      value += (byte & 127) * multiplier;
      if (!(byte & 128)) {
        if (bounded && !Number.isSafeInteger(value)) throw new Error("Invalid ONNX integer");
        return value;
      }
      multiplier *= 128;
    }
    throw new Error("Invalid ONNX protobuf");
  }
  function scan(start, end, type, depth = 0) {
    if (depth > 32) throw new Error("ONNX graph nesting is too deep");
    const cursor = { offset: start };
    let entryKey;
    let entryValue;
    while (cursor.offset < end) {
      if (++fields > 2_000_000) throw new Error("ONNX graph is too complex");
      const tag = varint(cursor, end);
      const field = Math.floor(tag / 8);
      const wire = tag & 7;
      if (!field) throw new Error("Invalid ONNX field");
      if (type === "tensor" && field === 13) {
        throw new Error(
          "ONNX models with external tensor data are not supported. Re-export with all weights embedded in each .onnx file."
        );
      }
      if (wire === 0) {
        const value = varint(cursor, end, false);
        if (type === "tensor" && field === 14 && value !== 0)
          throw new Error(
            "ONNX external tensor data is not supported. Re-export with embedded weights."
          );
        continue;
      }
      if (wire === 1 || wire === 5) {
        cursor.offset += wire === 1 ? 8 : 4;
      } else if (wire === 2) {
        const length = varint(cursor, end);
        const from = cursor.offset;
        const to = from + length;
        if (to > end) throw new Error("Truncated ONNX field");
        const childType =
          type === "model" && field === 7
            ? "graph"
            : type === "model" && field === 14
              ? "entry"
              : type === "graph" && field === 1
                ? "node"
                : type === "graph" && field === 5
                  ? "tensor"
                  : type === "graph" && field === 15
                    ? "sparse"
                    : type === "node" && field === 5
                      ? "attribute"
                      : type === "attribute" && [5, 10].includes(field)
                        ? "tensor"
                        : type === "attribute" && [6, 11].includes(field)
                          ? "graph"
                          : type === "attribute" && [22, 23].includes(field)
                            ? "sparse"
                            : type === "sparse" && [1, 2].includes(field)
                              ? "tensor"
                              : null;
        if (type === "model" && field === 25)
          throw new Error(
            "ONNX local functions are not supported by this importer. Export a standard sherpa NeMo transducer graph."
          );
        if (type === "entry" && [1, 2].includes(field)) {
          if (length > 16_384) throw new Error("ONNX metadata entry is too large");
          const value = bytes(from, length).toString("utf8");
          if (field === 1) entryKey = value;
          else entryValue = value;
        }
        if (childType) scan(from, to, childType, depth + 1);
        cursor.offset = to;
      } else {
        throw new Error("Unsupported ONNX protobuf encoding");
      }
      if (cursor.offset > end) throw new Error("Truncated ONNX field");
    }
    if (type === "entry" && entryKey) metadata[entryKey] = entryValue;
  }
  try {
    scan(0, size, "model");
    return metadata;
  } finally {
    fs.closeSync(fd);
  }
}

function validateWhisper(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".bin") {
    throw new Error(
      "Choose a whisper.cpp GGML .bin speech recognition model. GGUF, PyTorch, Bark .bark, MLX, and CoreML files need conversion and cannot be loaded directly."
    );
  }
  if (regularFile(filePath).size < 48)
    throw new Error("This file is too small to be a whisper.cpp model");
  const fd = fs.openSync(filePath, "r");
  const header = Buffer.alloc(48);
  try {
    fs.readSync(fd, header, 0, header.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const h = Array.from({ length: 11 }, (_, i) => header.readInt32LE(4 + i * 4));
  if (
    header.readUInt32LE(0) !== 0x67676d6c ||
    h.slice(0, 9).some((value) => value <= 0 || value > 1_000_000) ||
    ![80, 128].includes(h[9]) ||
    h[10] < 0
  )
    throw new Error(
      "This is not a supported whisper.cpp GGML speech recognition model. Select an exported Whisper .bin file."
    );
}

function validateTokens(filePath) {
  if (regularFile(filePath).size > 16_000_000) throw new Error("tokens.txt is too large");
  const ids = new Set();
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(.+)\s(\d+)$/u);
    if (!match || line.includes("\0"))
      throw new Error("tokens.txt must contain sherpa token and numeric ID pairs");
    const id = Number(match[2]);
    if (id > 1_000_000 || ids.has(id))
      throw new Error("tokens.txt contains invalid or duplicate token IDs");
    ids.add(id);
  }
  if (!ids.has(0) || ids.size < 2)
    throw new Error("tokens.txt is missing the blank token or vocabulary");
}

function importModel(engine, sourcePath, options = {}) {
  if (!["whisper", "parakeet"].includes(engine)) throw new Error("Unsupported local model engine");
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "leadingSilenceSeconds")
  )
    throw new Error("Invalid local model import options");
  if (
    options.leadingSilenceSeconds !== undefined &&
    (engine !== "parakeet" ||
      !Number.isFinite(options.leadingSilenceSeconds) ||
      options.leadingSilenceSeconds < 0 ||
      options.leadingSilenceSeconds > 1)
  )
    throw new Error("Leading silence must be between 0 and 1 seconds for ONNX imports");
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath))
    throw new Error("Choose a local model using the import dialog");
  const stat = fs.lstatSync(sourcePath);
  if (stat.isSymbolicLink()) throw new Error("Choose the model itself instead of a symbolic link");
  let files;
  let leadingSilenceSeconds = 0;
  if (engine === "whisper") {
    validateWhisper(sourcePath);
    files = [[sourcePath, "model.bin"]];
  } else {
    if (!stat.isDirectory())
      throw new Error(
        "Choose a sherpa-onnx NeMo transducer folder, not the original Bark .bark or PyTorch file"
      );
    files = MODEL_FILES.map((canonical) => {
      const alias = canonical.replace(".int8.onnx", ".onnx");
      const source = fs.existsSync(path.join(sourcePath, canonical)) ? canonical : alias;
      const filePath = path.join(sourcePath, source);
      try {
        regularFile(filePath);
      } catch {
        throw new Error(
          `Missing ${canonical} (or ${alias}). Import a sherpa-onnx offline NeMo transducer export with encoder, decoder, joiner, and tokens.txt.`
        );
      }
      return [filePath, canonical];
    });
    for (const [filePath, canonical] of files) {
      if (!canonical.endsWith(".onnx")) {
        validateTokens(filePath);
        continue;
      }
      const metadata = inspectOnnx(filePath);
      if (canonical.startsWith("encoder") && !NEMO_MODEL_TYPES.has(metadata.model_type)) {
        throw new Error(
          "The encoder must identify a supported NeMo transducer in its ONNX metadata (model_type=nemo_transducer, EncDecRNNTBPEModel, or EncDecTDTBPEModel). Arbitrary ONNX, streaming, CTC, and text-to-speech models are not supported. Use a sherpa-onnx offline NeMo transducer export."
        );
      }
      if (canonical.startsWith("encoder") && metadata.pad_s !== undefined) {
        const padding = Number(metadata.pad_s);
        if (!Number.isFinite(padding) || padding < 0 || padding > 1)
          throw new Error("Encoder pad_s metadata must be between 0 and 1 seconds");
        leadingSilenceSeconds = padding;
      }
    }
    const manifestPath = path.join(sourcePath, "openwhispr-model.json");
    if (fs.existsSync(manifestPath)) {
      if (regularFile(manifestPath).size > 4096)
        throw new Error("openwhispr-model.json is too large");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (
        Object.keys(manifest).some((key) => key !== "leadingSilenceSeconds") ||
        !Number.isFinite(manifest.leadingSilenceSeconds) ||
        manifest.leadingSilenceSeconds < 0 ||
        manifest.leadingSilenceSeconds > 1
      ) {
        throw new Error(
          "openwhispr-model.json supports only leadingSilenceSeconds, a number from 0 to 1 (use 0.25 for the third-party Bark 3.0 sherpa export)."
        );
      }
      leadingSilenceSeconds = manifest.leadingSilenceSeconds;
    }
    if (options.leadingSilenceSeconds !== undefined)
      leadingSilenceSeconds = options.leadingSilenceSeconds;
  }
  const id = `custom-${randomUUID()}`;
  const dir = modelDirectory(id);
  fs.mkdirSync(getRoot(), { recursive: true });
  fs.mkdirSync(dir);
  try {
    let sizeBytes = 0;
    for (const [source, name] of files) {
      const dest = path.join(dir, name);
      fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
      sizeBytes += regularFile(dest).size;
    }
    const licenseDir = engine === "parakeet" ? sourcePath : path.dirname(sourcePath);
    for (const name of ["LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE", "NOTICE.txt"]) {
      const source = path.join(licenseDir, name);
      if (!fs.existsSync(source)) continue;
      if (regularFile(source).size > 1_000_000) throw new Error(`${name} is too large to import`);
      fs.copyFileSync(source, path.join(dir, name), fs.constants.COPYFILE_EXCL);
      sizeBytes += regularFile(path.join(dir, name)).size;
    }
    // Validate copied bytes too: the source may have changed while copying.
    if (engine === "whisper") validateWhisper(path.join(dir, "model.bin"));
    else {
      for (const file of MODEL_FILES.filter((file) => file.endsWith(".onnx"))) {
        const metadata = inspectOnnx(path.join(dir, file));
        if (file.startsWith("encoder") && !NEMO_MODEL_TYPES.has(metadata.model_type))
          throw new Error("Encoder changed during import; select the model again");
      }
      validateTokens(path.join(dir, "tokens.txt"));
    }
    const metadata = {
      schemaVersion: 1,
      id,
      name:
        path
          .basename(sourcePath, engine === "whisper" ? path.extname(sourcePath) : undefined)
          .trim()
          .slice(0, 100) || "Imported model",
      engine,
      provider: engine === "whisper" ? "whisper" : "nvidia",
      sizeBytes,
      leadingSilenceSeconds,
    };
    fs.writeFileSync(path.join(dir, METADATA_FILE), JSON.stringify(metadata, null, 2), {
      flag: "wx",
    });
    return descriptor(metadata);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function removeModel(id) {
  const model = getModel(id);
  if (!model) throw new Error("Imported model not found");
  fs.rmSync(modelDirectory(id), { recursive: true, force: true });
  return descriptor(model);
}

module.exports = {
  importModel,
  listModels,
  getModel,
  removeModel,
  isCustomModelId,
  resolveModelPath,
};
