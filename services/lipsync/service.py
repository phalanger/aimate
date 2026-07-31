"""Real-time lip-sync service.

Runs on its own interpreter (runtime/python/musetalk): MuseTalk pins torch 2.0.1 with
CUDA 11.8, while the voice pipeline runs torch 2.9 with CUDA 12.8. They cannot
share an interpreter, so they talk over HTTP and a WebSocket instead.

MuseTalk splits into two very different phases, and the split is what makes it
usable for conversation:

  preparation  video -> per-frame face detection, face parsing, VAE latents.
               Slow (minutes) and needs the mmpose stack. Runs once per
               character, then lives in a cache on disk.

  inference    audio -> whisper features -> UNet -> VAE decode -> frames.
               Fast enough for real time, and touches none of the heavy
               preprocessing.

So the character's video is prepared ahead of time, and each spoken turn only
pays for the second phase.

Endpoints
    GET  /health                 model and avatar status
    GET  /avatars                prepared avatars
    POST /prepare                build the cache for one video
    WS   /stream?avatar=<id>     audio in, JPEG frames out
"""

import argparse
import asyncio
import base64
import json
import os
import sys
import time
import traceback
from pathlib import Path

# This file lives at <root>/services/lipsync/, so the project root is two
# levels up. Everything else is derived from it rather than from the working
# directory, which is not ours to depend on.
ROOT = Path(__file__).resolve().parents[2]

# MuseTalk imports resolve against its repo root.
REPO = ROOT / "runtime" / "musetalk"
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

DEFAULT_HOST = "127.0.0.1"
PANEL_SETTINGS = ROOT / "config" / "settings.json"


def read_lan_setting():
    """Follow the panel's network setting so the two agree.

    If the panel is reachable from the network but this service is not, the
    page loads on another device and then silently has no lip sync.
    """
    try:
        with open(PANEL_SETTINGS, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for group in data.get("groups", []):
            for item in group.get("items", []):
                if item.get("key") == "lan_access":
                    return bool(item.get("value"))
    except Exception:
        pass
    return False
DEFAULT_PORT = 8930
DEFAULT_FPS = 25

# Audio arrives from the TTS at the pipeline rate; MuseTalk's whisper front end
# expects 16 kHz, which happens to match.
AUDIO_SAMPLE_RATE = 16000

# Chunk size trades startup latency against throughput. Measured on this
# machine, warmed:
#
#   0.6 s -> first frame 1.73 s, 2.98x realtime  (fixed per-pass cost dominates)
#   1.0 s -> first frame 0.88 s, 0.98x realtime
#   2.5 s -> first frame 2.07 s, 0.92x realtime
#
# Below about a second the fixed cost of a whisper pass (its feature extractor
# zero-pads every input to 30 s) stops being amortised and generation falls
# behind. One second keeps up while starting more than twice as fast as the
# larger chunk, which matters because the speaker waits for the first frames.
MIN_CHUNK_SECONDS = 1.0


class ServiceState:
    def __init__(self, args):
        self.args = args
        self.ready = False
        self.error = None
        self.avatars = {}
        self.lock = asyncio.Lock()

        # Populated by load_models(). Which half is used depends on --backend.
        self.vae = None
        self.unet = None
        self.pe = None
        self.whisper = None
        self.audio_processor = None
        self.weight_dtype = None
        self.timesteps = None
        self.device = None

        # FlashHead: one pipeline shared by every avatar, re-armed on the way
        # into each turn, so it has to remember which avatar it is holding.
        self.pipeline = None
        self.infer_params = None
        self.active_avatar = None


STATE = None


def backend(state):
    """The module implementing the selected backend.

    Imported on demand: avatar.py pulls in MuseTalk at module level and
    flashhead_avatar.py pulls in the FlashHead checkout, and neither import can
    succeed on the other's interpreter.
    """
    if state.args.backend == "flashhead":
        import flashhead_avatar

        return flashhead_avatar

    import avatar

    return avatar


def load_models(state):
    if state.args.backend == "flashhead":
        backend(state).load_models(state)
        return
    _load_musetalk_models(state)


def _load_musetalk_models(state):
    """Load the inference-time models. Preprocessing models load lazily."""
    import torch

    from musetalk.utils.utils import load_all_model
    from musetalk.utils.audio_processor import AudioProcessor

    args = state.args
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    state.device = device

    vae, unet, pe = load_all_model(
        unet_model_path=args.unet_model_path,
        vae_type=args.vae_type,
        unet_config=args.unet_config,
        device=device,
    )

    # half precision on GPU: the UNet and VAE decode dominate the per-frame
    # cost, and fp16 is what makes 25 fps reachable.
    if device.type == "cuda":
        vae.vae = vae.vae.half()
        unet.model = unet.model.half()
        pe = pe.half()
        state.weight_dtype = torch.float16
    else:
        state.weight_dtype = torch.float32

    state.vae = vae
    state.unet = unet
    state.pe = pe
    state.timesteps = torch.tensor([0], device=device)

    state.audio_processor = AudioProcessor(feature_extractor_path=args.whisper_dir)

    from transformers import WhisperModel

    whisper = WhisperModel.from_pretrained(args.whisper_dir)
    whisper = whisper.to(device=device, dtype=state.weight_dtype).eval()
    whisper.requires_grad_(False)
    state.whisper = whisper

    state.ready = True


def build_app(state):
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import JSONResponse

    app = FastAPI(title="mate musetalk service")

    @app.get("/health")
    def health():
        return {
            "ready": state.ready,
            "error": state.error,
            "device": str(state.device),
            "avatars": sorted(state.avatars),
        }

    @app.get("/avatars")
    def avatars():
        return {"avatars": [a.describe() for a in state.avatars.values()]}

    @app.post("/prepare")
    async def prepare(payload: dict):
        avatar_id = payload.get("avatar_id")
        video_path = payload.get("video_path")
        if not avatar_id or not video_path:
            return JSONResponse({"error": "avatar_id and video_path are required"}, 400)

        # Preparation is GPU-heavy and single-threaded; serialise it so two
        # requests cannot fight over the card.
        async with state.lock:
            try:
                avatar = await asyncio.to_thread(
                    prepare_avatar,
                    state,
                    avatar_id,
                    video_path,
                    payload.get("bbox_shift", 0),
                    payload.get("idle_video", ""),
                )
            except Exception as exc:
                traceback.print_exc()
                return JSONResponse({"error": str(exc)}, 500)
        state.avatars[avatar_id] = avatar
        return {"ok": True, "avatar": avatar.describe()}

    @app.websocket("/stream")
    async def stream(websocket: WebSocket):
        await websocket.accept()
        avatar_id = websocket.query_params.get("avatar")
        avatar = state.avatars.get(avatar_id)
        if avatar is None:
            # Coded, not just described: the panel turns this one into "the
            # materials for this character have not been prepared", which is
            # a different instruction from "the service is not running".
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "unknown_avatar",
                    "message": "unknown avatar: %s" % avatar_id,
                }
            )
            await websocket.close()
            return

        await websocket.send_json(
            {"type": "ready", "avatar": avatar_id, "cycle": avatar.cycle_length(), "fps": state.args.fps}
        )

        session = StreamSession(state, avatar, websocket)
        try:
            await session.run()
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            traceback.print_exc()
            try:
                await websocket.send_json({"type": "error", "message": str(exc)})
            except Exception:
                pass

    return app


