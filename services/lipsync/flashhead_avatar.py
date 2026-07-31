"""SoulX-FlashHead backend: one still image in, generated frames out.

Drop-in alternative to avatar.py, exposing the same load_models/Avatar pair so
service.py can run either without knowing which. The two cannot share a
process - MuseTalk pins torch 2.0.1 and this needs 2.7.1 - so the backend is
chosen at launch and only its module is ever imported.

How this differs from MuseTalk, and why it is worth the swap (measurements in
docs/05-lipsync-spike.md):

  * MuseTalk masks the lower face and repaints the mouth from context that
    excludes it, so lip colour and texture have to be guessed. This conditions
    on the whole reference image, which is why the lipstick and the lip lines
    survive.
  * It generates about 93 FPS against MuseTalk's 25, so it produces 0.96 s of
    video in 0.26 s. MuseTalk needed 0.95 s for the same - one percent of
    headroom, which is why it lost sync whenever the GPU was busy elsewhere.

The one thing it cannot do is move a body. Generated silence is practically a
freeze frame (0.5 px of drift over 6.7 s), so the panel keeps looping the real
clip between turns and only switches to generated frames while she speaks. That
handover is a cut, so the reference still is re-framed at preparation time to
put the face exactly where the idle clip has it - see _aligned_reference.
"""

import json
import os
import shutil
from collections import deque

import cv2
import numpy as np

JPEG_QUALITY = 82

# The model is fixed at 512x512; infer_params.yaml is the authority and this is
# only the fallback if it cannot be read.
TARGET_SIZE = 512

# How much larger the face is allowed to be in the generated frames than it is
# in the idle clip.
#
# Framing the reference to match the clip exactly (1.0) is what stops the
# picture jumping when she starts talking, but it also decides how many of the
# model's 512 pixels land on the mouth - and that is what lip detail is made
# of. Measured on two avatars prepared from equally sharp 1024px stills, where
# only the clip's framing differed:
#
#   idle framed close  (face 0.357 of frame)  ->  205 px face, mouth 205x93
#   idle framed wide   (face 0.285 of frame)  ->  148 px face, mouth 147x67
#
# Half the mouth pixels, from framing alone. The close one had ended up 13.3%
# tighter than its clip because the crop hit the edge of the still, and that
# mismatch went unnoticed for days while the softer mouth on the other one was
# obvious immediately. So a small, deliberate overshoot buys real detail at a
# cost that does not show: 1.2 puts the wide example at 177 px.
DEFAULT_FACE_ZOOM = 1.2

# Matches avatar.py so both backends put the same sized picture on the wire.
STREAM_MAX_HEIGHT = 576
AUDIO_SAMPLE_RATE = 16000

_PIPELINE = None
_FACE_DETECTOR = None


def load_models(state):
    """Put the pipeline on the GPU. Called once, before any avatar is used."""
    global _PIPELINE

    import torch  # noqa: F401  (import here so the module can be read without it)

    repo = state.args.flashhead_repo
    if not os.path.isdir(repo):
        raise RuntimeError("flashhead repo not found: %s" % repo)

    # flash_head.inference opens "flash_head/configs/infer_params.yaml" relative
    # to the working directory, so the service has to run from the checkout.
    # Every path the service itself uses is absolute, so this is safe.
    os.chdir(repo)

    import sys

    if repo not in sys.path:
        sys.path.insert(0, repo)

    from flash_head.inference import get_infer_params, get_pipeline

    _PIPELINE = get_pipeline(
        world_size=1,
        ckpt_dir=state.args.flashhead_ckpt,
        wav2vec_dir=state.args.wav2vec_dir,
        model_type=state.args.flashhead_model,
    )
    state.pipeline = _PIPELINE
    state.infer_params = get_infer_params()
    state.device = "cuda" if __import__("torch").cuda.is_available() else "cpu"
    state.active_avatar = None
    state.ready = True


def warm_up(state, avatar):
    """Build the compiled kernels now instead of during the first reply.

    torch.compile does not run at load time - it runs on the first generation,
    which without this is the first thing the user says. That cost 254 s the
    very first time and around 27 s per fresh process afterwards, all of it
    with her sitting there not answering. Paying it during startup instead adds
    the same time to a service that is optional and starts in parallel, so it
    delays nothing the user is waiting on.
    """
    silence = np.zeros(int(AUDIO_SAMPLE_RATE), dtype=np.int16)
    avatar.begin_turn()
    avatar.frames_for_audio(silence)
    # Leave no motion state behind: the next real turn must open on the pose
    # the idle clip is showing, not on wherever the silence ended up.
    avatar.begin_turn()


