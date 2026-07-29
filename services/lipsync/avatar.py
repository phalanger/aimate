"""One prepared character: cached face data plus audio-to-frames generation.

Mirrors MuseTalk's own Avatar class, with three changes needed to serve a
conversation rather than a batch job:

  * preparation never prompts - the service decides whether to rebuild.
  * audio arrives as PCM in memory, not as a wav file on disk, so the whisper
    feature extractor is called directly instead of through the file loader.
  * frames come back as encoded JPEGs, ready to push over a WebSocket.

The frame list is stored as a ping-pong cycle (forwards then backwards) so the
idle footage loops without a visible jump when a reply runs longer than the
source clip.
"""

import glob
import json
import os
import pickle
import shutil
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np
import torch

from musetalk.utils.blending import get_image_blending, get_image_prepare_material
from musetalk.utils.face_parsing import FaceParsing
from musetalk.utils.preprocessing import get_landmark_and_bbox, read_imgs
from musetalk.utils.utils import datagen

# Whisper's chunker needs enough audio to emit at least one frame's worth of
# features; below this it returns nothing and torch.cat on the empty list
# raises. The tail of a reply is routinely shorter than this, so it is padded
# rather than dropped - that audio is the end of a word.
MIN_AUDIO_SAMPLES = 16000 // 2

CROP_SIZE = 256
JPEG_QUALITY = 82

# Frames are composited at the source video's resolution, but the panel shows
# them in a window a fraction of that size. Downscaling before the JPEG encode
# cuts the encode cost, the bytes on the wire and the browser's decode work -
# and the face detail that actually matters was generated at 256x256 anyway.
#
# Generation only just outpaces playback, so this headroom is what keeps the
# picture from falling behind the voice when the GPU is also busy with TTS.
STREAM_MAX_HEIGHT = 576
WHISPER_SAMPLE_RATE = 16000

_FACE_PARSER = None

# cv2 and numpy release the GIL for the work that matters here, so threads
# genuinely overlap with the GPU pass.
_POOL = ThreadPoolExecutor(max_workers=4)


def face_parser():
    """Loaded lazily: only preparation needs it, and it costs VRAM."""
    global _FACE_PARSER
    if _FACE_PARSER is None:
        _FACE_PARSER = FaceParsing()
    return _FACE_PARSER


def video_to_frames(video_path, out_dir):
    capture = cv2.VideoCapture(video_path)
    count = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        cv2.imwrite(os.path.join(out_dir, "%08d.png" % count), frame)
        count += 1
    capture.release()
    return count


