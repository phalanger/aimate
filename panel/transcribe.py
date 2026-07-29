"""Transcribe one audio file and print the text.

Run as a short-lived subprocess by the panel server rather than kept resident:
Qwen3-TTS needs the reference audio's transcript to clone a voice, but that is
a once-per-voice operation. Loading Whisper on the CPU for a few seconds costs
nothing that matters, while holding it in VRAM would compete with the running
pipeline, which is already close to the limit of the card.

Usage:  python transcribe.py <wav-path> [language]
"""

import sys
import warnings

warnings.filterwarnings("ignore")

MODEL_NAME = "openai/whisper-large-v3-turbo"
WHISPER_SAMPLE_RATE = 16000


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: transcribe.py <wav-path> [language]\n")
        return 2

    path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "zh"

    import numpy as np
    import soundfile as sf
    import torch
    from transformers import AutoProcessor, AutoModelForSpeechSeq2Seq

    audio, sr = sf.read(path, dtype="float32")
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Whisper's feature extractor rejects anything but 16 kHz, and reference
    # clips are stored at 24 kHz for the TTS, so resample before handing over.
    if sr != WHISPER_SAMPLE_RATE:
        try:
            import soxr

            audio = soxr.resample(audio, sr, WHISPER_SAMPLE_RATE)
        except ImportError:
            count = int(round(len(audio) * WHISPER_SAMPLE_RATE / sr))
            audio = np.interp(
                np.linspace(0, len(audio) - 1, count),
                np.arange(len(audio)),
                audio,
            ).astype(np.float32)
        sr = WHISPER_SAMPLE_RATE

    processor = AutoProcessor.from_pretrained(MODEL_NAME)
    model = AutoModelForSpeechSeq2Seq.from_pretrained(MODEL_NAME, dtype=torch.float32)
    model.eval()

    inputs = processor(
        audio,
        sampling_rate=sr,
        return_tensors="pt",
        return_attention_mask=True,
    )

    with torch.no_grad():
        ids = model.generate(
            inputs.input_features,
            attention_mask=inputs.get("attention_mask"),
            language=language,
            task="transcribe",
            max_new_tokens=192,
        )

    text = processor.batch_decode(ids, skip_special_tokens=True)[0].strip()
    sys.stdout.buffer.write(text.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
