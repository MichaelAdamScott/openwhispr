const fs = require("fs");
const path = require("path");
const { getModelsDirForService } = require("./modelDirUtils");
const catalog = require("../models/modelRegistryData.json").parakeetModels;

function isBarkModel(modelName) {
  return catalog[modelName]?.organization?.id === "bark";
}

// Preserve model IDs and selections while moving completed downloads out of the
// historical shared ONNX cache. A same-volume rename preserves the model bytes.
function getBarkModelPath(modelName, options = {}) {
  if (!isBarkModel(modelName) || path.basename(modelName) !== modelName) {
    throw new Error("Unknown Bark model");
  }
  const barkDir = path.resolve(options.barkDir || getModelsDirForService("bark"));
  const legacyDir = path.resolve(options.legacyDir || getModelsDirForService("parakeet"));
  const target = path.resolve(barkDir, modelName);
  const source = path.resolve(legacyDir, modelName);
  if (path.dirname(target) !== barkDir || path.dirname(source) !== legacyDir) {
    throw new Error("Bark model path is outside its cache directory");
  }
  if (source !== target && fs.existsSync(source) && !fs.existsSync(target)) {
    const sourceInfo = fs.lstatSync(source);
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw new Error("The legacy Bark model must be a regular model directory");
    }
    fs.mkdirSync(barkDir, { recursive: true });
    try {
      fs.renameSync(source, target);
    } catch (error) {
      throw new Error(
        `Could not move ${modelName} to bark-models. Close other copies of the app and retry. ${error.message}`
      );
    }
  }
  return target;
}

module.exports = { isBarkModel, getBarkModelPath };