def restore_cached_avatars(state):
    """Re-register avatars that were prepared in an earlier run.

    Preparation results live on disk, so a restart should not force the user
    back through a two-minute rebuild for work that is already done.
    """
    Avatar = backend(state).Avatar
    wanted = "flashhead" if state.args.backend == "flashhead" else "musetalk"

    cache_dir = state.args.cache_dir
    if not os.path.isdir(cache_dir):
        return

    for name in sorted(os.listdir(cache_dir)):
        info_path = os.path.join(cache_dir, name, "info.json")
        if not os.path.exists(info_path):
            continue
        try:
            with open(info_path, "r", encoding="utf-8") as handle:
                info = json.load(handle)
            # Both backends cache under var/cache-lipsync, and their contents
            # are not interchangeable. Anything built by the other one is
            # skipped rather than half-loaded. (MuseTalk's caches predate the
            # field, so a missing backend means musetalk.)
            built_by = info.get("backend", "musetalk")
            if built_by != wanted:
                # Said out loud. Skipping in silence leaves a character whose
                # avatar simply is not there, with nothing in the log to say
                # why or what to do about it.
                print("skipping avatar '%s': prepared for %s, needs rebuilding" % (name, built_by))
                continue
            if wanted == "flashhead":
                avatar = Avatar(
                    state,
                    name,
                    info.get("video_path", ""),
                    info.get("bbox_shift", 0),
                    idle_video=info.get("idle_video", ""),
                )
            else:
                avatar = Avatar(state, name, info.get("video_path", ""), info.get("bbox_shift", 0))
            if not avatar.is_cached():
                continue
            avatar.load()
            state.avatars[name] = avatar
            print("restored avatar '%s' (%d frames)" % (name, avatar.cycle_length()))
        except Exception as exc:
            print("could not restore avatar '%s': %s" % (name, exc))


