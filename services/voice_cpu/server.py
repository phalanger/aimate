"""CPU realtime voice bridge for the mate panel.

The panel's realtime client connects to ws://host:8765/v1/realtime with no
auth and no subprotocol (web/js/realtime.js) and speaks the project's custom
OpenAI-Realtime-ish event protocol. On a GPU-less box the original s2s
pipeline (CUDA torch, ~25 GB) cannot run, so this drop-in backend speaks the
same protocol but assembles each turn from CPU/cloud parts:

    mic PCM -> server VAD -> faster-whisper (CPU)
            -> panel GLM proxy at /v1/chat/completions (already cloud)
            -> Piper TTS (local, CPU) -> PCM16 16k audio deltas

The browser drives VRM/Live2D lip-sync from that audio itself, so no GPU is
touched anywhere. The panel's code is unchanged.

Run:
    python server.py --host 0.0.0.0 --port 8765
"""

import argparse
import asyncio
import base64
import json
import logging
import os
import time

import numpy as np
from aiohttp import WSMsgType, web, WSCloseCode

import asr
from llm import stream_chat
from tts import synthesize_pcm16, warmup
from vad import EnergyVAD

log = logging.getLogger("voice_cpu")

PANEL_URL = os.environ.get("MATE_PANEL_URL", "http://127.0.0.1:8900")
DEFAULT_VOICE = os.environ.get("MATE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")
SAMPLE_RATE = 16000


class Session:
    """One open WebSocket: persona/voice, VAD, and the running turn."""

    def __init__(self, ws):
        self.ws = ws
        self.instructions = ""
        self.voice = DEFAULT_VOICE
        self.vad = EnergyVAD()
        self.send_lock = asyncio.Lock()
        self.turn_token = 0   # bumped to invalidate stale turns on barge-in
        self.turn_task = None
        self.pending_text = None
        self.in_turn = False  # True for the whole turn -> drop mic input (slow CPU ASR)

    async def send(self, obj):
        try:
            async with self.send_lock:
                await self.ws.send_json(obj)
        except Exception:
            # Socket closing under us; nothing useful to do with the error.
            pass

    def barge_in(self):
        """A new utterance begins, or the user cancelled: stop the turn in flight."""
        self.turn_token += 1
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()

    def start_turn(self, coro):
        self.turn_token += 1
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()
        self.turn_task = asyncio.create_task(coro)

    def close(self):
        self.turn_token += 1
        if self.turn_task and not self.turn_task.done():
            self.turn_task.cancel()


async def handle_turn(session, audio_pcm16=None, text=None):
    """One conversational turn, emitting the protocol's event order:
    response.created -> [user transcript] -> response.output_audio_transcript.done
    -> response.output_audio.delta* -> response.done   (web/js/app.js:812-817).
    """
    token = session.turn_token
    # Hold the mic off for the whole turn: ASR is slow on CPU, so without this
    # a repeated utterance barge-in's the in-flight turn before it ever replies
    # (saw 12 ASR starts, zero completions). See dispatch()'s in_turn short-
    # circuit; cleared in the finally below.
    session.in_turn = True
    try:
        await session.send({"type": "response.created"})

        user_text = text
        if audio_pcm16:
            t0 = time.monotonic()
            transcript = await asyncio.to_thread(asr.transcribe, audio_pcm16)
            log.info("asr %.2fs -> %r", time.monotonic() - t0, transcript)
            if session.turn_token != token:
                return
            await session.send({
                "type": "conversation.item.input_audio_transcription.completed",
                "transcript": transcript,
            })
            user_text = transcript

        if not (user_text or "").strip():
            await session.send({"type": "response.done"})
            return

        t0 = time.monotonic()
        full = []
        async for delta in stream_chat(PANEL_URL, session.instructions, user_text):
            if session.turn_token != token:
                return
            full.append(delta)
        reply = "".join(full)
        log.info("llm %.2fs -> %d chars", time.monotonic() - t0, len(reply))
        if session.turn_token != token:
            return

        # Full text first, then audio - the order this pipeline settled on.
        await session.send({
            "type": "response.output_audio_transcript.done",
            "transcript": reply,
        })

        if reply.strip():
            t0 = time.monotonic()
            count = 0
            async for frame in synthesize_pcm16(reply, session.voice):
                if session.turn_token != token:
                    return
                await session.send({
                    "type": "response.output_audio.delta",
                    "delta": base64.b64encode(frame).decode("ascii"),
                })
                count += 1
            log.info("tts %.2fs -> %d frames", time.monotonic() - t0, count)

        await session.send({"type": "response.done"})
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 - report to the UI, keep the session up
        log.exception("turn failed")
        await session.send({
            "type": "error",
            "error": {"message": str(exc), "type": "turn_error"},
        })
    finally:
        session.in_turn = False


