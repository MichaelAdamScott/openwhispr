const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { resolveBinaryPath, getAvailableParallelism } = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { createAbortError } = require("./abortError");
const { getModel, resolveModelPath } = require("./customLocalModels");

// The upstream sherpa websocket executable binds all network interfaces. Custom
// models use its offline CLI instead, with files and stdout and no listening port.
class CustomParakeetCli {
  constructor() {
    this.children = new Set();
    this.modelName = null;
    this.ready = false;
    this.maxConcurrentDecodes = 1;
  }

  getBinaryPath() {
    const suffix = process.platform === "win32" ? ".exe" : "";
    return resolveBinaryPath(`sherpa-onnx-offline-${process.platform}-${process.arch}${suffix}`);
  }

  isAvailable() {
    return !!this.getBinaryPath();
  }

  async start(modelName) {
    if (this.ready && this.modelName === modelName) return;
    // Loading and decoding one second of silence verifies the complete graph,
    // not just the filenames or the presence of a model metadata string.
    await this.transcribe(modelName, Buffer.alloc(16000 * 4));
    this.modelName = modelName;
    this.ready = true;
  }

  async transcribe(modelName, samples, sampleRate = 16000, { signal } = {}) {
    if (signal?.aborted) throw createAbortError("Local transcription cancelled");
    const binary = this.getBinaryPath();
    if (!binary)
      throw new Error(
        "The private local ONNX runtime is missing. Install this fork's bundled sherpa-onnx-offline runtime before importing an ONNX model."
      );
    const modelDir = resolveModelPath(modelName, "parakeet");
    const model = getModel(modelName);
    if (!Buffer.isBuffer(samples) || samples.length % 4)
      throw new Error("Expected float32 speech samples");
    const leadingSamples = Math.round((model.leadingSilenceSeconds || 0) * sampleRate);
    const count = samples.length / 4;
    const dataSize = (count + leadingSamples) * 2;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < count; i++) {
      const value = Math.max(-1, Math.min(1, samples.readFloatLE(i * 4)));
      wav.writeInt16LE(
        Math.round(value * (value < 0 ? 32768 : 32767)),
        44 + (i + leadingSamples) * 2
      );
    }
    const tempDir = await fs.promises.mkdtemp(path.join(getSafeTempDir(), "ow-custom-asr-"));
    const inputPath = path.join(tempDir, "speech.wav");
    const started = Date.now();
    try {
      await fs.promises.writeFile(inputPath, wav);
      const args = [
        `--tokens=${path.join(modelDir, "tokens.txt")}`,
        `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
        `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
        `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
        "--model-type=nemo_transducer",
        "--decoding-method=greedy_search",
        `--num-threads=${Math.max(1, Math.min(4, getAvailableParallelism()))}`,
        inputPath,
      ];
      const stdout = await new Promise((resolve, reject) => {
        let closed = false;
        let outcome;
        const settle = () => {
          // execFile calls back immediately for AbortSignal errors, before the
          // process closes. Retain it and its WAV until Windows releases handles.
          if (!closed || !outcome) return;
          this.children.delete(child);
          const { error, output, stderr } = outcome;
          if (signal?.aborted) return reject(createAbortError("Local transcription cancelled"));
          if (error) {
            const details = String(stderr || error.message)
              .trim()
              .slice(-1200);
            return reject(new Error(`The imported ONNX model could not run: ${details}`));
          }
          resolve(output);
        };
        const child = execFile(
          binary,
          args,
          {
            windowsHide: true,
            cwd: tempDir,
            timeout: 180000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf8",
            ...(signal ? { signal } : {}),
          },
          (error, output, stderr) => {
            outcome = { error, output, stderr };
            settle();
          }
        );
        this.children.add(child);
        child.once("close", () => {
          closed = true;
          settle();
        });
      });
      const results = String(stdout)
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const item = JSON.parse(line);
            return typeof item.text === "string" ? [item] : [];
          } catch {
            return [];
          }
        });
      if (results.length !== 1)
        throw new Error("Local ONNX runtime returned an invalid transcription response");
      return {
        text: results[0].text.replace(/<unk>/g, "").trim(),
        elapsed: (Date.now() - started) / 1000,
      };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  async stop() {
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise((resolve, reject) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            const timeout = setTimeout(
              () =>
                reject(
                  new Error("Local ONNX runtime did not stop; wait before removing its model")
                ),
              5000
            );
            const finished = () => {
              clearTimeout(timeout);
              resolve();
            };
            child.once("close", finished);
            child.kill();
          })
      )
    );
    this.modelName = null;
    this.ready = false;
  }

  getStatus() {
    return {
      running: this.children.size > 0,
      ready: this.ready,
      model: this.modelName,
      modelName: this.modelName,
      port: null,
      transport: "stdio",
      runtime: "offline",
    };
  }
}

module.exports = CustomParakeetCli;