def prepare_avatar(state, avatar_id, video_path, bbox_shift, idle_video=""):
    Avatar = backend(state).Avatar
    if state.args.backend == "flashhead":
        avatar = Avatar(state, avatar_id, video_path, bbox_shift, idle_video=idle_video)
    else:
        avatar = Avatar(state, avatar_id, video_path, bbox_shift)
    avatar.prepare()
    return avatar


class StreamSession:
    """One conversation's worth of audio in, frames out."""

    def __init__(self, state, avatar, websocket):
        self.state = state
        self.avatar = avatar
        self.websocket = websocket
        self.buffer = bytearray()
        self.frame_index = 0

    async def run(self):
        import numpy as np

        min_bytes = int(AUDIO_SAMPLE_RATE * MIN_CHUNK_SECONDS) * 2

        while True:
            message = await self.websocket.receive()
            if message.get("type") == "websocket.disconnect":
                return

            if "bytes" in message and message["bytes"]:
                self.buffer.extend(message["bytes"])
                if len(self.buffer) >= min_bytes:
                    chunk = bytes(self.buffer)
                    self.buffer.clear()
                    await self._synthesize(np.frombuffer(chunk, dtype="<i2"))
                continue

            if "text" in message and message["text"]:
                try:
                    event = json.loads(message["text"])
                except ValueError:
                    continue
                kind = event.get("type")
                if kind == "flush":
                    if self.buffer:
                        chunk = bytes(self.buffer)
                        self.buffer.clear()
                        await self._synthesize(np.frombuffer(chunk, dtype="<i2"))
                    # A backend that generates in fixed-length slices holds back
                    # whatever did not fill one. Without this the last fraction
                    # of a second of every reply would be silent-mouthed.
                    await self._flush_tail()
                    await self.websocket.send_json({"type": "flushed"})
                elif kind == "seek":
                    # The panel loops the source clip while idle and hands over
                    # the frame it is currently showing. Generating from that
                    # index makes the switch to generated frames continuous
                    # instead of snapping the pose back to the start.
                    try:
                        self.frame_index = int(event.get("index", 0))
                    except (TypeError, ValueError):
                        self.frame_index = 0
                    # A generating backend has no source frame to seek to, but
                    # it does need to know a turn is starting, so it can drop
                    # the motion state left over from the previous one and open
                    # on the same pose the idle clip was just showing.
                    begin = getattr(self.avatar, "begin_turn", None)
                    if begin is not None:
                        await asyncio.to_thread(begin)
                    await self.websocket.send_json(
                        {"type": "seeked", "index": self.frame_index, "cycle": self.avatar.cycle_length()}
                    )
                elif kind == "reset":
                    # Barge-in: drop queued audio so she stops mid-sentence
                    # rather than finishing the interrupted turn. The frame
                    # index is left alone - the body should carry on from where
                    # it is, not jump.
                    self.buffer.clear()
                    await self.websocket.send_json({"type": "reset"})
                elif kind == "close":
                    return

    async def _flush_tail(self):
        tail = getattr(self.avatar, "flush_tail", None)
        if tail is None:
            return
        try:
            frames = await asyncio.to_thread(tail)
        except Exception as exc:
            traceback.print_exc()
            await self.websocket.send_json(
                {"type": "chunk_error", "message": "%s: %s" % (type(exc).__name__, exc)}
            )
            return
        self.frame_index += len(frames)
        for jpeg in frames:
            await self.websocket.send_json(
                {
                    "type": "frame",
                    "index": self.frame_index,
                    "data": base64.b64encode(jpeg).decode("ascii"),
                }
            )

    async def _synthesize(self, pcm):
        started = time.time()
        try:
            frames = await asyncio.to_thread(self.avatar.frames_for_audio, pcm, self.frame_index)
        except Exception as exc:
            # A chunk that cannot be turned into frames is reported and skipped.
            # Letting it propagate tears down the WebSocket, which the panel can
            # only see as the whole service having gone away.
            traceback.print_exc()
            await self.websocket.send_json(
                {"type": "chunk_error", "message": "%s: %s" % (type(exc).__name__, exc)}
            )
            return
        self.frame_index += len(frames)

        for jpeg in frames:
            await self.websocket.send_json(
                {
                    "type": "frame",
                    "index": self.frame_index,
                    "data": base64.b64encode(jpeg).decode("ascii"),
                }
            )

        elapsed = time.time() - started
        audio_seconds = len(pcm) / AUDIO_SAMPLE_RATE
        await self.websocket.send_json(
            {
                "type": "stats",
                "frames": len(frames),
                "audio_seconds": round(audio_seconds, 3),
                "elapsed": round(elapsed, 3),
                # Below 1.0 means generation outruns playback, which is the
                # condition for staying in sync.
                "realtime_factor": round(elapsed / audio_seconds, 3) if audio_seconds else None,
            }
        )


