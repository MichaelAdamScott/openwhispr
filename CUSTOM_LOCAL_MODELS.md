# Custom local speech recognition models

For Bark, you can now use the [Bark download catalog](BARK_MODELS.md) directly.
Choose **Bark 3.0 Clean** to remove fillers and repetitions during recognition.
Manual import remains available for compatible models you already have.

This fork adds a **Your local speech models** section to the local transcription
picker in Settings and the initial setup. Imported models stay in the library
after restarting the app. Choose a model to use it; remove it to delete only
OpenWhispr's managed copy. The original file or folder stays in place.

## Supported formats

- **Whisper model file:** a whisper.cpp GGML `.bin` speech recognition model,
  including compatible fine-tunes and quantized Whisper exports. An arbitrary
  `.bin`, an LLM GGUF file, or a Hugging Face checkpoint is not a Whisper model.
- **ONNX speech model folder:** a sherpa-onnx-compatible offline NeMo transducer
  with `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and
  `tokens.txt`. The aliases `encoder.onnx`, `decoder.onnx`, and `joiner.onnx` are
  also accepted and normalized in the managed copy. This importer supports this specific architecture;
  it does not claim that arbitrary ONNX speech models are interchangeable.
  ONNX external tensor files are currently unsupported: use exports with weights
  embedded in the graphs.

The app validates the files, copies them into its managed cache, and asks the
native engine to load them before offering the model as successfully imported.
A failed load rolls back the copy. A native runtime must be present; development
checkouts need `npm run download:whisper-cpp` and/or
`npm run download:sherpa-onnx`. Packaged builds include these runtimes.
No Python installation or model-supplied executable code is used by the importer.

## What “Bark 3.0” means

As checked on October 26, 2026, the likely intended model is
[Conway Research's Underdog Bark 3.0](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0),
an English speech-to-text model derived from NVIDIA Parakeet TDT. It is different
from [Suno Bark](https://github.com/suno-ai/bark/blob/main/model-card.md), which
generates audio from text and cannot perform dictation.

Underdog's original `model.bark` is a custom packed-weight file. Its official
Windows loader expands the weights into a Transformers/PyTorch model, using
64-bit Python 3.11 with CPU or NVIDIA CUDA. The small download is not its memory
requirement. Apple MLX and Core ML exports require different runtimes again.
None of those original packages can be loaded by whisper.cpp or sherpa-onnx.
This fork clearly rejects them instead of pretending that selecting the file
adds a runtime.

There is a
[third-party sherpa-onnx conversion](https://huggingface.co/velddev/Underdog-Bark-3.0-sherpa-onnx).
Its int8 four-file package was tested successfully with this importer on Windows. It is
larger than the original packed model, and its quantization may change accuracy.
Preserve the model's license and attribution, and do not assume the publisher's
benchmarks apply to this conversion. The original Bark 3.0 needs 0.25 seconds of
leading silence. This conversion declares that as `pad_s=0.25` in its encoder
metadata, which the importer detects automatically. The optional **Importing a
Bark 3.0 ONNX conversion** checkbox explicitly sets the same value for exports
without that metadata. Do not enable it for a different model unless its
publisher requires that padding.

To try the tested conversion, download the four int8 files listed above together
with its `LICENSE` and `NOTICE` into one folder. Choose **Import ONNX folder**,
select that folder, and wait for validation and the local load test. A successful
import selects the model immediately. Its roughly 685 MB download differs from
the original 163 MB packed `.bark` file.

Advanced exports can include `openwhispr-model.json` with
`{"leadingSilenceSeconds": 0.25}`. Only this bounded numeric option is accepted;
the app never runs commands or loads scripts from an import manifest.

## Local processing and performance

Imported Whisper models use the existing bundled whisper.cpp process bound to
`127.0.0.1`. There is no server to configure, port forwarding, or LAN listener.

Imported ONNX models use the bundled **sherpa-onnx-offline command-line
executable**. This adapter opens no listening socket. OpenWhispr's existing
WebSocket-based ONNX route binds all interfaces in its upstream binary, so it is
not used for imported models. The command-line route currently runs on CPU and
loads the model for each request. Expect more latency than a model kept in memory.
It supports recorded dictation and batch transcription, not live streaming.

The supported import workflows do not download model files or send audio to a
remote service. Installing application dependencies and obtaining model files
initially still require a download unless supplied offline. Any separately
enabled cloud text cleanup follows its existing settings.

## Development notes

The main process opens the native file/folder dialog. Renderer code sends only
an engine name or an opaque imported-model ID. Imported paths are resolved from a
validated registry under the normal OpenWhispr cache, including its Windows
path handling. Model files are copied, and selecting a model does not execute
scripts from its folder.

See `test/helpers/customLocalSpeechIpc.test.js` for native-dialog cancellation,
load-before-success, failed-load rollback, Windows handle cleanup ordering, and
overlapping import protection. The importer and adapter have additional format
and runtime-routing tests.

New import-panel wording currently uses English fallbacks in all UI languages.
See [Windows validation](WINDOWS_VALIDATION.md) for the actual native test results
and what remains outside that coverage.

## Run this fork from source

Use Node.js 24 or later and this feature branch:

```powershell
git clone --branch feature/custom-local-speech-models https://github.com/MichaelAdamScott/openwhispr.git
cd openwhispr
npm install
npm run download:whisper-cpp
npm run dev
```

The normal development setup downloads the sherpa runtime. A checkout used
without that setup can run `npm run download:sherpa-onnx` explicitly. Application
packaging uses the existing `npm run build:win` workflow; a new installer is not
included with this change.
