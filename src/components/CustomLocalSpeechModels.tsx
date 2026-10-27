import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Check, Trash2 } from "./icons";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { isModeAllowedByPolicy } from "../stores/policyRules";
import type { CustomLocalSpeechModel } from "../types/electron";

interface CustomLocalSpeechModelsProps {
  selectedModelId: string;
  onSelect: (model: CustomLocalSpeechModel) => void;
  onClearSelection: (model: CustomLocalSpeechModel) => void;
  onModelsChange?: (models: CustomLocalSpeechModel[]) => void;
  streamingOnly?: boolean;
  parakeetUnavailable?: boolean;
}

const LIBRARY_CHANGED = "openwhispr-custom-speech-models-changed";

/** Imports only through a native dialog. Model paths never enter renderer state. */
export function CustomLocalSpeechModels({
  selectedModelId,
  onSelect,
  onClearSelection,
  onModelsChange,
  streamingOnly = false,
  parakeetUnavailable = false,
}: CustomLocalSpeechModelsProps) {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  const allowed = isModeAllowedByPolicy(policy, "transcription", "local");
  const [models, setModels] = useState<CustomLocalSpeechModel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [barkConversion, setBarkConversion] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<CustomLocalSpeechModel | null>(null);
  const callbacks = useRef({ onModelsChange, t });
  callbacks.current = { onModelsChange, t };
  const mounted = useRef(false);

  const updateModels = useCallback((next: CustomLocalSpeechModel[]) => {
    setModels(next);
    callbacks.current.onModelsChange?.(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI?.listCustomLocalSpeechModels?.();
      if (!mounted.current) return;
      if (!result?.success) {
        setError(
          result?.error ||
            callbacks.current.t("transcription.customLocal.loadFailed", {
              defaultValue: "Could not load imported models. Reopen this panel to try again.",
            })
        );
        return;
      }
      updateModels(result.models);
      setLoaded(true);
      setError("");
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [updateModels]);

  useEffect(() => {
    mounted.current = true;
    if (!streamingOnly && allowed) void refresh();
    const changed = () => void refresh();
    window.addEventListener(LIBRARY_CHANGED, changed);
    window.addEventListener("openwhispr-models-cleared", changed);
    return () => {
      mounted.current = false;
      window.removeEventListener(LIBRARY_CHANGED, changed);
      window.removeEventListener("openwhispr-models-cleared", changed);
    };
  }, [allowed, refresh, streamingOnly]);

  const importModel = async (engine: CustomLocalSpeechModel["engine"]) => {
    if (busy || !allowed || streamingOnly || (engine === "parakeet" && parakeetUnavailable)) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.electronAPI.importCustomLocalSpeechModel(
        engine,
        engine === "parakeet" && barkConversion ? { leadingSilenceSeconds: 0.25 } : undefined
      );
      if (!mounted.current || result.canceled) return;
      if (!result.success || !result.model) {
        setError(
          result.error ||
            t("transcription.customLocal.importFailed", {
              defaultValue: "Could not import this model. Check its format and try again.",
            })
        );
        return;
      }
      const imported = result.model;
      updateModels([...models.filter((model) => model.id !== imported.id), imported]);
      setLoaded(true);
      onSelect(imported);
      window.dispatchEvent(new Event(LIBRARY_CHANGED));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const removeModel = async () => {
    const model = pendingRemoval;
    if (!model || busy || !allowed) return;
    setPendingRemoval(null);
    setBusy(true);
    setError("");
    try {
      const result = await window.electronAPI.removeCustomLocalSpeechModel(model.id);
      if (!mounted.current) return;
      if (!result.success) {
        setError(
          result.error ||
            t("transcription.customLocal.removeFailed", {
              defaultValue: "Could not remove this model. Try again after transcription finishes.",
            })
        );
        return;
      }
      updateModels(models.filter((entry) => entry.id !== model.id));
      if (selectedModelId === model.id) onClearSelection(model);
      window.dispatchEvent(new Event(LIBRARY_CHANGED));
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  if (!allowed) return null;
  if (streamingOnly) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("transcription.customLocal.streamingUnavailable", {
          defaultValue:
            "Imported models transcribe after recording stops and are unavailable for live meeting transcription.",
        })}
      </p>
    );
  }

  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-surface-1 p-3"
      aria-busy={busy}
    >
      <h3 className="text-sm font-semibold text-foreground">
        {t("transcription.customLocal.title", { defaultValue: "Your local speech models" })}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("transcription.customLocal.description", {
          defaultValue:
            "Import a model already on your computer. OpenWhispr keeps its own copy and runs it locally, with no server setup.",
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !loaded}
          onClick={() => void importModel("whisper")}
        >
          {t("transcription.customLocal.importWhisper", { defaultValue: "Import Whisper .bin" })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || !loaded || parakeetUnavailable}
          onClick={() => void importModel("parakeet")}
        >
          {t("transcription.customLocal.importOnnx", { defaultValue: "Import ONNX folder" })}
        </Button>
      </div>
      <label className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <input
          type="checkbox"
          checked={barkConversion}
          disabled={busy || parakeetUnavailable}
          onChange={(event) => setBarkConversion(event.target.checked)}
          className="mt-0.5 accent-primary"
        />
        {t("transcription.customLocal.barkConversion", {
          defaultValue:
            "Importing a Bark 3.0 ONNX conversion (experimental). Add its required 0.25 seconds of leading silence.",
        })}
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("transcription.customLocal.formats", {
          defaultValue:
            "Supports whisper.cpp GGML .bin files and sherpa-onnx compatible NeMo transducer folders with encoder, decoder, joiner and tokens. Bark 3.0 needs a compatible ONNX conversion; original .bark, MLX and CoreML files cannot be imported.",
        })}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("transcription.customLocal.onnxPerformance", {
          defaultValue:
            "Imported ONNX models run on your CPU and reload for each recording, so larger models can be slower.",
        })}
      </p>
      {busy && (
        <p role="status" className="text-xs text-primary">
          {t("transcription.customLocal.busy", {
            defaultValue:
              "Checking and loading the model locally. Large models may take a few minutes…",
          })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!error &&
        loaded &&
        selectedModelId.startsWith("custom-") &&
        !models.some((model) => model.id === selectedModelId) && (
          <p role="status" className="text-xs text-destructive">
            {t("transcription.customLocal.missing", {
              defaultValue:
                "The selected imported model is unavailable. Import it again or choose another model.",
            })}
          </p>
        )}
      {models.length > 0 && (
        <ul className="space-y-1">
          {models.map((model) => {
            const selected = model.id === selectedModelId;
            const unavailable = parakeetUnavailable && model.engine === "parakeet";
            return (
              <li
                key={model.id}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${selected ? "border-primary bg-primary/5" : "border-border"}`}
              >
                <button
                  type="button"
                  aria-pressed={selected}
                  disabled={busy || unavailable}
                  onClick={() => onSelect(model)}
                  className="min-w-0 flex-1 rounded text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
                >
                  <span className="block truncate text-sm font-medium text-foreground">
                    {model.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {model.engine === "whisper" ? "Whisper" : "ONNX"} ·{" "}
                    {Math.max(1, Math.round(model.sizeBytes / 1024 / 1024))} MB
                  </span>
                </button>
                {selected && (
                  <Check aria-label={t("common.active")} className="size-4 shrink-0 text-primary" />
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  aria-label={t("transcription.customLocal.removeLabel", {
                    defaultValue: "Remove {{name}} from your local models",
                    name: model.name,
                  })}
                  onClick={() => setPendingRemoval(model)}
                  className="size-7 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(pendingRemoval)}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        title={t("transcription.customLocal.removeTitle", {
          defaultValue: "Remove imported model?",
        })}
        description={t("transcription.customLocal.removeDescription", {
          defaultValue:
            "This deletes OpenWhispr’s imported copy. Your original files stay in place. If this model is selected, choose another model before transcribing.",
        })}
        confirmText={t("common.delete")}
        onConfirm={() => void removeModel()}
        variant="destructive"
      />
    </section>
  );
}
