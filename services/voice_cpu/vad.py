"""Server-side energy VAD.

The panel expects the server to emit input_audio_buffer.speech_started and
.speech_stopped (web/js/app.js:773,789) - turn_detection is server_vad
(realtime.js:117). This is a plain RMS state machine: no torch, no native
deps, just numpy. Thresholds are in dBFS relative to full scale, so they are
independent of frame size. Defaults on=-33 / off=-43 dBFS (overridable via
MATE_VAD_ON_DB / MATE_VAD_OFF_DB); raised from -40 / -50 because at -40 the
live mic on this CPU bridge false-triggered on ambient noise and on its own
TTS playback picked up by the mic (no AEC), barge-in'ing replies before they
could play.

feed() is called from the WebSocket receive loop with whatever PCM chunk the
browser sent, and returns a list of events to handle there - keeping this a
pure function and avoiding any sync/async crossing:

    ("speech_started",)                      # barge-in: drop the running turn
    ("speech_stopped", utterance_pcm16)      # end of utterance -> run ASR

A short pre-roll is kept while silent so the utterance begins a little before
the speech-start confirmation, rather than clipping its first phoneme.
"""

import os

import numpy as np


class EnergyVAD:
    def __init__(
        self,
        on_db=None,
        off_db=None,
        start_ms=120,
        end_ms=600,
        preroll_ms=200,
        rate=16000,
    ):
        if on_db is None:
            on_db = float(os.environ.get("MATE_VAD_ON_DB", "-33.0"))
        if off_db is None:
            off_db = float(os.environ.get("MATE_VAD_OFF_DB", "-43.0"))
        self.on = 10.0 ** (on_db / 20.0)
        self.off = 10.0 ** (off_db / 20.0)
        self.start_samples = int(start_ms / 1000.0 * rate)
        self.end_samples = int(end_ms / 1000.0 * rate)
        self.preroll_samples = int(preroll_ms / 1000.0 * rate)
        self.rate = rate
        self.speaking = False
        self.confirm = 0
        self.utterance = bytearray()
        self.preroll = bytearray()

    def feed(self, f32, pcm16):
        """f32: float32 mono [-1,1]; pcm16: the same samples as raw int16 LE bytes."""
        events = []
        n = f32.size
        rms = float(np.sqrt(np.mean(f32 * f32))) if n else 0.0

        if not self.speaking:
            # Keep a rolling tail of recent audio for the pre-roll.
            self.preroll.extend(pcm16)
            excess = len(self.preroll) - self.preroll_samples * 2
            if excess > 0:
                del self.preroll[:excess]

        if not self.speaking:
            if rms >= self.on:
                self.confirm += n
                if self.confirm >= self.start_samples:
                    self.speaking = True
                    # Drop the start-confirmation count: otherwise it carries
                    # into the end-of-speech count and speech_stopped fires
                    # ~start_ms early, clipping the utterance's tail syllable.
                    self.confirm = 0
                    # preroll already ends with the triggering frame (extended
                    # above), so don't extend again - that would duplicate it.
                    self.utterance = bytearray(self.preroll)
                    self.preroll = bytearray()
                    events.append(("speech_started",))
            else:
                self.confirm = 0
        else:
            self.utterance.extend(pcm16)
            if rms < self.off:
                self.confirm += n
                if self.confirm >= self.end_samples:
                    self.speaking = False
                    self.confirm = 0
                    events.append(("speech_stopped", bytes(self.utterance)))
                    self.utterance = bytearray()
            else:
                self.confirm = 0

        return events
