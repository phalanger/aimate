"""Piper TTS -> PCM16 16 kHz mono frames. Fully local, CPU, offline.

Why Piper and not edge-tts: edge-tts talks to wss://speech.platform.bing.com,
which this China network blocks even through the box's global proxy - the
proxy tunnels it only in lucky windows (verified: 0/8 over a probe), so it is
unreliable here. Piper runs entirely on the CPU from a local ONNX voice model,
so it is not subject to any of that. The trade is one fixed voice
(zh_CN-huayan-medium) rather than edge-tts's catalog, and 22050 Hz output
resampled down to the 16 kHz the panel expects.

The browser plays response.output_audio.delta as PCM16 16k mono
(web/js/audio.js:7 PIPELINE_SAMPLE_RATE=16000). synthesize_pcm16 yields that.

Piper synthesis is blocking (onnxruntime), so it runs on a worker thread - it
must not stall the WebSocket receive loop and barge-in.
"""

import asyncio
import logging
import os
import threading

import numpy as np

log = logging.getLogger("voice_cpu.tts")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODEL = os.environ.get(
    "MATE_TTS_MODEL",
    os.path.join(ROOT, "runtime", "models", "piper", "zh_CN-huayan-medium.onnx"),
)
MODEL_CONFIG = MODEL + ".json"

# Cantonese: Piper has no 粵語 voice, so when the turn language is yue we use a
# sherpa-onnx VITS model (vits-cantonese-hf-xiaomaiiwn) instead - local, CPU,
# fast (~1.5s/utterance, non-autoregressive). See docs/09-cantonese.md.
CANTONESE_DIR = os.environ.get(
    "MATE_CANTONESE_TTS",
    os.path.join(ROOT, "runtime", "models", "vits-cantonese-hf-xiaomaiiwn"),
)


def _language():
    # Tie TTS to the ASR language: the bridge already sets MATE_ASR_LANGUAGE for
    # faster-whisper, so reuse it. yue -> Cantonese sherpa; anything else -> Piper.
    return os.environ.get("MATE_TTS_LANGUAGE") or os.environ.get("MATE_ASR_LANGUAGE") or "zh"

RATE = 16000
FRAME_SAMPLES = 480  # 30 ms at 16 kHz -> 960 bytes int16

_voice = None
_lock = threading.Lock()


def warmup():
    # Only prewarm the engine the configured language actually uses.
    if _language() == "yue":
        get_sherpa()
    else:
        get_voice()


_sherpa = None
_sherpa_lock = threading.Lock()


def get_sherpa():
    global _sherpa
    if _sherpa is not None:
        return _sherpa
    with _sherpa_lock:
        if _sherpa is None:
            import sherpa_onnx  # only needed for Cantonese

            log.info("loading sherpa cantonese VITS %s ...", os.path.basename(CANTONESE_DIR))
            # rule.fst is optional (text-normalisation FST); pass "" if the
            # model pack omits it, or OfflineTts would throw at load and break
            # every yue turn.
            rule_fst = os.path.join(CANTONESE_DIR, "rule.fst")
            _sherpa = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=os.path.join(CANTONESE_DIR, "vits-cantonese-hf-xiaomaiiwn.onnx"),
                        lexicon=os.path.join(CANTONESE_DIR, "lexicon.txt"),
                        tokens=os.path.join(CANTONESE_DIR, "tokens.txt"),
                    ),
                    provider="cpu",
                ),
                rule_fsts=rule_fst if os.path.exists(rule_fst) else "",
            ))
            log.info("cantonese tts ready")
    return _sherpa


def _synth_raw_cantonese(text):
    """Run sherpa VITS on a worker thread -> (sample_rate, int16 PCM bytes)."""
    tts = get_sherpa()
    audio = tts.generate(text=text, sid=0, speed=1.0)
    samples = np.array(audio.samples, dtype=np.float32)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    return audio.sample_rate, pcm


def get_voice():
    global _voice
    if _voice is not None:
        return _voice
    with _lock:
        if _voice is None:
            from piper import PiperVoice

            log.info("loading piper voice %s ...", os.path.basename(MODEL))
            _voice = PiperVoice.load(MODEL, config_path=MODEL_CONFIG)
            log.info("tts ready (sample_rate=%d)", _voice.config.sample_rate)
    return _voice


def _synth_raw(text):
    """Run Piper on a worker thread -> (sample_rate, raw int16 PCM bytes)."""
    voice = get_voice()
    sample_rate = voice.config.sample_rate
    chunks = bytearray()
    for chunk in voice.synthesize(text):
        chunks.extend(chunk.audio_int16_bytes)
    return sample_rate, bytes(chunks)


def _resample(samples, src_rate, dst_rate):
    if src_rate == dst_rate or samples.size <= 1:
        return samples
    n_out = int(round(samples.size * dst_rate / float(src_rate)))
    if n_out <= 1:
        return np.zeros(0, dtype=np.float32)
    idx = np.linspace(0, samples.size - 1, n_out)
    return np.interp(idx, np.arange(samples.size), samples).astype(np.float32)


async def synthesize_pcm16(text, voice=None):
    """Yield int16 LE 16 kHz mono PCM byte frames for the given text.

    voice is accepted for interface parity with the panel's session.update
    flow but ignored: Piper uses the single loaded zh voice (the session voice
    id refers to a Qwen3-TTS pack this backend cannot clone).
    """
    if not text or not text.strip():
        return
    if _language() == "yue":
        sample_rate, pcm = await asyncio.to_thread(_synth_raw_cantonese, text)
    else:
        sample_rate, pcm = await asyncio.to_thread(_synth_raw, text)
    if not pcm:
        return
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    samples = _resample(samples, sample_rate, RATE)
    out = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    step = FRAME_SAMPLES * 2
    for offset in range(0, len(out), step):
        yield out[offset:offset + step]
        await asyncio.sleep(0)  # keep the receive loop responsive between frames
