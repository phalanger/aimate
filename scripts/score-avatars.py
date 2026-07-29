"""Score candidate images or clips for use as a lip-sync avatar.

It runs each candidate through the real pipeline - prepare, then generate from
a short speech clip - and compares the generated mouth against the source.
Static measurements were tried first and were not predictive: a candidate whose
lip-versus-skin colour gap looked as bad as a known failure came out fine, and
the only thing that separated them was generating and looking. So this pays the
GPU time instead of guessing.

Four things are measured, and each is something that was actually seen going
wrong:

    colour   whether the lips keep their colour. The mouth is repainted from
             context that has the mouth masked out, so a colour the model
             cannot infer from the surrounding skin is one it will not
             reproduce - strong lipstick disappears.
    fit      how the detected face compares with the model's 256 px working
             size. Much smaller wastes it; much larger means its output is
             upscaled back.
    detail   how much of the mouth's fine texture survives - lip lines,
             highlights, the edge of the lip. The model paints a smooth
             plausible mouth, so this is always a loss; what the number says is
             how much there was to lose. Rendering the source larger does not
             help: the model works at 256 px however big the input was, and the
             same texture disappears at every source size tried.
    motion   how much the mouth actually moves across the generated frames. A
             face that will not animate scores well on the other two and is
             still useless. Note this is not comparable between a still and a
             clip: with a clip the head moves too, so the crop shifts and the
             number comes out higher for reasons that have nothing to do with
             lip sync.

The ranking is a shortlist, not a verdict. Differences that are obvious side by
side can still come out small in the number - that happened twice, and the
side-by-side settled it in a second each time. Hence the contact sheet, and
hence the closing line telling you to look at it.

    python scripts\\score-avatars.py <file-or-directory> [...]

Runs under the musetalk environment.
"""

import argparse
import glob
import os
import shutil
import sys
import tempfile
import types

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.join(ROOT, "runtime", "musetalk")
sys.path.insert(0, REPO)
sys.path.insert(0, os.path.join(ROOT, "services", "lipsync"))

CACHE = os.path.join(ROOT, "var", "cache-lipsync")
REPORT_DIR = os.path.join(ROOT, "var", "avatar-scores")
PROBE_PREFIX = "_score_"
MODEL_CROP = 256
CLIP_SECONDS = 2.0
IMAGE_TYPES = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
VIDEO_TYPES = (".mp4", ".webm", ".mov", ".mkv", ".avi")


def collect(paths):
    """Resolve everything to absolute paths up front.

    The MuseTalk import needs the repo as the working directory, so the
    process chdirs into it before any of this runs - and anything given
    relative to where the command was typed would stop resolving.
    """
    found = []
    for path in paths:
        path = os.path.abspath(path)
        if os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                if name.lower().endswith(IMAGE_TYPES + VIDEO_TYPES):
                    found.append(os.path.join(path, name))
        elif os.path.isfile(path):
            found.append(path)
    return found


def safe_copy(path, folder):
    """Stage the candidate under a name OpenCV will handle.

    Two reasons. cv2.VideoCapture reads "shot_00034_.png" as a pattern with a
    frame number in it and finds nothing, which looks exactly like an
    unreadable file. And it cannot open every format Pillow can, so anything
    it does not read natively is converted to PNG first.
    """
    extension = os.path.splitext(path)[1].lower()
    if extension in VIDEO_TYPES:
        target = os.path.join(folder, "candidate" + extension)
        shutil.copyfile(path, target)
        return target.replace("\\", "/")

    image = cv2.imread(path, cv2.IMREAD_COLOR)
    if image is None:
        # webp and friends: let Pillow decode, then hand OpenCV a PNG.
        from PIL import Image

        with Image.open(path) as opened:
            rgb = opened.convert("RGB")
            image = cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
    target = os.path.join(folder, "candidate.png")
    cv2.imwrite(target, image)
    return target.replace("\\", "/")


def ascii_label(name):
    """Something cv2's Hershey fonts can actually draw."""
    stem = os.path.splitext(name)[0]
    cleaned = "".join(c if 32 <= ord(c) < 127 else "" for c in stem).strip()
    return cleaned or "(non-ascii name)"


def mouth_region(face):
    h, w = face.shape[:2]
    return face[int(h * 0.55) :, int(w * 0.18) : int(w * 0.82)]


def lip_chroma(mouth):
    """Mean a/b of the reddest fifth of the region - the lips, not the skin."""
    lab = cv2.cvtColor(mouth, cv2.COLOR_BGR2LAB)
    a = lab[..., 1].astype(float)
    b = lab[..., 2].astype(float)
    threshold = np.percentile(a, 80)
    mask = a >= threshold
    if not mask.any():
        return float(a.mean()), float(b.mean())
    return float(a[mask].mean()), float(b[mask].mean())