def main():
    global STATE

    parser = argparse.ArgumentParser(description="real-time lip-sync service")
    # Which model generates the frames. The two cannot share a process - one
    # pins torch 2.0.1 and the other needs 2.7.1 - so this is fixed at launch
    # and only the chosen backend's module is ever imported. See
    # docs/05-lipsync-spike.md for why flashhead is the default.
    parser.add_argument("--backend", default="flashhead", choices=["musetalk", "flashhead"])
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--version", default="v15", choices=["v1", "v15"])
    parser.add_argument("--flashhead_repo", default=str(ROOT / "runtime" / "flashhead"))
    parser.add_argument(
        "--flashhead_ckpt",
        default=str(ROOT / "runtime" / "flashhead" / "models" / "SoulX-FlashHead-1_3B"),
    )
    parser.add_argument("--flashhead_model", default="lite", choices=["lite", "pro"])
    parser.add_argument(
        "--wav2vec_dir",
        default=str(ROOT / "runtime" / "flashhead" / "models" / "wav2vec2-base-960h"),
    )
    parser.add_argument("--unet_model_path", default=str(REPO / "models/musetalkV15/unet.pth"))
    parser.add_argument("--unet_config", default=str(REPO / "models/musetalkV15/musetalk.json"))
    parser.add_argument("--vae_type", default="sd-vae")
    parser.add_argument("--whisper_dir", default=str(REPO / "models/whisper"))
    # Prepared avatars are derived data: expensive to rebuild, but rebuildable,
    # so they belong in var/ with the rest of what can be deleted safely.
    parser.add_argument("--cache_dir", default=str(ROOT / "var" / "cache-lipsync"))
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    parser.add_argument("--batch_size", type=int, default=8)
    parser.add_argument("--extra_margin", type=int, default=10)
    args = parser.parse_args()

    if args.host is None:
        args.host = "0.0.0.0" if read_lan_setting() else DEFAULT_HOST

    os.makedirs(args.cache_dir, exist_ok=True)
    if args.backend == "musetalk":
        os.chdir(REPO)

    STATE = ServiceState(args)
    print("loading models (%s) ..." % args.backend)
    load_models(STATE)
    print("models ready on %s" % STATE.device)
    restore_cached_avatars(STATE)

    warm = getattr(backend(STATE), "warm_up", None)
    if warm is not None and STATE.avatars:
        # Any prepared avatar will do: the kernels compiled depend on the
        # shapes, which are fixed, not on whose face it is.
        first = STATE.avatars[sorted(STATE.avatars)[0]]
        print("warming up on '%s' ..." % first.avatar_id)
        started = time.time()
        try:
            warm(STATE, first)
            print("warm up done in %.1fs" % (time.time() - started))
        except Exception:
            # A failed warm up is not a failed service - it only means the
            # first reply pays the compile instead.
            traceback.print_exc()
            print("warm up failed; the first reply will be slow")

    import uvicorn

    serve(build_app(STATE), args.host, args.port)


def serve(app, host, port):
    """Run the app on a selector event loop, never the proactor one.

    Windows defaults to asyncio's proactor loop, and uvicorn hardcodes that
    choice rather than reading the global policy. The proactor loop cannot
    survive a failed accept: when a client connects and drops before the
    pending AcceptEx completes, the completion fails - WinError 64, "the
    specified network name is no longer available" - and proactor_events.py
    responds by closing the *listening* socket. The process stays up with the
    models still in VRAM, but the port is gone for good, so every later probe
    times out and the service sits at "starting" forever. That is what happened
    here on 2026-07-30: the listener died in the same second it opened.

    A busy loop is what makes this likely, because a pending accept only fails
    if the connection is gone before the loop collects it - and this loop is
    busy exactly when everything is probing it. The selector loop treats the
    same event as nothing: a dropped connection raises ConnectionAbortedError,
    which it swallows, and any other accept error propagates to the loop's
    exception handler with the listening socket left open.

    Reproduced both ways before changing this, with a hammer of reset-on-
    connect clients against a deliberately blocked loop: proactor lost the
    port on the first failure, selector kept serving. Nothing here needs what
    the proactor loop is for - asyncio subprocesses; the blocking work goes
    through asyncio.to_thread.
    """
    import uvicorn

    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    # Built here rather than asked of uvicorn: its loop choice is made by a
    # factory that returns the proactor loop on Windows, and running serve()
    # on a loop we own is the one way that cannot be overridden underneath us.
    loop = asyncio.SelectorEventLoop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(server.serve())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
