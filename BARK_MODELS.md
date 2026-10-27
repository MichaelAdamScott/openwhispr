# Bark models and dictation cleanup

Open **Settings → Transcription → Local → Bark**, or choose Bark during initial
local-model setup. Download the model you want. OpenWhispr verifies every file's
SHA-256 and tests the native decoder before reporting the model ready.

| Model          | Transcript style                               | ONNX download                                                |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Bark 3.0       | Verbatim; keeps fillers and hesitations        | Available, about 685 MB                                      |
| Bark 3.0 Plus  | Verbatim; keeps fillers and hesitations        | Available, about 685 MB                                      |
| Bark 3.0 Clean | Removes fillers, false starts, and repetitions | Available, about 685 MB; recommended for dictation           |
| Bark 3.0 Pro   | Verbatim                                       | No verified compatible ONNX export available in this catalog |

These are community sherpa-onnx exports from
[velddev](https://huggingface.co/velddev), not the publisher's original packed
`.bark` files. Their exact revisions, file sizes, and checksums are pinned in
`src/models/modelRegistryData.json`. License and attribution files are retained.
The native inference path uses the private command-line runtime, opens no
listening port, and runs on CPU. The model reloads per decode.

## What cleanup means

Standard Bark and Bark Plus deliberately preserve what was said, including
"um," "uh," and repeats. Choose
[Bark Clean](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0-Clean) for
readable dictation with disfluency removal built into the speech model. It does
not require a separate language model or a cloud cleanup request. Recognition
and punctuation are still model predictions; perfect cleanup is not guaranteed.

Silent pauses have no words to put into the transcript. This feature produces
cleaner text; it does not trim silence or alter the saved audio recording.
Existing optional language-model cleanup can still be configured separately for
additional text editing. This change does not silently enable a cloud service.

Standard and Plus use 0.25 seconds of leading silence. Clean uses zero. Catalog
downloads choose this automatically. Imported folders read their encoder
metadata; the optional padding override is for Standard/Plus and should stay
unchecked for Clean.

## Windows validation

The real Electron download path fetched all six pinned Bark Clean files from
Hugging Face, verified their hashes, installed the model, and loaded it through
the actual `ParakeetManager`. It then decoded a 16 kHz mono Windows-generated
speech sample without any language-model postprocessing:

- Spoken: "Um, I, I would like to, uh, schedule a meeting for, um, tomorrow at three."
- Result: "I would like to schedule a meeting for, tomorrow at three."

The filler words and repeated "I" were removed; the extra comma remained. This
is a native smoke test, not a benchmark of human dictation accuracy. The runtime
reported `transport=stdio` and `port=null`.

Automated tests cover provider grouping, setup restoration, background download
activation, model-specific padding, checksum failures, cancellation, rollback,
native load failures, and manifest path validation. Standard and Plus use the
same checked download path; their newly cataloged downloads have not each been
run as full network/inference smoke tests. Standard's imported ONNX runtime was
verified in the earlier Windows validation.
