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


_FACE_MESH = None
_FACE_MESH_TRIED = False


def face_mesh():
    """Landmark model, used only to tell an open mouth from a closed one.

    Separate from the detector above because that one reports six keypoints
    with a single point for the mouth, which cannot express whether it is
    open. Returns None if the model is unavailable, and the caller then says
    the mouth was not checked rather than assuming it was fine.
    """
    global _FACE_MESH, _FACE_MESH_TRIED
    if not _FACE_MESH_TRIED:
        _FACE_MESH_TRIED = True
        try:
            import mediapipe as mp

            _FACE_MESH = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True, max_num_faces=1, refine_landmarks=False
            )
        except Exception:
            _FACE_MESH = None
    return _FACE_MESH


# Face mesh landmark indices: the inner lip centres and the mouth corners.
LIP_TOP, LIP_BOTTOM, LIP_LEFT, LIP_RIGHT = 13, 14, 61, 291


def _mouth_openness(frame_bgr):
    """Lip separation over mouth width, or None if it could not be measured.

    Scale free, so it means the same on any clip: a closed mouth sits near
    zero and a wide open one well above 0.2.
    """
    mesh = face_mesh()
    if mesh is None:
        return None
    result = mesh.process(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))
    if not result.multi_face_landmarks:
        return None
    points = result.multi_face_landmarks[0].landmark
    height, width = frame_bgr.shape[:2]

    def at(index):
        return (points[index].x * width, points[index].y * height)

    top, bottom = at(LIP_TOP), at(LIP_BOTTOM)
    left, right = at(LIP_LEFT), at(LIP_RIGHT)
    span = ((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2) ** 0.5
    if span <= 0:
        return None
    gap = ((top[0] - bottom[0]) ** 2 + (top[1] - bottom[1]) ** 2) ** 0.5
    return gap / span


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


# How many frames to look at when picking a reference still. Evenly spaced
# across the clip rather than consecutive, so a slow head turn is sampled at
# several angles instead of forty times at one.
STILL_SCAN_FRAMES = 48

# A candidate's face must be at least this fraction of the largest face found.
# In a static shot nothing is dropped; this is aimed at clips where the subject
# moves towards or away from the camera.
STILL_MIN_FACE_RATIO = 0.9

# Of the frames that survive the size filter, keep this fraction - the most
# front-on ones - before choosing on sharpness.
STILL_FRONTAL_KEEP = 0.5

# Lip separation, as a fraction of mouth width, at or below which the mouth
# counts as closed. Frames at or under this are preferred outright; if none
# qualify - a clip of someone talking throughout - the most closed half is
# kept instead, and the chosen frame's value is reported either way.
STILL_MOUTH_CLOSED = 0.08
STILL_MOUTH_KEEP = 0.5


def _face_candidates(frame_bgr):
    """One face's box and eye keypoints, or None.

    Returns (box, left_eye, right_eye) with the eyes possibly None: the shared
    CPUFaceHandler wrapper hands back boxes and scores only, so the keypoints
    come from the mediapipe result underneath it. That is a private detail of
    a checkout we pin, so it is reached for defensively - and when it is not
    there, the caller is told rather than quietly scored as perfectly frontal.
    """
    height, width = frame_bgr.shape[:2]
    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

    detector = getattr(face_detector(), "detector", None)
    if detector is None:
        boxes, _ = face_detector()(rgb)
        if len(boxes) != 1:
            return None
        x1, y1, x2, y2 = boxes[0][:4]
        return ((x1 * width, y1 * height, x2 * width, y2 * height), None, None)

    detections = detector.process(rgb).detections
    if not detections or len(detections) != 1:
        return None
    data = detections[0].location_data
    relative = data.relative_bounding_box
    box = (
        relative.xmin * width,
        relative.ymin * height,
        (relative.xmin + relative.width) * width,
        (relative.ymin + relative.height) * height,
    )
    points = list(getattr(data, "relative_keypoints", []) or [])
    if len(points) < 3:
        return (box, None, None)
    # mediapipe's face detector orders these right eye, left eye, nose tip.
    eyes = [(points[0].x * width, points[0].y * height), (points[1].x * width, points[1].y * height)]
    nose = (points[2].x * width, points[2].y * height)
    return (box, eyes, nose)


def _asymmetry(eyes, nose):
    """How far off front-on the face is, 0 being square to the camera.

    The two eye-to-nose distances are equal on a front-on face and diverge as
    the head turns. Divided by the distance between the eyes so the number
    means the same thing at any face size.
    """
    (lx, ly), (rx, ry) = eyes
    left = ((lx - nose[0]) ** 2 + (ly - nose[1]) ** 2) ** 0.5
    right = ((rx - nose[0]) ** 2 + (ry - nose[1]) ** 2) ** 0.5
    interocular = ((lx - rx) ** 2 + (ly - ry) ** 2) ** 0.5
    if interocular <= 0:
        return None
    return abs(left - right) / interocular


# Fraction of the face box, from the top, that the sharpness measure looks at.
# Enough for brows and eyes, stopping above the mouth.
SHARPNESS_UPPER_FACE = 0.55


def _sharpness(frame_bgr, box):
    """Laplacian variance over the upper face - brows and eyes, not the mouth.

    Comparable here and only here: every candidate is a frame of one clip, at
    one resolution, cropped to the same feature. The same measure taken across
    images that have been scaled differently says nothing, which it has already
    been used to do wrongly once - see docs/05-lipsync-spike.md.

    The mouth is excluded because including it does not measure sharpness, it
    measures how open the mouth is. Teeth, tongue and the lip line are all
    high-contrast edges that appear when the mouth opens, so on the whole face
    box this reliably picked the frame where the subject was mid-vowel - two
    of three clips here, one of them with the tongue out. Blur affects the
    whole frame, so the upper half answers the intended question without
    answering that one too.
    """
    height, width = frame_bgr.shape[:2]
    x1, y1, x2, y2 = box
    x1 = max(0, int(x1))
    y1 = max(0, int(y1))
    x2 = min(width, int(x2))
    y2 = min(height, int(y2))
    y2 = y1 + max(1, int((y2 - y1) * SHARPNESS_UPPER_FACE))
    if x2 - x1 < 8 or y2 - y1 < 8:
        return 0.0
    crop = cv2.cvtColor(frame_bgr[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(crop, cv2.CV_64F).var())


def pick_reference_frame(video_path, out_path, scan=STILL_SCAN_FRAMES):
    """Choose a frame of the idle clip to serve as the reference still.

    Only ever a fallback for a still nobody supplied. A photograph taken for
    the purpose is usually far better - measured on this project's own
    characters, two of three had roughly twice the face pixels of anything
    their clip could offer - so this never replaces one that is set.

    Candidates are filtered rather than scored, in this order: exactly one
    face, a face within STILL_MIN_FACE_RATIO of the largest seen, the more
    front-on half, then the sharpest of what is left. Filters instead of
    weights because the weights would be invented and the filters can be
    explained.

    Writes the chosen frame and returns what it chose and why, so the panel can
    show it. Whether the mouth is open in that frame is not considered - this
    detector exposes a single mouth point, and the effect has not been
    measured; the file is written for the user to look at and replace.
    """
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError("could not open video: %s" % video_path)
    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    if total > 0:
        indices = sorted(set(int(round(i)) for i in np.linspace(0, total - 1, min(scan, total))))
        frames = []
        for index in indices:
            capture.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, frame = capture.read()
            if ok:
                frames.append((index, frame))
    else:
        # Some containers do not report a frame count. Read straight through
        # and keep every nth, so this still works rather than reporting no
        # candidates on a clip that plays perfectly well.
        frames = []
        index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if index % 5 == 0:
                frames.append((index, frame))
            index += 1
        total = index
    capture.release()

    if not frames:
        raise RuntimeError("could not read any frame from %s" % video_path)

    candidates = []
    for index, frame in frames:
        found = _face_candidates(frame)
        if found is None:
            continue
        box, eyes, nose = found
        candidates.append(
            {
                "index": index,
                "frame": frame,
                "box": box,
                "face_px": box[3] - box[1],
                "asymmetry": _asymmetry(eyes, nose) if eyes and nose else None,
                "mouth": _mouth_openness(frame),
            }
        )

    if not candidates:
        raise RuntimeError(
            "no frame of %s has exactly one detectable face (looked at %d)"
            % (video_path, len(frames))
        )

    largest = max(c["face_px"] for c in candidates)
    kept = [c for c in candidates if c["face_px"] >= largest * STILL_MIN_FACE_RATIO]

    measured = [c for c in kept if c["asymmetry"] is not None]
    frontal_used = len(measured) == len(kept) and len(kept) > 1
    if frontal_used:
        measured.sort(key=lambda c: c["asymmetry"])
        kept = measured[: max(1, int(len(measured) * STILL_FRONTAL_KEEP))]

    # A reference still says what this face looks like, so a frame caught
    # mid-vowel is a poor one to hand the model. Whether it actually degrades
    # the result is untested; preferring a closed mouth costs nothing either
    # way, and the value that was chosen is reported so it can be judged.
    mouths = [c for c in kept if c["mouth"] is not None]
    mouth_used = len(mouths) == len(kept) and len(kept) > 1
    if mouth_used:
        closed = [c for c in mouths if c["mouth"] <= STILL_MOUTH_CLOSED]
        if closed:
            kept = closed
        else:
            mouths.sort(key=lambda c: c["mouth"])
            kept = mouths[: max(1, int(len(mouths) * STILL_MOUTH_KEEP))]

    for candidate in kept:
        candidate["sharpness"] = _sharpness(candidate["frame"], candidate["box"])
    best = max(kept, key=lambda c: c["sharpness"])

    directory = os.path.dirname(out_path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory)
    _imwrite(out_path, best["frame"])

    height, width = best["frame"].shape[:2]
    return {
        "path": out_path.replace("\\", "/"),
        "frame_index": best["index"],
        "frames_total": total,
        "frames_scanned": len(frames),
        "candidates": len(candidates),
        "width": width,
        "height": height,
        "face_px": round(best["face_px"], 1),
        # What the crop needs at this zoom. Below 1.0 the reference is being
        # enlarged to fill 512, so the detail in the mouth is invented.
        "detail_ratio": round(best["face_px"] / (TARGET_SIZE / DEFAULT_FACE_ZOOM), 2),
        "frontal_filter": frontal_used,
        "mouth_filter": mouth_used,
        "mouth_open": None if best["mouth"] is None else round(best["mouth"], 3),
    }


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
        # Where that crop was taken from. Recorded so a generated frame can be
        # put back where it came from - the reference is a window onto the
        # still, and without the window's origin there is no way to say which
        # part of the original it replaces.
        "crop_x": x0i,
        "crop_y": y0i,
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