def score_colour(distance):
    # Calibrated against the two known outcomes: the footage whose lipstick was
    # lost sat far out, the one that kept its colour sat close to zero.
    return max(0.0, 100.0 * np.exp(-distance / 6.0))


def score_fit(face_px):
    # Perfect when the detected face is already the model's working size; the
    # penalty is on the ratio, so half and double are equally wrong.
    if face_px <= 0:
        return 0.0
    octaves = abs(np.log2(face_px / float(MODEL_CROP)))
    return max(0.0, 100.0 * np.exp(-octaves))


def score_detail(src_mouth, gen_mouth):
    """Fraction of the mouth's local contrast that survives generation.

    Compared at the same pixel size, or the larger image would win on having
    more pixels rather than more detail.
    """
    target = (gen_mouth.shape[1], gen_mouth.shape[0])
    reference = cv2.resize(src_mouth, target, interpolation=cv2.INTER_AREA)

    def variance(img):
        return cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()

    before = variance(reference)
    if before <= 1e-6:
        return 0.0
    return max(0.0, min(100.0, 100.0 * variance(gen_mouth) / before))


def score_motion(frames):
    """Mean absolute change between consecutive mouth crops, as a percentage."""
    if len(frames) < 2:
        return 0.0
    diffs = []
    for a, b in zip(frames, frames[1:]):
        diffs.append(np.abs(a.astype(float) - b.astype(float)).mean())
    movement = float(np.mean(diffs))
    # About 6 grey levels of average change per frame is lively; below ~1 the
    # mouth is barely moving.
    return max(0.0, min(100.0, movement / 6.0 * 100.0))


