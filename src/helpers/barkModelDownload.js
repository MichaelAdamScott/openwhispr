const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { downloadFile } = require("./downloadUtils");

// Registry entries pin every file to a revision and SHA-256. Publish the folder
// only after all files verify, then test the native decoder before reporting ready.
async function downloadBarkModel({
  modelName,
  info,
  modelsDir,
  signal,
  onProgress,
  probe,
  download = downloadFile,
}) {
  if (!/^bark-3-0(?:-plus|-clean)?$/.test(modelName)) throw new Error("Unknown Bark model");
  const root = path.resolve(modelsDir);
  const target = path.resolve(root, modelName);
  if (path.dirname(target) !== root) throw new Error("Invalid Bark cache path");
  const allowed = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
    "LICENSE",
    "NOTICE",
  ];
  const files = info.downloadFiles;
  if (
    !Array.isArray(files) ||
    files.length !== allowed.length ||
    new Set(files.map((f) => f.name)).size !== allowed.length ||
    files.some(
      (f) =>
        !allowed.includes(f.name) ||
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !Number.isSafeInteger(f.size) ||
        f.size <= 0
    )
  ) {
    throw new Error("Invalid Bark download manifest");
  }
  await fs.promises.mkdir(root, { recursive: true });
  if (fs.existsSync(target))
    throw new Error(
      "An incomplete Bark folder already exists. Remove this model and retry the download."
    );
  const stage = await fs.promises.mkdtemp(path.join(root, ".bark-download-"));
  let published = false;
  let completed = 0;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const checkAbort = () => {
    if (signal?.aborted)
      throw Object.assign(new Error("Download interrupted by user"), { isAbort: true });
  };
  try {
    for (const file of files) {
      checkAbort();
      const output = path.join(stage, file.name);
      await download(file.url, output, {
        signal,
        timeout: 600000,
        onProgress: (bytes) => onProgress?.(completed + bytes, total),
      });
      checkAbort();
      const hash = crypto.createHash("sha256");
      let size = 0;
      for await (const chunk of fs.createReadStream(output)) {
        checkAbort();
        hash.update(chunk);
        size += chunk.length;
      }
      if (size !== file.size || hash.digest("hex") !== file.sha256)
        throw new Error("Bark file failed checksum verification: " + file.name);
      completed += file.size;
      onProgress?.(completed, total);
    }
    checkAbort();
    await fs.promises.rename(stage, target);
    published = true;
    const loaded = await probe();
    if (!loaded?.success)
      throw new Error(loaded?.reason || "The local runtime could not load this Bark model");
    checkAbort();
    return target;
  } catch (error) {
    if (published) await fs.promises.rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
}
module.exports = { downloadBarkModel };