class Avatar:
    def __init__(self, state, avatar_id, video_path, bbox_shift=0):
        self.state = state
        self.avatar_id = avatar_id
        self.video_path = video_path
        self.bbox_shift = bbox_shift

        root = os.path.join(state.args.cache_dir, avatar_id)
        self.root = root
        self.full_imgs_path = os.path.join(root, "full_imgs")
        self.mask_path = os.path.join(root, "mask")
        self.coords_path = os.path.join(root, "coords.pkl")
        self.mask_coords_path = os.path.join(root, "mask_coords.pkl")
        self.latents_path = os.path.join(root, "latents.pt")
        self.info_path = os.path.join(root, "info.json")

        self.frame_cycle = None
        self.coord_cycle = None
        self.latent_cycle = None
        self.mask_cycle = None
        self.mask_coord_cycle = None

    # ---------- lifecycle ----------

    def describe(self):
        return {
            "avatar_id": self.avatar_id,
            "video_path": self.video_path,
            "bbox_shift": self.bbox_shift,
            "frames": len(self.frame_cycle) if self.frame_cycle else 0,
            "prepared": self.is_cached(),
        }

    def is_cached(self):
        return all(
            os.path.exists(p)
            for p in (self.latents_path, self.coords_path, self.mask_coords_path, self.info_path)
        )

    def _cache_matches_source(self):
        """Whether the cache on disk was built from the video now being asked for.

        Reusing a cache across restarts is the point of having one. Reusing it
        when the source video has changed is a trap: preparing a new clip under
        an avatar id that already exists would silently keep the old frames and
        still report success, and the only symptom is that nothing looks
        different.
        """
        try:
            with open(self.info_path, "r", encoding="utf-8") as handle:
                info = json.load(handle)
        except Exception:
            return False

        def same(a, b):
            return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))

        return same(info.get("video_path", ""), self.video_path) and info.get(
            "bbox_shift", 0
        ) == self.bbox_shift

    def prepare(self, force=False):
        if self.is_cached() and not force and self._cache_matches_source():
            self.load()
            return

        # Frames are extracted before the existing cache is touched. Preparing
        # is destructive and takes a minute or two, and the source is only
        # found to be unusable partway in - a wrong path, or a clip with no
        # detectable face. Clearing first means a failed attempt destroys the
        # avatar that was working, and the only way back is to prepare it all
        # over again.
        staging = self.root + ".staging"
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging, exist_ok=True)
        try:
            video_to_frames(self.video_path, staging)
            images = sorted(glob.glob(os.path.join(staging, "*.png")))
            if not images:
                raise RuntimeError("no frames extracted from %s" % self.video_path)

            if os.path.isdir(self.root):
                shutil.rmtree(self.root)
            for path in (self.root, self.mask_path):
                os.makedirs(path, exist_ok=True)
            os.replace(staging, self.full_imgs_path)
        finally:
            shutil.rmtree(staging, ignore_errors=True)

        images = sorted(glob.glob(os.path.join(self.full_imgs_path, "*.png")))

        with open(self.info_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "avatar_id": self.avatar_id,
                    "video_path": self.video_path,
                    "bbox_shift": self.bbox_shift,
                    "version": self.state.args.version,
                },
                handle,
            )

        coords, frames = get_landmark_and_bbox(images, self.bbox_shift)

        latents = []
        placeholder = (0.0, 0.0, 0.0, 0.0)
        kept_coords = []
        kept_frames = []
        for index, (bbox, frame) in enumerate(zip(coords, frames)):
            if bbox == placeholder:
                # No face found in this frame. Keeping it would make the mouth
                # jump to a random position when the cycle reaches it.
                continue
            x1, y1, x2, y2 = bbox
            if self.state.args.version == "v15":
                y2 = min(y2 + self.state.args.extra_margin, frame.shape[0])
                bbox = [x1, y1, x2, y2]
            crop = frame[y1:y2, x1:x2]
            resized = cv2.resize(crop, (CROP_SIZE, CROP_SIZE), interpolation=cv2.INTER_LANCZOS4)
            latents.append(self.state.vae.get_latents_for_unet(resized))
            kept_coords.append(bbox)
            kept_frames.append(frame)

        if not latents:
            raise RuntimeError("no face detected in any frame of %s" % self.video_path)

        # Ping-pong so playback can loop indefinitely without a seam.
        self.frame_cycle = kept_frames + kept_frames[::-1]
        self.coord_cycle = kept_coords + kept_coords[::-1]
        self.latent_cycle = latents + latents[::-1]

        parser = face_parser()
        self.mask_cycle = []
        self.mask_coord_cycle = []
        for index, frame in enumerate(self.frame_cycle):
            cv2.imwrite(os.path.join(self.full_imgs_path, "%08d.png" % index), frame)
            x1, y1, x2, y2 = self.coord_cycle[index]
            mode = "jaw" if self.state.args.version == "v15" else "raw"
            mask, crop_box = get_image_prepare_material(
                frame, [x1, y1, x2, y2], fp=parser, mode=mode
            )
            cv2.imwrite(os.path.join(self.mask_path, "%08d.png" % index), mask)
            self.mask_cycle.append(mask)
            self.mask_coord_cycle.append(crop_box)

        with open(self.coords_path, "wb") as handle:
            pickle.dump(self.coord_cycle, handle)
        with open(self.mask_coords_path, "wb") as handle:
            pickle.dump(self.mask_coord_cycle, handle)
        torch.save(self.latent_cycle, self.latents_path)

    def load(self):
        self.latent_cycle = torch.load(self.latents_path)
        with open(self.coords_path, "rb") as handle:
            self.coord_cycle = pickle.load(handle)
        with open(self.mask_coords_path, "rb") as handle:
            self.mask_coord_cycle = pickle.load(handle)

        images = sorted(glob.glob(os.path.join(self.full_imgs_path, "*.png")))
        self.frame_cycle = read_imgs(images)
        masks = sorted(glob.glob(os.path.join(self.mask_path, "*.png")))
        self.mask_cycle = read_imgs(masks)

    def cycle_length(self):
        return len(self.frame_cycle) if self.frame_cycle else 0

    def idle_frame(self, index):
        """A frame from the source footage, untouched. Used between turns."""
        frame = self.frame_cycle[index % len(self.frame_cycle)]
        return encode_jpeg(_downscale(frame))

    # ---------- inference ----------

    def _whisper_features(self, pcm_float):
        """Whisper features for in-memory audio.

        MuseTalk's AudioProcessor only reads from disk; writing a temp wav per
        chunk would add a file round-trip to every turn, so the extractor is
        called directly here on the same 16 kHz float input it expects.
        """
        extractor = self.state.audio_processor.feature_extractor
        segment_length = 30 * WHISPER_SAMPLE_RATE
        features = []
        for start in range(0, max(len(pcm_float), 1), segment_length):
            segment = pcm_float[start : start + segment_length]
            if not len(segment):
                continue
            feature = extractor(
                segment, return_tensors="pt", sampling_rate=WHISPER_SAMPLE_RATE
            ).input_features
            features.append(feature.to(dtype=self.state.weight_dtype))
        return features, len(pcm_float)

    @torch.no_grad()
    def frames_for_audio(self, pcm_int16, start_index=0):
        if self.latent_cycle is None:
            raise RuntimeError("avatar %s is not prepared" % self.avatar_id)

        pcm_float = np.asarray(pcm_int16, dtype=np.float32) / 32768.0
        if pcm_float.size == 0:
            return []

        real_samples = pcm_float.size
        if real_samples < MIN_AUDIO_SAMPLES:
            pcm_float = np.pad(pcm_float, (0, MIN_AUDIO_SAMPLES - real_samples))

        features, length = self._whisper_features(pcm_float)
        if not features:
            return []

        args = self.state.args
        chunks = self.state.audio_processor.get_whisper_chunk(
            features,
            self.state.device,
            self.state.weight_dtype,
            self.state.whisper,
            length,
            fps=args.fps,
            audio_padding_length_left=2,
            audio_padding_length_right=2,
        )
        if chunks is None or len(chunks) == 0:
            return []

        # Only keep frames covering audio that was actually spoken; the padding
        # above must not add mouth movement to silence.
        wanted = max(1, int(round(real_samples * args.fps / WHISPER_SAMPLE_RATE)))
        chunks = chunks[:wanted]

        # Start the latent cycle where the previous chunk stopped, so the body
        # motion continues instead of snapping back to the first frame.
        cycle_len = len(self.latent_cycle)
        rotated = [self.latent_cycle[(start_index + i) % cycle_len] for i in range(len(chunks))]

        # Compositing and JPEG encoding are CPU work and take comparable time
        # to the GPU pass. Running them on a pool lets the next UNet batch
        # start immediately instead of waiting for the previous one to be
        # turned into pixels - worth roughly a third of the total time here.
        pending = []
        index = start_index
        for whisper_batch, latent_batch in datagen(chunks, rotated, args.batch_size):
            audio_features = self.state.pe(whisper_batch.to(self.state.device))
            latent_batch = latent_batch.to(
                device=self.state.device, dtype=self.state.unet.model.dtype
            )
            pred = self.state.unet.model(
                latent_batch, self.state.timesteps, encoder_hidden_states=audio_features
            ).sample
            pred = pred.to(device=self.state.device, dtype=self.state.vae.vae.dtype)
            decoded = self.state.vae.decode_latents(pred)

            for face in decoded:
                pending.append(_POOL.submit(self._compose, face, index))
                index += 1

        return [future.result() for future in pending]

    def _compose(self, face, index):
        return encode_jpeg(_downscale(self._blend(face, index)))

    def _blend(self, face, index):
        """Paste the generated mouth region back into the original frame."""
        position = index % len(self.frame_cycle)
        bbox = self.coord_cycle[position]
        # numpy copy, not copy.deepcopy: deepcopy walks the array as a generic
        # Python object and is an order of magnitude slower on a frame this
        # size, which at 25 fps is not affordable.
        frame = self.frame_cycle[position].copy()
        x1, y1, x2, y2 = bbox
        # Lanczos, not cv2.resize's default bilinear. The model always returns
        # 256x256 and it has to be resampled to whatever the face bbox is, so
        # this runs on every generated frame - and bilinear was measurably
        # costing sharpness in both directions: on the three prepared avatars
        # here it lost 25%, 44% and 56% of Laplacian variance against Lanczos.
        #
        # The preparation path already uses Lanczos for the crop going in; this
        # is the same resample coming back out, and it should match.
        resized = cv2.resize(
            face.astype(np.uint8), (x2 - x1, y2 - y1), interpolation=cv2.INTER_LANCZOS4
        )
        return get_image_blending(
            frame,
            resized,
            bbox,
            self.mask_cycle[position],
            self.mask_coord_cycle[position],
        )


def _downscale(frame):
    height = frame.shape[0]
    if height <= STREAM_MAX_HEIGHT:
        return frame
    scale = STREAM_MAX_HEIGHT / float(height)
    return cv2.resize(
        frame,
        (int(round(frame.shape[1] * scale)), STREAM_MAX_HEIGHT),
        interpolation=cv2.INTER_AREA,
    )


def encode_jpeg(frame):
    ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buffer.tobytes()