def load_speech(state_rate=16000):
    import soundfile as sf

    for name in sorted(glob.glob(os.path.join(ROOT, "assets", "voices", "*.wav"))):
        audio, rate = sf.read(name, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if rate != state_rate:
            index = (np.arange(int(len(audio) * state_rate / rate)) * rate / state_rate).astype(int)
            audio = audio[np.clip(index, 0, len(audio) - 1)]
        if len(audio) >= state_rate:
            clip = audio[: int(state_rate * CLIP_SECONDS)]
            return (clip * 32767).astype(np.int16), name
    raise SystemExit("no reference audio found in assets/voices")


def evaluate(state, Avatar, path, pcm, workdir):
    from avatar import Avatar as _  # noqa: F401  (import shape check)

    avatar_id = PROBE_PREFIX + "probe"
    shutil.rmtree(os.path.join(CACHE, avatar_id), ignore_errors=True)
    source = safe_copy(path, workdir)

    avatar = Avatar(state, avatar_id, source, 0)
    try:
        avatar.prepare(force=True)
    except Exception as exc:
        return {"error": str(exc)[:80]}

    jpegs = avatar.frames_for_audio(pcm, start_index=0)
    if not jpegs:
        shutil.rmtree(os.path.join(CACHE, avatar_id), ignore_errors=True)
        return {"error": "no frames generated"}

    frame = avatar.frame_cycle[0]
    x1, y1, x2, y2 = avatar.coord_cycle[0]
    src_face = frame[y1:y2, x1:x2]
    face_px = y2 - y1

    mouths = []
    native = []
    for jpeg in jpegs:
        image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        # The stream is downscaled, so the box from the full frame has to be
        # scaled with it or the crop lands somewhere else entirely.
        ratio = image.shape[0] / float(frame.shape[0])
        gx1, gy1, gx2, gy2 = (int(round(v * ratio)) for v in (x1, y1, x2, y2))
        face = image[gy1:gy2, gx1:gx2]
        if face.size == 0:
            continue
        # Kept at the size it is actually streamed at, for measuring detail.
        native.append(mouth_region(face))
        # And scaled to the source for everything that compares frames against
        # each other or against the source.
        face = cv2.resize(face, (src_face.shape[1], src_face.shape[0]), interpolation=cv2.INTER_LANCZOS4)
        mouths.append(mouth_region(face))

    shutil.rmtree(os.path.join(CACHE, avatar_id), ignore_errors=True)
    if not mouths:
        return {"error": "could not crop the generated face"}

    src_mouth = mouth_region(src_face)
    sa, sb = lip_chroma(src_mouth)
    # Take the middle of the clip; the first frames are still opening.
    gen_mouth = mouths[len(mouths) // 2]
    ga, gb = lip_chroma(gen_mouth)
    distance = float(np.hypot(ga - sa, gb - sb))

    colour = score_colour(distance)
    fit = score_fit(face_px)
    # Measured at the streamed size, not the source's. Blowing the generated
    # mouth back up to a 400px source and comparing there marks a candidate
    # down for detail at a resolution that never reaches the screen - which is
    # what this did at first, and it made large faces look far worse than they
    # are.
    detail = score_detail(src_mouth, native[len(native) // 2])
    motion = score_motion(mouths)
    # Colour is weighted hardest because it is the failure that prompted this,
    # and the one that cannot be fixed after the fact. Detail counts for less
    # because every candidate loses some and no setting brings it back - it is
    # here to say how much, not to separate good from bad.
    overall = 0.45 * colour + 0.2 * fit + 0.2 * detail + 0.15 * motion

    return {
        "frame": frame.shape[1::-1],
        "face_px": face_px,
        "face_fraction": face_px / float(frame.shape[0]),
        "lip_shift": distance,
        "colour": colour,
        "fit": fit,
        "detail": detail,
        "motion": motion,
        "overall": overall,
        "src_mouth": src_mouth,
        "gen_mouth": gen_mouth,
    }


def main():
    parser = argparse.ArgumentParser(description="Score avatar candidates by generating from them.")
    parser.add_argument("paths", nargs="+", help="images, clips, or directories of them")
    parser.add_argument("--out", default=REPORT_DIR, help="where to write the contact sheet")
    args = parser.parse_args()

    candidates = collect(args.paths)
    if not candidates:
        raise SystemExit("nothing to score")

    # Imported here so the usage message does not cost a model load.
    os.chdir(REPO)
    import service as svc
    from avatar import Avatar

    state = types.SimpleNamespace(
        args=types.SimpleNamespace(
            version="v15",
            unet_model_path=os.path.join(REPO, "models/musetalkV15/unet.pth"),
            unet_config=os.path.join(REPO, "models/musetalkV15/musetalk.json"),
            vae_type="sd-vae",
            whisper_dir=os.path.join(REPO, "models/whisper"),
            cache_dir=CACHE,
            fps=25,
            batch_size=8,
            extra_margin=10,
        )
    )
    svc.load_models(state)
    pcm, clip = load_speech()
    print("scoring %d candidate(s) against %s\n" % (len(candidates), os.path.basename(clip)))

    workdir = tempfile.mkdtemp(prefix="avatar-score-")
    results = []
    try:
        for path in candidates:
            name = os.path.basename(path)
            sys.stdout.write("  %-40s " % name[:40])
            sys.stdout.flush()
            try:
                result = evaluate(state, Avatar, path, pcm, workdir)
            except Exception as exc:
                # One unreadable candidate should not end the run; the point is
                # to compare a batch.
                result = {"error": "%s: %s" % (type(exc).__name__, str(exc)[:60])}
            result["name"] = name
            result["path"] = path
            results.append(result)
            print(result.get("error") or "ok")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        for leftover in glob.glob(os.path.join(CACHE, PROBE_PREFIX + "*")):
            shutil.rmtree(leftover, ignore_errors=True)

    good = [r for r in results if "error" not in r]
    good.sort(key=lambda r: r["overall"], reverse=True)

    print("\n%-30s %6s %7s %5s %7s %7s %9s %8s"
          % ("candidate", "score", "colour", "fit", "detail", "motion", "lip shift", "face px"))
    print("-" * 100)
    for rank, r in enumerate(good, 1):
        print("%2d. %-26s %6.0f %7.0f %5.0f %7.0f %7.0f %9.1f %8d"
              % (rank, r["name"][:26], r["overall"], r["colour"], r["fit"],
                 r["detail"], r["motion"], r["lip_shift"], r["face_px"]))
    for r in results:
        if "error" in r:
            print("%-34s   %s" % (r["name"][:34], r["error"]))

    if good:
        os.makedirs(args.out, exist_ok=True)
        cell = (300, 190)
        rows = []
        for rank, r in enumerate(good, 1):
            pair = np.hstack([cv2.resize(r["src_mouth"], cell), cv2.resize(r["gen_mouth"], cell)])
            # cv2 draws Hershey fonts only, so anything outside ASCII comes out
            # as question marks - which is most of the filename for a Chinese
            # one. Numbering the rows keeps them identifiable against the table.
            label = "%d. %s" % (rank, ascii_label(r["name"]))
            cv2.putText(pair, "%s  %.0f" % (label[:30], r["overall"]), (8, 22),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
            cv2.putText(pair, "source", (8, cell[1] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
            cv2.putText(pair, "generated", (cell[0] + 8, cell[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
            rows.append(pair)
        sheet = os.path.join(args.out, "contact-sheet.png")
        cv2.imwrite(sheet, np.vstack(rows))
        print("\ncontact sheet: %s" % sheet)
        print("Look at it. The numbers rank; the pictures decide.")


if __name__ == "__main__":
    main()