def face_detector():
    global _FACE_DETECTOR
    if _FACE_DETECTOR is None:
        from flash_head.utils.cpu_face_handler import CPUFaceHandler

        _FACE_DETECTOR = CPUFaceHandler()
    return _FACE_DETECTOR


def _imread(path):
    """cv2.imread that survives a non-ASCII path.

    OpenCV opens image files through its own C++ IO, which on Windows goes via
    the ANSI code page - so a path like "assets/media/<chinese>.png" simply
    fails to open and imread hands back None, as if the file were corrupt.
    Reading the bytes in Python and decoding them in memory sidesteps the
    filename entirely. VideoCapture is unaffected because it hands the path to
    FFmpeg, which is why the idle clip loaded and only the still did not.
    """
    try:
        data = np.fromfile(path, dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def _imwrite(path, image):
    """cv2.imwrite counterpart to _imread, for the same reason."""
    extension = os.path.splitext(path)[1] or ".png"
    ok, buffer = cv2.imencode(extension, image)
    if not ok:
        raise RuntimeError("could not encode image as %s" % extension)
    buffer.tofile(path)


def _face_box(image_bgr):
    """Absolute (x1, y1, x2, y2) of the first face, or None."""
    rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    boxes, _ = face_detector()(rgb)
    if len(boxes) == 0:
        return None
    height, width = image_bgr.shape[:2]
    x1, y1, x2, y2 = boxes[0][:4]
    return (x1 * width, y1 * height, x2 * width, y2 * height)


def _first_frame_and_count(video_path):
    capture = cv2.VideoCapture(video_path)
    ok, frame = capture.read()
    count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if count <= 0:
        count = 1
        while capture.read()[0]:
            count += 1
    capture.release()
    if not ok:
        raise RuntimeError("could not read any frame from %s" % video_path)
    return frame, count


def _aligned_reference(still_bgr, idle_frame_bgr, target, face_zoom=DEFAULT_FACE_ZOOM):
    """Re-frame the still so its face sits where the idle clip's face sits.

    Between turns the panel loops the real clip; while she speaks it shows
    generated frames. Both are the same size on screen, so if the face is a
    different size or in a different place in the two, every reply starts with a
    visible jump. Cropping the still to match removes the jump at the source
    rather than trying to hide it with a fade.

    The still is deliberately higher resolution than the clip, so this is a
    downscale and costs no detail.

    `face_zoom` deliberately overshoots that match - see DEFAULT_FACE_ZOOM. The
    position still lines up; only the size runs slightly large, which reads as a
    gentle push-in rather than as a cut.
    """
    idle_box = _face_box(idle_frame_bgr)
    still_box = _face_box(still_bgr)
    if idle_box is None:
        raise RuntimeError("no face detected in the idle clip")
    if still_box is None:
        raise RuntimeError("no face detected in the reference image")

    idle_h, idle_w = idle_frame_bgr.shape[:2]
    ix1, iy1, ix2, iy2 = idle_box
    # Where the idle clip puts the face, as fractions of the frame.
    face_fraction = (iy2 - iy1) / float(idle_h)
    centre_x = ((ix1 + ix2) / 2.0) / float(idle_w)
    centre_y = ((iy1 + iy2) / 2.0) / float(idle_h)

    sx1, sy1, sx2, sy2 = still_box
    still_face = sy2 - sy1
    still_cx = (sx1 + sx2) / 2.0
    still_cy = (sy1 + sy2) / 2.0

    # A square crop of this side length puts the face at face_zoom times the
    # fraction it occupies in the clip - the same fraction when that is 1.0.
    height, width = still_bgr.shape[:2]
    ideal = still_face / max(face_fraction * face_zoom, 1e-6)

    # Matching exactly usually needs more picture than the still contains: a
    # face filling more of its frame than the clip's does has to be zoomed out
    # past the edges. Nothing is invented to cover that. Both ways of filling
    # it in were tried and both are worse than a small mismatch - replicating
    # smears the edge row into streaks that the model then animates, and
    # reflecting folded the subject's own shoulder back into frame as a
    # phantom second arm. So the crop is clamped to what exists, and the
    # residual difference is reported rather than hidden.
    side = min(ideal, float(width), float(height))
    x0 = min(max(still_cx - centre_x * side, 0.0), width - side)
    y0 = min(max(still_cy - centre_y * side, 0.0), height - side)

    x0i, y0i, sidei = int(round(x0)), int(round(y0)), int(round(side))
    crop = still_bgr[y0i : y0i + sidei, x0i : x0i + sidei]
    if crop.size == 0:
        raise RuntimeError("reference crop came out empty")
    interpolation = cv2.INTER_AREA if sidei > target else cv2.INTER_LANCZOS4
    return cv2.resize(crop, (target, target), interpolation=interpolation), {
        "idle_face_fraction": round(face_fraction, 4),
        "still_face_fraction": round(still_face / float(height), 4),
        "crop_side": sidei,
        "scale": round(target / float(sidei), 3),
        "face_zoom": round(face_zoom, 3),
        # How much bigger the face ended up than in the clip. Roughly
        # (face_zoom - 1) x 100 when the crop fits, and more when it hit the
        # edge of the still and could not be widened any further. Large values
        # read as a push-in the moment she starts talking; the cure for an
        # unwanted one is a reference still framed wider, not anything this can
        # paper over.
        "achieved_face_fraction": round(still_face / float(sidei), 4),
        "framing_error_pct": round(100.0 * (still_face / float(sidei) / face_fraction - 1.0), 1),
        "face_px": int(round(still_face * target / float(sidei))),
    }


def _encode(frame_rgb):
    frame = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
    if frame.shape[0] > STREAM_MAX_HEIGHT:
        scale = STREAM_MAX_HEIGHT / float(frame.shape[0])
        frame = cv2.resize(
            frame,
            (int(round(frame.shape[1] * scale)), STREAM_MAX_HEIGHT),
            interpolation=cv2.INTER_AREA,
        )
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buffer.tobytes()


class Avatar:
    """One prepared character.

    `video_path` is the reference *still*, not a clip - the model generates from
    a single image. `idle_video` is the clip the panel loops between turns, and
    is used only to work out how the still should be framed.
    """

    def __init__(self, state, avatar_id, video_path, bbox_shift=0, idle_video="", face_zoom=None):
        self.state = state
        self.avatar_id = avatar_id
        self.video_path = video_path
        self.bbox_shift = bbox_shift
        self.idle_video = idle_video
        self.face_zoom = DEFAULT_FACE_ZOOM if face_zoom is None else float(face_zoom)

        root = os.path.join(state.args.cache_dir, avatar_id)
        self.root = root
        self.reference_path = os.path.join(root, "reference.png")
        self.info_path = os.path.join(root, "info.json")

        self.idle_frames = 0
        self.geometry = {}
        self._audio = None
        self._pending = np.zeros(0, dtype=np.float32)

    # ---------- lifecycle ----------

    def describe(self):
        return {
            "avatar_id": self.avatar_id,
            "video_path": self.video_path,
            "idle_video": self.idle_video,
            "bbox_shift": self.bbox_shift,
            "frames": self.cycle_length(),
            "prepared": self.is_cached(),
            "backend": "flashhead",
            "geometry": self.geometry,
        }

    def is_cached(self):
        return os.path.exists(self.reference_path) and os.path.exists(self.info_path)

    def _cache_matches_source(self):
        try:
            with open(self.info_path, "r", encoding="utf-8") as handle:
                info = json.load(handle)
        except Exception:
            return False

        def same(a, b):
            return os.path.normcase(os.path.normpath(a or "")) == os.path.normcase(
                os.path.normpath(b or "")
            )

        # The framing constant counts as a source: pressing "prepare" after it
        # changes has to actually rebuild, or the avatar keeps the old crop and
        # the setting looks like it did nothing.
        cached_zoom = (info.get("geometry") or {}).get("face_zoom", 1.0)
        return (
            info.get("backend") == "flashhead"
            and same(info.get("video_path", ""), self.video_path)
            and same(info.get("idle_video", ""), self.idle_video)
            and abs(float(cached_zoom) - self.face_zoom) < 1e-6
        )

    def prepare(self, force=False):
        if self.is_cached() and not force and self._cache_matches_source():
            self.load()
            return

        still = _imread(self.video_path)
        if still is None:
            raise RuntimeError("could not read reference image: %s" % self.video_path)

        target = int(self.state.infer_params.get("height", TARGET_SIZE))
        if self.idle_video and os.path.exists(self.idle_video):
            idle_frame, idle_count = _first_frame_and_count(self.idle_video)
            reference, geometry = _aligned_reference(still, idle_frame, target, self.face_zoom)
        else:
            # No clip to match: fall back to the model's own face crop, which
            # frames tightly and gives the face the most pixels.
            from flash_head.utils.facecrop import process_image

            pil = process_image(self.video_path, face_ratio=2.0, target_size=(target, target))
            reference = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
            idle_count = 0
            geometry = {
                "idle_face_fraction": None,
                "crop_side": None,
                "scale": None,
                # Nothing to align to, so nothing was zoomed relative to it.
                "face_zoom": 1.0,
            }

        # Build beside the existing cache and swap at the end: a failure part
        # way through must not leave the avatar unusable.
        staging = self.root + ".staging"
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging, exist_ok=True)
        _imwrite(os.path.join(staging, "reference.png"), reference)
        info = {
            "backend": "flashhead",
            "video_path": self.video_path,
            "idle_video": self.idle_video,
            "bbox_shift": self.bbox_shift,
            "idle_frames": idle_count,
            "geometry": geometry,
        }
        with open(os.path.join(staging, "info.json"), "w", encoding="utf-8") as handle:
            json.dump(info, handle, indent=2)

        shutil.rmtree(self.root, ignore_errors=True)
        os.replace(staging, self.root)
        self.load()

    def load(self):
        with open(self.info_path, "r", encoding="utf-8") as handle:
            info = json.load(handle)
        self.idle_frames = int(info.get("idle_frames", 0))
        self.geometry = info.get("geometry", {})
        if not self.video_path:
            self.video_path = info.get("video_path", "")
        if not self.idle_video:
            self.idle_video = info.get("idle_video", "")

    def cycle_length(self):
        """Length of the panel's idle loop, in frames.

        The panel plays the clip forwards then backwards, and maps the number of
        generated frames back onto that cycle to decide where to resume the
        video. It needs the same number the other backend reports, which is the
        ping-pong length rather than the clip length.
        """
        return self.idle_frames * 2 if self.idle_frames else 0

    # ---------- inference ----------

    def _arm(self):
        """Point the pipeline at this avatar and reset its motion state."""
        pipeline = self.state.pipeline
        params = self.state.infer_params
        pipeline.prepare_params(
            cond_image_path_or_dir=self.reference_path.replace("\\", "/"),
            target_size=(params["height"], params["width"]),
            frame_num=params["frame_num"],
            motion_frames_num=params["motion_frames_num"],
            sampling_steps=params["sample_steps"],
            seed=42,
            shift=params["sample_shift"],
            color_correction_strength=params["color_correction_strength"],
            # The still is already framed to match the idle clip; letting the
            # model crop again would undo exactly that.
            use_face_crop=False,
        )
        cached = params["sample_rate"] * params["cached_audio_duration"]
        self._audio = deque([0.0] * cached, maxlen=cached)
        self._pending = np.zeros(0, dtype=np.float32)
        self.state.active_avatar = self.avatar_id

    def begin_turn(self):
        """Called when a reply starts, so every turn opens on the same pose.

        Without this the pipeline would carry motion state across the gap during
        which the panel was showing the looping clip, and the first generated
        frame would not line up with what the viewer is looking at.
        """
        self._arm()

    def frames_for_audio(self, pcm_int16, start_index=0):
        if self.state.pipeline is None:
            raise RuntimeError("avatar %s is not prepared" % self.avatar_id)
        if self.state.active_avatar != self.avatar_id or self._audio is None:
            self._arm()

        from flash_head.inference import get_audio_embedding, run_pipeline

        params = self.state.infer_params
        fps = params["tgt_fps"]
        frame_num = params["frame_num"]
        motion = params["motion_frames_num"]
        slice_len = frame_num - motion
        slice_samples = slice_len * params["sample_rate"] // fps

        audio = np.asarray(pcm_int16, dtype=np.float32) / 32768.0
        if audio.size:
            self._pending = np.concatenate([self._pending, audio])

        audio_end = params["cached_audio_duration"] * fps
        audio_start = audio_end - frame_num

        frames = []
        # The model only generates in whole slices; whatever is left over waits
        # for the next chunk rather than being padded, which would insert
        # silence into the middle of a sentence.
        while self._pending.size >= slice_samples:
            piece = self._pending[:slice_samples]
            self._pending = self._pending[slice_samples:]
            self._audio.extend(piece.tolist())
            embedding = get_audio_embedding(
                self.state.pipeline, np.array(self._audio), audio_start, audio_end
            )
            video = run_pipeline(self.state.pipeline, embedding)[motion:]
            generated = video.cpu().numpy().astype(np.uint8)
            for i in range(generated.shape[0]):
                frames.append(_encode(generated[i]))
        return frames

    def flush_tail(self):
        """Generate the last partial slice, padded, at the end of a reply."""
        if self._audio is None or self._pending.size == 0:
            return []
        params = self.state.infer_params
        slice_len = params["frame_num"] - params["motion_frames_num"]
        slice_samples = slice_len * params["sample_rate"] // params["tgt_fps"]
        spoken = self._pending.size
        self._pending = np.pad(self._pending, (0, slice_samples - spoken))
        frames = self.frames_for_audio(np.zeros(0, dtype=np.int16))
        # Drop frames that only cover the padding: they would move her mouth
        # after the audio has finished.
        wanted = max(1, int(round(spoken * params["tgt_fps"] / float(params["sample_rate"]))))
        return frames[:wanted]
