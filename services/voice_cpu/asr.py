"""faster-whisper ASR, resident on CPU.

The panel's offline transcriber (server/transcribe.py) loads the model per
call on CPU too, but that is a once-per-voice operation. Here we transcribe
every utterance, so the model stays resident. int8 on CPU is the fast path.

transcribe() is blocking, so callers wrap it in asyncio.to_thread - it must
not run on the event loop or the WebSocket receive loop (and barge-in) would
stall for the duration of recognition.
"""

import os
import threading

import numpy as np

_model = None
_lock = threading.Lock()


def get_model():
    global _model
    if _model is not None:
        return _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel

            import logging
            log = logging.getLogger("voice_cpu.asr")
            size = os.environ.get("MATE_ASR_MODEL", "small")
            log.info("loading faster-whisper %s (cpu, int8)...", size)
            _model = WhisperModel(size, device="cpu", compute_type="int8")
            log.info("asr ready")
    return _model


def transcribe(pcm16_bytes, language=None):
    """pcm16_bytes: raw int16 LE, 16 kHz, mono -> transcript text.

    language defaults to MATE_ASR_LANGUAGE (then "zh") so a Cantonese turn can
    be recognised as yue without changing call sites. Mirrors the GPU side's
    {asr_language} var in services.json; see docs/09-cantonese.md.
    """
    if not language:
        language = os.environ.get("MATE_ASR_LANGUAGE", "zh")
    audio = np.frombuffer(pcm16_bytes, dtype=np.int16)
    if audio.size == 0:
        return ""
    f32 = audio.astype(np.float32) / 32768.0
    model = get_model()
    # vad_filter OFF on purpose: the server-side EnergyVAD (vad.py) already
    # segments each turn, so a second Silero VAD here just double-gates and
    # strips live-mic speech that EnergyVAD accepted - the log showed it
    # remove an entire 5.3s segment, leaving `asr -> ''`. One VAD is enough.
    segments, _info = model.transcribe(f32, language=language, vad_filter=False)
    return "".join(segment.text for segment in segments).strip()