async def dispatch(session, raw):
    try:
        event = json.loads(raw)
    except ValueError:
        return
    kind = event.get("type")

    if kind == "session.update":
        sess = event.get("session") or {}
        instructions = sess.get("instructions")
        if instructions is not None:
            session.instructions = instructions
        # The voice id is a Qwen3-TTS voice pack; Piper can't clone it, so
        # we keep the configured default. Re-assert it for the log.
        log.info(
            "session.update: persona %d chars, voice %s",
            len(session.instructions or ""),
            session.voice,
        )

    elif kind == "input_audio_buffer.append":
        payload = event.get("audio") or ""
        if not payload:
            return
        # For the whole turn, drop mic input entirely: ASR is slow on this CPU,
        # so a repeated utterance would barge-in the in-flight turn (and the
        # speaker's own TTS playback, picked up by the mic with no AEC, would
        # do the same). One utterance runs to completion, then the mic reopens.
        if session.in_turn:
            return
        pcm = base64.b64decode(payload)
        f32 = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        for happened in session.vad.feed(f32, pcm):
            if happened[0] == "speech_started":
                session.barge_in()
                await session.send({"type": "input_audio_buffer.speech_started"})
            else:  # speech_stopped
                await session.send({"type": "input_audio_buffer.speech_stopped"})
                session.start_turn(handle_turn(session, audio_pcm16=happened[1]))

    elif kind == "response.cancel":
        session.barge_in()

    elif kind == "conversation.item.create":
        item = event.get("item") or {}
        for content in item.get("content") or []:
            if content.get("type") == "input_text" and content.get("text"):
                session.pending_text = content["text"]

    elif kind == "response.create":
        text = session.pending_text
        session.pending_text = None
        session.start_turn(handle_turn(session, text=text))


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    session = Session(ws)
    await session.send({"type": "session.created"})
    log.info("client connected")
    try:
        async for message in ws:
            if message.type == WSMsgType.TEXT:
                await dispatch(session, message.data)
            elif message.type == WSMsgType.ERROR:
                break
    finally:
        session.close()
        log.info("client disconnected")
    return ws


async def health(request):
    # The panel marks voice up if http://127.0.0.1:8765/ answers at all
    # (server/server.py, answering()). Plain 200 is enough.
    return web.Response(text="voice_cpu ok", status=200)


async def prewarm(app):  # noqa: ARG001
    # Load Whisper and the Piper voice off the event loop so the first turn
    # isn't slow. Both are blocking and would stall startup if run inline.
    asyncio.create_task(asyncio.to_thread(asr.get_model))
    asyncio.create_task(asyncio.to_thread(warmup))


def main():
    parser = argparse.ArgumentParser(description="CPU realtime voice bridge")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/v1/realtime", websocket_handler)
    app.on_startup.append(prewarm)

    log.info(
        "voice_cpu on %s:%d (panel=%s, voice=%s)",
        args.host, args.port, PANEL_URL, DEFAULT_VOICE,
    )
    web.run_app(app, host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
