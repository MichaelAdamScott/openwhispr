// The main process owns the file dialog: the renderer chooses a supported engine,
// never a filesystem path. A copied model is published only after the engine loads it.
function registerCustomLocalSpeechIpc({
  ipcMain,
  dialog,
  BrowserWindow,
  whisperManager,
  parakeetManager,
  registry = require("./customLocalModels"),
}) {
  let mutating = false;
  const managerFor = (engine) => (engine === "whisper" ? whisperManager : parakeetManager);
  const failure = (error) => ({ success: false, error: error.message || String(error) });

  ipcMain.handle("list-custom-local-speech-models", async () => {
    try {
      return { success: true, models: registry.listModels() };
    } catch (error) {
      return { ...failure(error), models: [] };
    }
  });

  ipcMain.handle("import-custom-local-speech-model", async (event, engine, importOptions = {}) => {
    if (engine !== "whisper" && engine !== "parakeet") {
      return failure(new Error("Choose a Whisper model file or a compatible ONNX model folder."));
    }
    if (
      !importOptions ||
      typeof importOptions !== "object" ||
      Array.isArray(importOptions) ||
      Object.keys(importOptions).some((key) => key !== "leadingSilenceSeconds") ||
      (importOptions.leadingSilenceSeconds !== undefined &&
        (engine !== "parakeet" ||
          !Number.isFinite(importOptions.leadingSilenceSeconds) ||
          importOptions.leadingSilenceSeconds < 0 ||
          importOptions.leadingSilenceSeconds > 1))
    ) {
      return failure(new Error("Invalid local model audio options."));
    }
    if (mutating) return failure(new Error("Another model import or removal is in progress."));
    mutating = true;
    let model;
    try {
      const options = {
        title:
          engine === "whisper" ? "Import local Whisper model" : "Import local ONNX speech model",
        properties: [engine === "whisper" ? "openFile" : "openDirectory"],
        ...(engine === "whisper"
          ? { filters: [{ name: "Whisper GGML model", extensions: ["bin"] }] }
          : {}),
      };
      const parent = BrowserWindow.fromWebContents(event.sender);
      const selected = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      if (selected.canceled || !selected.filePaths?.length) {
        return { success: false, canceled: true };
      }
      model = await registry.importModel(engine, selected.filePaths[0], importOptions);
      const manager = managerFor(engine);
      // Release the previously selected engine too. In particular, an old stock
      // ONNX WebSocket service must not linger when importing a private model.
      await managerFor(engine === "whisper" ? "parakeet" : "whisper").stopServer();
      const loaded = await manager.startServer(
        model.id,
        engine === "whisper" ? manager.resolveGpuStartOptions() : undefined
      );
      if (!loaded?.success) {
        throw new Error(loaded?.reason || "The local engine could not load this model.");
      }
      return { success: true, model };
    } catch (error) {
      if (model) {
        // Windows holds model files open while a native process uses them.
        try {
          await managerFor(engine).stopServer();
          await registry.removeModel(model.id);
        } catch (cleanupError) {
          return failure(new Error(`${error.message} Cleanup failed: ${cleanupError.message}`));
        }
      }
      return failure(error);
    } finally {
      mutating = false;
    }
  });

  ipcMain.handle("remove-custom-local-speech-model", async (_event, id) => {
    if (mutating) return failure(new Error("Another model import or removal is in progress."));
    mutating = true;
    try {
      const model = registry.getModel(id);
      if (!model) throw new Error("This imported model is no longer available.");
      await managerFor(model.engine).stopServer();
      await registry.removeModel(id);
      return { success: true };
    } catch (error) {
      return failure(error);
    } finally {
      mutating = false;
    }
  });
}

module.exports = { registerCustomLocalSpeechIpc };
