"""Transcribe one reference clip, and make the clip and its transcript agree.

Run as a short-lived subprocess by the panel server rather than kept resident:
Qwen3-TTS needs the reference audio's transcript to clone a voice, but that is
a once-per-voice operation. Loading Whisper on the CPU for a few seconds costs
nothing that matters, while holding it in VRAM would compete with the running
pipeline, which is already close to the limit of the card.

Why this also edits the audio
-----------------------------
A clip cut to a requested number of seconds stops wherever it stops, usually
in the middle of a word. Speech recognition then writes that word out in full -
it heard the word begin, and has no reason to report half of one. The
transcript now claims a syllable the audio never finishes.

Voice cloning in ICL mode conditions on the reference transcript and continues
from the reference audio, so the model finishes that syllable at the start of
every reply. Measured on a clip cut at 10.000s in the middle of "yang-guang",
asking for "today the weather is fine, let us go for a walk":

    reference transcript                     result
    -------------------------------------    --------------------------------
    as recognised                            "guang, today the weather ..."
    same, full stop instead of comma         "guang, today the weather ..."
    final word removed                       "today the weather ..."     clean
    final phrase removed, audio untouched    27 seconds of babble
    final phrase removed, audio cut to match "today the weather ..."     clean

Two things fall out of that. The punctuation is irrelevant. And what matters is
that the transcript and the audio describe the same speech - a transcript that
stops well before its audio does is far worse than the original fault, because
the model has seconds of reference it was never told about.

Whisper returns phrase-sized chunks for Chinese rather than words, so the unit
available here is a phrase. Dropping a phrase from the text therefore has to
come with cutting the audio at that phrase's boundary. That costs a second or
two of reference and keeps the two halves honest.

A short silence is left on the end afterwards. It is what the cloning wants
anyway, and it makes this idempotent: on a second run the final phrase no
longer reaches the end of the audio, so there is nothing to trim.

Usage:  python transcribe.py <wav-path> [language]
"""

import sys
import unicodedata
import warnings

warnings.filterwarnings("ignore")

MODEL_NAME = "openai/whisper-large-v3-turbo"
WHISPER_SAMPLE_RATE = 16000

# The clip counts as still sounding if its last stretch is above this fraction
# of the loudest equivalent stretch. Room tone and breath sit far below it.
TAIL_WINDOW_SECONDS = 0.06
TAIL_SPEECH_FLOOR = 0.10

# A phrase whose end lands this close to the end of the audio is treated as
# the one that got cut off.
PHRASE_END_GUARD_SECONDS = 0.15

# Left on the end after trimming.
TRAILING_SILENCE_SECONDS = 0.25

# Never trim a reference below this. A slightly wrong ending beats a clip too
# short to clone from, and a clip this short means the input was wrong anyway.
MIN_KEPT_SECONDS = 3.0


def is_punctuation(character):
    """Punctuation or space, in any script.

    Asked of Unicode rather than of a list of characters: the transcript comes
    back with full-width commas, curly quotes or ideographic full stops
    depending on the language, and a hand-written list would quietly miss
    whichever one was not thought of.
    """
    return character.isspace() or unicodedata.category(character).startswith("P")


def trim_punctuation(text):
    """Strip leading and trailing punctuation, leaving the words."""
    start, end = 0, len(text)
    while start < end and is_punctuation(text[start]):
        start += 1
    while end > start and is_punctuation(text[end - 1]):
        end -= 1
    return text[start:end]


def ends_mid_speech(audio, rate):
    """Is the clip still sounding at its last sample?"""
    size = max(1, int(rate * TAIL_WINDOW_SECONDS))
    if len(audio) < size * 4:
        return False
    levels = []
    for start in range(0, len(audio) - size + 1, size):
        block = audio[start : start + size]
        levels.append(float((block * block).mean()) ** 0.5)
    peak = max(levels)
    if peak <= 0:
        return False
    return levels[-1] / peak > TAIL_SPEECH_FLOOR


def complete_phrases(chunks, duration):
    """The chunks that finish before the audio does.

    Returns None when there is nothing to drop - either every phrase finished
    in time, or dropping the last one would leave nothing.
    """
    usable = [chunk for chunk in chunks if trim_punctuation(chunk.get("text", ""))]
    if len(usable) < 2:
        return None

    last = usable[-1].get("timestamp") or (None, None)
    end = last[1]
    if end is None or end < duration - PHRASE_END_GUARD_SECONDS:
        return None

    kept = usable[:-1]
    boundary = (kept[-1].get("timestamp") or (None, None))[1]
    if boundary is None or boundary < MIN_KEPT_SECONDS:
        return None
    return kept, float(boundary)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: transcribe.py <wav-path> [language]\n")
        return 2

    path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "zh"

    import numpy as np
    import soundfile as sf
    import torch
    from transformers import pipeline

    original, original_rate = sf.read(path, dtype="float32")
    if original.ndim > 1:
        original = original.mean(axis=1)

    # Whisper's feature extractor rejects anything but 16 kHz, and reference
    # clips are stored at 24 kHz for the TTS, so resample before handing over.
    audio, rate = original, original_rate
    if rate != WHISPER_SAMPLE_RATE:
        try:
            import soxr

            audio = soxr.resample(audio, rate, WHISPER_SAMPLE_RATE)
        except ImportError:
            count = int(round(len(audio) * WHISPER_SAMPLE_RATE / rate))
            audio = np.interp(
                np.linspace(0, len(audio) - 1, count),
                np.arange(len(audio)),
                audio,
            ).astype(np.float32)
        rate = WHISPER_SAMPLE_RATE

    # The pipeline rather than the bare model, for the phrase timings: they are
    # what says where the audio may be cut without splitting speech.
    recogniser = pipeline(
        "automatic-speech-recognition",
        model=MODEL_NAME,
        dtype=torch.float32,
        device="cpu",
    )
    result = recogniser(
        {"raw": audio, "sampling_rate": rate},
        return_timestamps="word",
        generate_kwargs={"language": language, "task": "transcribe"},
    )

    text = (result.get("text") or "").strip()
    chunks = result.get("chunks") or []

    if chunks and ends_mid_speech(audio, rate):
        complete = complete_phrases(chunks, len(audio) / float(rate))
        if complete:
            kept, boundary = complete
            text = "".join(chunk.get("text", "") for chunk in kept).strip()
            keep = int(boundary * original_rate)
            silence = np.zeros(int(TRAILING_SILENCE_SECONDS * original_rate), dtype="float32")
            sf.write(path, np.concatenate([original[:keep], silence]), original_rate)

    sys.stdout.buffer.write(text.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
