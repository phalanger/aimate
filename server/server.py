"""Server for the companion panel: static files plus a small config API.

Deliberately stdlib-only. The API surface is a handful of endpoints against
local files, so a web framework would add an install step for nothing. Binds
to loopback unless the user opts into LAN access.

Serving over HTTP rather than opening index.html directly matters: ES modules,
fetch() and AudioWorklet.addModule all fail under the file:// origin, and
getUserMedia needs a secure context, which 127.0.0.1 counts as. That last
point is also why the desktop shell points its webview at this server rather
than bundling the page - see docs/04-packaging.md.

Three directories, separated by what an update does to them:

    web/      the page and its modules      replaced on update
    config/   characters, settings, keys    never touched
    assets/   VRM, Live2D, video, voices    never touched

web/ is the document root; assets/models and assets/media are mounted under
/assets/ so the browser can still fetch them.

Endpoints
    GET  /api/characters          read characters.json
    PUT  /api/characters          write characters.json (keeps one backup)
    GET  /api/voices              list reference audio files
    POST /api/voices?name=&start=&duration=
                                  upload audio, normalise it for Qwen3-TTS
    GET  /api/voicepacks          the saved voices, plus the cloning mode the
                                  pipeline is configured for
    POST /api/transcribe?file=    transcribe a reference clip for ref_text
    POST /api/musetalk/still      pick a reference still out of the idle clip
    POST /api/record              mux a recorded reply into recordings/
"""

import argparse
import functools
import json
import os
import re
import shutil
import subprocess
import sys
import time
import http.server
import socketserver
import urllib.error
import urllib.parse
import urllib.request

import llm_router

DEFAULT_PORT = 8900
DEFAULT_HOST = "127.0.0.1"

# Separate process, separate interpreter - see services/lipsync/.
MUSETALK_URL = "http://127.0.0.1:8930"

LOOPBACK = "127.0.0.1"
ALL_INTERFACES = "0.0.0.0"


def sync_settings_from_template(config_dir):
    """Create or top up the live settings file from the tracked template.

    settings.json is not tracked, because the panel writes the user's values
    back into it - every slider moved would otherwise show up as a change to a
    repository file, and the value shipped for the cloud proxy was one
    machine's loopback address.

    Untracking a file the UI renders itself from would normally mean that a
    setting added later never reaches anyone who already has a copy: their file
    simply lacks the entry and the control never appears. So the template is
    merged in on every start. Anything present in the template and missing
    locally is added; anything already local is left exactly as it is,
    including its value. Nothing is ever removed, so a stale entry from an
    older version survives an upgrade rather than being silently dropped.

    Called before the first read of settings.json, so a fresh clone gets a
    complete file rather than falling back to whatever each reader's defaults
    happen to be - and there are four of those, in three languages.
    """
    template_path = os.path.join(config_dir, "settings.example.json")
    live_path = os.path.join(config_dir, "settings.json")
    if not os.path.exists(template_path):
        return

    try:
        with open(template_path, "r", encoding="utf-8") as handle:
            template = json.load(handle)
    except (OSError, ValueError) as exc:
        print("settings template unreadable, leaving settings alone: %s" % exc)
        return

    if not os.path.exists(live_path):
        with open(live_path, "w", encoding="utf-8") as handle:
            json.dump(template, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print("Created config/settings.json from the template")
        return

    try:
        with open(live_path, "r", encoding="utf-8") as handle:
            live = json.load(handle)
    except (OSError, ValueError) as exc:
        # Someone's edited file that no longer parses. Replacing it would throw
        # away their settings; leaving it alone lets the readers fall back to
        # their defaults and lets them fix the file.
        print("config/settings.json is not valid JSON, not touching it: %s" % exc)
        return

    added = []
    groups = live.setdefault("groups", [])
    by_id = {group.get("id"): group for group in groups}
    for source in template.get("groups", []):
        target = by_id.get(source.get("id"))
        if target is None:
            groups.append(source)
            added.append(source.get("id") + " (group)")
            continue
        items = target.setdefault("items", [])
        known = {item.get("key") for item in items}
        for item in source.get("items", []):
            if item.get("key") not in known:
                items.append(item)
                added.append(item.get("key"))

    # Descriptive text belongs to the template: it is documentation, and a
    # correction to it should reach everyone. Values are the user's; keys are
    # matched above and never overwritten here.
    for key in ("_comment", "_depends", "_links"):
        if key in template:
            live[key] = template[key]

    if not added:
        return
    temp = live_path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(live, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, live_path)
    print("Added %d new setting(s) from the template: %s" % (len(added), ", ".join(added)))


def read_lan_setting(config_dir):
    """Whether the user opted into serving the whole network.

    Defaults to loopback: the panel edits characters, uploads files and
    proxies LLM calls with stored API keys, none of which should become
    reachable by accident.
    """
    path = os.path.join(config_dir, "settings.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        for group in data.get("groups", []):
            for item in group.get("items", []):
                if item.get("key") == "lan_access":
                    return bool(item.get("value"))
    except Exception:
        pass
    return False

# Qwen3-TTS clones from a short clip. Much beyond this and quality drops
# rather than improves, so the upload is trimmed instead of trusted.
TARGET_SAMPLE_RATE = 24000
MAX_CLIP_SECONDS = 15.0
DEFAULT_CLIP_SECONDS = 10.0

# Filenames come from the browser, so they are treated as hostile: anything
# outside this pattern is rejected rather than sanitised, which avoids having
# to reason about traversal tricks at all.
SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,48}$")

EXTRA_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".vrm": "model/gltf-binary",
    ".glb": "model/gltf-binary",
    ".wasm": "application/wasm",
    ".wav": "audio/wav",
}


class PanelError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Paths:
    """Resolved once at startup so handlers never build paths from input.

    The layout separates things by what an update does to them: web/ and
    server/ are replaced wholesale, config/ and assets/ must survive
    untouched, and var/ can be deleted at any time. Keeping the user's
    characters and their VRM models inside the served code directory - which
    is where they used to live - meant an update would take them with it.
    """

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.web = os.path.join(self.root, "web")
        self.config = os.path.join(self.root, "config")
        self.assets = os.path.join(self.root, "assets")
        self.characters = os.path.join(self.config, "characters.json")
        self.providers = os.path.join(self.config, "providers.json")
        self.settings = os.path.join(self.config, "settings.json")
        self.voicepacks = os.path.join(self.config, "voices.json")
        self.voices = os.path.join(self.assets, "voices")
        self.bin = os.path.join(self.root, "runtime", "bin")
        self.services = os.path.join(self.root, "scripts", "services.json")
        self.recordings = os.path.join(self.root, "var", "recordings")
        self.transcribe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "transcribe.py")
        if not os.path.isdir(self.voices):
            os.makedirs(self.voices)


PATHS = None
STORE = None
PYTHON = sys.executable


def find_ffmpeg():
    """Prefer the copy bundled in bin/ so the project stays self-contained.

    Note the bundled binary must be a *static* build. Shared builds are a few
    hundred KB and fail with STATUS_DLL_NOT_FOUND unless their avcodec/avformat
    DLLs happen to be on PATH - which defeats the point of bundling. The one
    that cost an afternoon shipped with Anaconda, since removed from this
    machine, but any package manager's ffmpeg is likely to be the same shape.
    """
    bundled = os.path.join(PATHS.bin, "ffmpeg.exe")
    if os.path.exists(bundled):
        return bundled

    found = shutil.which("ffmpeg")
    if not found:
        raise PanelError(
            500,
            "ffmpeg not found. Put a static build at bin/ffmpeg.exe or install it on PATH.",
        )
    return found


# Lip sync is driven by parameters the model has to declare. A model without
# them loads and animates perfectly well and simply never opens its mouth,
# which is indistinguishable from a broken pipeline unless the list says so.
VRM_VISEMES = ("aa", "ih", "ou", "ee", "oh")
LIVE2D_MOUTH_PARAM = "ParamMouthOpenY"


def read_glb_json(path, limit=32 * 1024 * 1024):
    """Parse just the JSON chunk of a .vrm (a glTF binary).

    Only the header and first chunk are read: these files run to tens of
    megabytes and the answer is in the first few hundred kilobytes.
    """
    import struct

    with open(path, "rb") as handle:
        header = handle.read(12)
        if len(header) < 12 or header[:4] != b"glTF":
            return None
        chunk_header = handle.read(8)
        if len(chunk_header) < 8:
            return None
        length, kind = struct.unpack("<II", chunk_header)
        if kind != 0x4E4F534A or length > limit:
            return None
        return json.loads(handle.read(length).decode("utf-8", "replace"))


def vrm_has_visemes(path):
    try:
        doc = read_glb_json(path)
        if not doc:
            return None
        extensions = doc.get("extensions", {})

        # VRM 1.0
        vrmc = extensions.get("VRMC_vrm")
        if vrmc:
            preset = (vrmc.get("expressions") or {}).get("preset") or {}
            return all(name in preset for name in VRM_VISEMES)

        # VRM 0.x uses single-letter preset names on blend shape groups.
        vrm0 = extensions.get("VRM")
        if vrm0:
            groups = (vrm0.get("blendShapeMaster") or {}).get("blendShapeGroups") or []
            names = {str(g.get("presetName", "")).lower() for g in groups}
            return all(letter in names for letter in ("a", "i", "u", "e", "o"))
    except Exception:
        return None
    return None


def live2d_has_mouth(model3_path):
    """Check the model's display-info file for the mouth parameter."""
    try:
        folder = os.path.dirname(model3_path)
        with open(model3_path, "r", encoding="utf-8") as handle:
            model = json.load(handle)

        display = (model.get("FileReferences") or {}).get("DisplayInfo")
        candidates = []
        if display:
            candidates.append(os.path.join(folder, display))
        for name in sorted(os.listdir(folder)):
            if name.lower().endswith(".cdi3.json"):
                candidates.append(os.path.join(folder, name))

        for candidate in candidates:
            if not os.path.exists(candidate):
                continue
            with open(candidate, "r", encoding="utf-8") as handle:
                info = json.load(handle)
            ids = {p.get("Id") for p in info.get("Parameters", [])}
            return LIVE2D_MOUTH_PARAM in ids
    except Exception:
        return None
    return None


def voice_path(name):
    if not SAFE_NAME.match(name):
        raise PanelError(400, "invalid voice name: letters, digits, _ and - only")
    return os.path.join(PATHS.voices, name + ".wav")


def today():
    import datetime

    return datetime.date.today().isoformat()


def read_characters():
    try:
        with open(PATHS.characters, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def write_characters(data):
    """Save characters.json the way the PUT endpoint does.

    One backup, and a temporary file swapped into place: an interrupted write
    would leave the file truncated, and the panel does not start without it.
    """
    if os.path.exists(PATHS.characters):
        shutil.copyfile(PATHS.characters, PATHS.characters + ".bak")
    temp = PATHS.characters + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(temp, PATHS.characters)


def update_character_transcripts(pack_id, clip_path, was, text):
    """Refresh the copy of a transcript that characters keep beside their voice.

    Matched the same way deletion is: by voice_id, or by clip path for a
    character saved before the library existed and so carrying only the path.
    Returns the labels of the characters that changed.
    """

    def same_file(a, b):
        return bool(a) and bool(b) and os.path.normcase(os.path.normpath(a)) == os.path.normcase(
            os.path.normpath(b)
        )

    data = read_characters()
    characters = data.get("characters")
    if not isinstance(characters, dict):
        return []

    changed = []
    for name, character in characters.items():
        if not isinstance(character, dict):
            continue
        mine = character.get("voice_id") == pack_id or (
            not character.get("voice_id") and same_file(character.get("voice"), clip_path)
        )
        if mine and character.get("ref_text", was) != text:
            character["ref_text"] = text
            changed.append(character.get("label") or name)

    if changed:
        write_characters(data)
    return changed


def new_voicepack_id(existing):
    base = "v-%s" % today().replace("-", "")
    index = 1
    while "%s-%d" % (base, index) in existing:
        index += 1
    return "%s-%d" % (base, index)


def clone_mode():
    """Which cloning mode the voice pipeline is configured for.

    Returns "xvec_only" or "icl". The panel does not choose this - it is a
    flag on the pipeline's command line in scripts/services.json - but it has
    to know, because the two modes disagree about whether a voice needs a
    transcript. Under ICL the reference text is required and a voice without
    one clones badly. Under xvec_only it is not merely less important: the
    library replaces it with an empty string before the model ever sees it
    (faster_qwen3_tts/model.py, the x_vector_only_mode branch), so asking for
    it, and warning when it is missing, would both be lies.

    Anything unreadable counts as ICL. The two failures are not symmetric:
    showing a transcript field that turns out to be unused wastes a little of
    the user's time, while hiding one that turns out to be required leaves
    voices that cannot clone at all.
    """
    try:
        with open(PATHS.services, "r", encoding="utf-8") as handle:
            config = json.load(handle)
        for spec in config.get("services", []):
            if spec.get("id") == "voice":
                if "--qwen3_tts_xvec_only" in spec.get("command", []):
                    return "xvec_only"
                return "icl"
    except Exception:
        pass
    return "icl"


def load_voicepacks():
    """The voice registry, built from the old per-character fields on first run.

    Before this file existed a voice was two fields on every character that
    used it - the clip and its transcript - so the same voice was written out
    once per character and the copies drifted. Migration folds them back
    together by clip path: same file means same voice.

    The old fields are left on the characters. Nothing reads them any more, but
    leaving them means a downgrade still finds a working config.
    """
    try:
        with open(PATHS.voicepacks, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data.get("voices"), dict):
            return data["voices"]
    except Exception:
        pass

    packs = {}
    by_file = {}
    characters = read_characters().get("characters", {})
    for name, character in characters.items():
        path = (character.get("voice") or "").strip()
        if not path:
            continue
        key = os.path.normcase(os.path.normpath(path))
        if key in by_file:
            # A second character on the same clip: keep the transcript that is
            # not empty, otherwise they are the same voice already.
            existing = packs[by_file[key]]
            if not existing.get("ref_text"):
                existing["ref_text"] = (character.get("ref_text") or "").strip()
            continue
        pack_id = "v-%s" % re.sub(r"[^a-zA-Z0-9_-]+", "-", os.path.splitext(os.path.basename(path))[0])
        packs[pack_id] = {
            "label": character.get("label") or name,
            "file": path.replace("\\", "/"),
            "ref_text": (character.get("ref_text") or "").strip(),
            "created": today(),
        }
        by_file[key] = pack_id

    if packs:
        save_voicepacks(packs)
    return packs


def save_voicepacks(packs):
    payload = {
        "_comment": "Voice library. Each entry is a reference clip and the exact transcript of it - cloning needs both, and needs them to match. Characters point at one of these by voice_id.",
        "voices": packs,
    }
    os.makedirs(os.path.dirname(PATHS.voicepacks), exist_ok=True)
    if os.path.exists(PATHS.voicepacks):
        shutil.copyfile(PATHS.voicepacks, PATHS.voicepacks + ".bak")
    temp = PATHS.voicepacks + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(temp, PATHS.voicepacks)


def audio_info(path):
    """Return (duration, sample_rate, channels, subtype).

    Uses soundfile rather than the stdlib wave module: a .wav extension says
    nothing about the contents. The reference clip shipped with
    speech-to-speech, for instance, is MP3 data inside a wav container, which
    wave.open rejects outright.
    """
    try:
        import soundfile as sf

        info = sf.info(path)
        return (
            round(info.duration, 2),
            info.samplerate,
            info.channels,
            info.subtype,
        )
    except Exception:
        return (0.0, 0, 0, "unknown")


def clip_is_normalised(sample_rate, channels, subtype, duration):
    """Whether a clip already matches what Qwen3-TTS wants."""
    return (
        sample_rate >= TARGET_SAMPLE_RATE
        and channels == 1
        and str(subtype).startswith("PCM")
        and 3.0 <= duration <= MAX_CLIP_SECONDS
    )


def convert_audio(source, target, start, duration):
    """Normalise arbitrary uploaded audio into what the TTS expects."""
    ffmpeg = find_ffmpeg()
    duration = max(0.5, min(duration, MAX_CLIP_SECONDS))
    command = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "%.3f" % max(0.0, start),
        "-i",
        source,
        "-t",
        "%.3f" % duration,
        "-ac",
        "1",
        "-ar",
        str(TARGET_SAMPLE_RATE),
        "-sample_fmt",
        "s16",
        target,
    ]
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[:400]
        raise PanelError(400, "ffmpeg failed: " + (detail or "unknown error"))


RECORDING_KEEP_DAYS = 7


def recording_stem(name):
    """A filename for a saved reply that says which character and when.

    The old form was "reply-<stamp>-<id>", where the id was stripped to ASCII -
    so a character called the equivalent of "Ling" showed up as "char1" and a
    Chinese label vanished entirely, leaving files nobody could tell apart.
    Word characters are kept instead of a Latin whitelist, which admits any
    script; the source file stays ASCII because the rule is expressed as a
    class, not as a list of letters.

    Separators are dropped rather than replaced so a name cannot reach out of
    the directory: no dots, no slashes, no colons survive.
    """
    stamp = time.strftime("%Y%m%d-%H%M%S")
    label = re.sub(r"[^\w-]", "", str(name or ""), flags=re.UNICODE)[:24]
    return (label + "-" + stamp) if label else ("reply-" + stamp)


def prune_recordings(days=RECORDING_KEEP_DAYS):
    """Drop saved replies older than the retention window.

    The browser keeps its own copy wherever it was downloaded to, so what is
    left here is a safety net for a download that failed or was cancelled, not
    the library. Left to itself it would grow without limit - these are
    minutes-long H.264 files.

    Runs after a save rather than on a timer: it is the only moment the
    directory is known to be in use, and it costs one listdir.
    """
    cutoff = time.time() - days * 86400
    removed = 0
    try:
        entries = os.listdir(PATHS.recordings)
    except OSError:
        return 0
    for entry in entries:
        path = os.path.join(PATHS.recordings, entry)
        try:
            if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                os.remove(path)
                removed += 1
        except OSError:
            # Being deleted by someone else, or open in a player. Neither is
            # worth failing a save that has already succeeded.
            continue
    return removed


def mux_recording(workdir, source, subtitle_path, mode, crf):
    """Turn the browser's WebM into the container the user asked for.

    The browser can only hand us WebM, and MediaRecorder cannot write a
    subtitle track at all, so the second pass is unavoidable if subtitles are
    wanted. It is also what makes the file play everywhere - VP9 in WebM is
    fine in a browser and awkward in most desktop players.

    ffmpeg runs with its working directory set to the job folder so the ass
    filter can name the script as a bare filename. Filter arguments treat
    both the colon and the backslash as syntax, which makes an absolute
    Windows path ("C:\\...") a parsing problem rather than a path.
    """
    ffmpeg = find_ffmpeg()
    encode = [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", str(crf),
        # x264 defaults to a chroma format most players will not touch.
        "-pix_fmt", "yuv420p",
        # MediaRecorder produces variable frame rate with an arbitrary start
        # time; pinning the output rate keeps players from mistiming it.
        "-r", "25",
        "-c:a", "aac",
        "-b:a", "160k",
    ]

    if mode == "soft":
        output = "out.mkv"
        command = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", source,
            "-i", subtitle_path,
            "-map", "0:v:0",
            # Optional: a recording made with the speaker silent has no audio
            # stream at all, and a hard mapping would fail on it.
            "-map", "0:a:0?",
            "-map", "1:0",
        ] + encode + ["-c:s", "ass", output]
    elif mode == "burn":
        output = "out.mp4"
        command = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", source,
            "-vf", "ass=" + subtitle_path,
        ] + encode + ["-movflags", "+faststart", output]
    else:
        output = "out.mp4"
        command = [
            ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
            "-i", source,
        ] + encode + ["-movflags", "+faststart", output]

    result = subprocess.run(command, capture_output=True, cwd=workdir, timeout=1800)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[-400:]
        raise PanelError(500, "ffmpeg failed: " + (detail or "unknown error"))
    return os.path.join(workdir, output)


def clip_ends_mid_speech(path):
    """Whether a clip stops while someone is still talking, or None if unknown.

    A separate process for the same reason transcription is: this panel is
    stdlib-only, and the check needs soundfile. It does not load a model, so it
    costs about a third of a second rather than the minute transcription takes.

    Returns None rather than raising when the check cannot run. It exists to
    add a warning, and a warning that cannot be produced must not be able to
    block saving a voice.
    """
    try:
        result = subprocess.run(
            [PYTHON, PATHS.transcribe, "--check", path],
            capture_output=True,
            timeout=120,
        )
        if result.returncode != 0:
            return None
        return bool(json.loads(result.stdout.decode("utf-8")).get("ends_mid_speech"))
    except Exception:
        return None


def transcribe_audio(path, language):
    result = subprocess.run(
        [PYTHON, PATHS.transcribe, path, language],
        capture_output=True,
        timeout=600,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()[-400:]
        raise PanelError(500, "transcription failed: " + (detail or "unknown error"))
    return result.stdout.decode("utf-8", "replace").strip()


def validate_characters(data):
    if not isinstance(data, dict):
        raise PanelError(400, "payload must be an object")
    characters = data.get("characters")
    if not isinstance(characters, dict) or not characters:
        raise PanelError(400, "characters must be a non-empty object")

    for key, value in characters.items():
        if not isinstance(value, dict):
            raise PanelError(400, "character %s must be an object" % key)
        for field in ("label", "system_prompt"):
            if not value.get(field):
                raise PanelError(400, "character %s is missing %s" % (key, field))

    if data.get("default") not in characters:
        # Rather than reject, point it at something that exists: an unusable
        # default would break the panel on next load.
        data["default"] = sorted(characters)[0]
    return data


class PanelRequestHandler(http.server.SimpleHTTPRequestHandler):
    # ---------- helpers ----------

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, status, message):
        self._send_json({"error": message}, status=status)

    def _read_body(self, limit=64 * 1024 * 1024):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise PanelError(400, "empty body")
        if length > limit:
            raise PanelError(413, "body too large")
        return self.rfile.read(length)

    def _query(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _param(self, name, default=None):
        values = self._query().get(name)
        return values[0] if values else default

    # ---------- routing ----------

    def do_GET(self):
        route = urllib.parse.urlparse(self.path).path
        if route.startswith("/api/"):
            try:
                self._handle_api_get(route)
            except PanelError as exc:
                self._send_error_json(exc.status, exc.message)
            except Exception as exc:
                self._send_error_json(500, str(exc))
            return
        super().do_GET()

    def do_PUT(self):
        try:
            route = urllib.parse.urlparse(self.path).path
            if route == "/api/characters":
                self._put_characters()
            elif route == "/api/llm":
                payload = json.loads(self._read_body().decode("utf-8"))
                STORE.update(payload)
                self._send_json(STORE.public_view())
            elif route == "/api/settings":
                self._put_settings()
            else:
                raise PanelError(404, "unknown endpoint")
        except llm_router.RouterError as exc:
            self._send_error_json(exc.status, exc.message)
        except PanelError as exc:
            self._send_error_json(exc.status, exc.message)
        except Exception as exc:
            self._send_error_json(500, str(exc))

    def do_DELETE(self):
        try:
            route = urllib.parse.urlparse(self.path).path
            if route == "/api/voicepacks":
                self._delete_voicepack()
            else:
                raise PanelError(404, "unknown endpoint")
        except PanelError as exc:
            self._send_error_json(exc.status, exc.message)
        except Exception as exc:
            self._send_error_json(500, str(exc))

    def do_POST(self):
        try:
            route = urllib.parse.urlparse(self.path).path
            if route == "/api/voices":
                self._post_voice()
            elif route == "/api/voicepacks":
                self._post_voicepack()
            elif route == "/api/transcribe":
                self._post_transcribe()
            elif route == "/api/voicepacks/retranscribe":
                self._retranscribe_voicepack()
            elif route == "/v1/chat/completions":
                self._proxy_chat()
            elif route == "/api/musetalk/prepare":
                self._prepare_musetalk()
            elif route == "/api/musetalk/still":
                self._pick_musetalk_still()
            elif route == "/api/record":
                self._post_record()
            else:
                raise PanelError(404, "unknown endpoint")
        except llm_router.RouterError as exc:
            self._send_error_json(exc.status, exc.message)
        except PanelError as exc:
            self._send_error_json(exc.status, exc.message)
        except Exception as exc:
            self._send_error_json(500, str(exc))

    def _proxy_chat(self):
        """The endpoint speech-to-speech points at instead of a provider."""
        body = self._read_body(limit=8 * 1024 * 1024)

        def write_status(status, content_type):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            # The streamed body has no length, so the client must read to
            # close. Saying so explicitly stops an HTTP client from keeping
            # the connection in its pool and reusing one this server has
            # already finished with.
            self.send_header("Connection", "close")
            self.end_headers()

        def write_chunk(chunk):
            self.wfile.write(chunk)
            # Flush per chunk: with streaming enabled the pipeline starts
            # synthesising on the first sentence, so holding data here would
            # add latency to every reply.
            self.wfile.flush()

        llm_router.proxy_chat(STORE, body, write_status, write_chunk)

    # ---------- endpoints ----------

    def _handle_api_get(self, route):
        if route == "/api/characters":
            with open(PATHS.characters, "r", encoding="utf-8") as handle:
                self._send_json(json.load(handle))
        elif route == "/api/voices":
            self._send_json({"voices": self._list_voices()})
        elif route == "/api/voicepacks":
            self._send_json({"voices": self._list_voicepacks(), "clone_mode": clone_mode()})
        elif route == "/api/voice-file":
            self._send_voice_file()
        elif route == "/api/llm":
            self._send_json(STORE.public_view())
        elif route == "/api/assets":
            self._send_json(self._list_assets())
        elif route == "/api/settings":
            with open(PATHS.settings, "r", encoding="utf-8") as handle:
                self._send_json(json.load(handle))
        elif route == "/api/services":
            self._send_json(self._service_status())
        elif route == "/api/musetalk/status":
            self._musetalk_status()
        elif route == "/api/llm/models":
            self._send_json(llm_router.list_models(STORE, self._param("provider")))
        else:
            raise PanelError(404, "unknown endpoint")

    def _send_voice_file(self):
        """Stream a reference clip so the editor can preview it.

        The voices folder sits outside the served directory, so it cannot be
        reached as a static path - and it should not be, since that would also
        expose everything else above the panel folder.
        """
        name = self._param("name")
        if not name:
            raise PanelError(400, "missing name parameter")
        path = voice_path(name)
        if not os.path.exists(path):
            raise PanelError(404, "no such voice: " + name)

        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(size))
        self.end_headers()
        with open(path, "rb") as handle:
            shutil.copyfileobj(handle, self.wfile)

    def _list_assets(self):
        """Everything the character editor can pick from, grouped by kind.

        Scanned rather than typed: a path typed by hand is a path that can be
        wrong, and the failure only shows up as a blank stage later.
        Directories are reported too so the dialog can say where to put files.
        """
        assets = PATHS.assets

        # Reported relative to the project root, so what comes back is exactly
        # the URL the page fetches ("assets/models/x.vrm") and exactly what is
        # stored in characters.json. One string, no translation step.
        def relative(path):
            return "assets/" + os.path.relpath(path, assets).replace("\\", "/")

        def scan(subdir, suffixes):
            root = os.path.join(assets, *subdir.split("/"))
            found = []
            if not os.path.isdir(root):
                return found
            for name in sorted(os.listdir(root)):
                full = os.path.join(root, name)
                if os.path.isfile(full) and name.lower().endswith(suffixes):
                    entry = {
                        "path": relative(full),
                        "name": os.path.splitext(name)[0],
                        "bytes": os.path.getsize(full),
                    }
                    if name.lower().endswith(".vrm"):
                        entry["lipsync"] = vrm_has_visemes(full)
                    found.append(entry)
            return found

        # Live2D models are folders, and the .model3.json is not reliably at
        # the top of one. Official distributions ship the editor sources
        # (.cmo3/.can3, which the browser cannot use) beside a runtime/
        # subfolder holding the files that matter, so the search has to walk
        # down rather than glance at the first level.
        live2d = []
        l2d_root = os.path.join(assets, "models", "live2d")
        if os.path.isdir(l2d_root):
            for name in sorted(os.listdir(l2d_root)):
                folder = os.path.join(l2d_root, name)
                if not os.path.isdir(folder):
                    continue
                found = None
                for current, dirs, files in os.walk(folder):
                    dirs.sort()
                    for entry in sorted(files):
                        if entry.lower().endswith(".model3.json"):
                            found = os.path.join(current, entry)
                            break
                    if found:
                        break
                if found:
                    live2d.append(
                        {
                            "path": relative(found),
                            "name": name,
                            "bytes": os.path.getsize(found),
                            "lipsync": live2d_has_mouth(found),
                        }
                    )

        return {
            "vrm": {"dir": "assets\models\\", "items": scan("models", (".vrm",))},
            "motion": {
                "dir": "assets\models\motions\\",
                "items": scan("models/motions", (".vrma",)),
            },
            "live2d": {"dir": "assets\models\live2d\<model>\\", "items": live2d},
            "video": {
                "dir": "assets\media\\",
                "items": scan("media", (".mp4", ".webm", ".mov", ".mkv")),
            },
            # Stills live beside the clips because they are the same kind of
            # material: the FlashHead backend generates from one image, and its
            # idle loop is the clip next to it.
            "image": {
                "dir": "assets\media\\",
                "items": scan("media", (".png", ".jpg", ".jpeg", ".webp")),
            },
        }

    def _list_voices(self):
        entries = []
        for name in sorted(os.listdir(PATHS.voices)):
            if not name.lower().endswith(".wav"):
                continue
            full = os.path.join(PATHS.voices, name)
            duration, rate, channels, subtype = audio_info(full)
            entries.append(
                {
                    "name": os.path.splitext(name)[0],
                    "path": full.replace("\\", "/"),
                    "duration": duration,
                    "sample_rate": rate,
                    "channels": channels,
                    "subtype": subtype,
                    "normalised": clip_is_normalised(rate, channels, subtype, duration),
                    "bytes": os.path.getsize(full),
                }
            )
        return entries

    def _list_voicepacks(self):
        """The saved voices, each one a clip and the transcript that goes with it.

        Both halves are needed together: cloning conditions on the reference
        speech *and* on what was said in it, so a transcript that belongs to a
        different clip is worse than none. Keeping them as one record is the
        point of this file - stored per character, they drifted apart.
        """
        packs = load_voicepacks()
        out = []
        for pack_id, pack in sorted(packs.items(), key=lambda kv: kv[1].get("label", "")):
            entry = dict(pack)
            entry["id"] = pack_id
            path = pack.get("file", "")
            if path and os.path.exists(path):
                duration, rate, channels, subtype = audio_info(path)
                entry["duration"] = duration
                entry["normalised"] = clip_is_normalised(rate, channels, subtype, duration)
                entry["missing"] = False
            else:
                entry["duration"] = 0
                entry["missing"] = True
            out.append(entry)
        return out

    def _post_voicepack(self):
        try:
            payload = json.loads(self._read_body().decode("utf-8"))
        except ValueError as exc:
            raise PanelError(400, "invalid JSON: %s" % exc)

        label = (payload.get("label") or "").strip()
        path = (payload.get("file") or "").strip()
        if not label:
            raise PanelError(400, "a name is required")
        if not path:
            raise PanelError(400, "a reference clip is required")
        path = os.path.abspath(path)
        if not path.startswith(PATHS.voices + os.sep):
            raise PanelError(400, "the clip must live in assets/voices")
        if not os.path.exists(path):
            raise PanelError(404, "no such clip: " + path)

        packs = load_voicepacks()
        pack_id = (payload.get("id") or "").strip() or new_voicepack_id(packs)

        # Warnings, not refusals. Both of these are usually mistakes and
        # occasionally deliberate, and a voice the panel will not let you save
        # is worse than one it lets you save with a note attached.
        warnings = []
        duplicate = [
            other.get("label")
            for other_id, other in packs.items()
            if other_id != pack_id and (other.get("label") or "").strip() == label
        ]
        if duplicate:
            warnings.append("duplicate_label")
        # The transcript can be typed by hand, and nothing else ever compares
        # it to the audio. A clip that stops mid-phrase almost always means the
        # text claims words the recording does not reach, which is what makes
        # the cloned voice speak the missing tail before every reply.
        if clip_ends_mid_speech(path):
            warnings.append("ends_mid_speech")

        packs[pack_id] = {
            "label": label,
            "file": path.replace("\\", "/"),
            "ref_text": (payload.get("ref_text") or "").strip(),
            "created": packs.get(pack_id, {}).get("created") or today(),
        }
        save_voicepacks(packs)
        self._send_json(
            {"ok": True, "id": pack_id, "warnings": warnings, "voices": self._list_voicepacks()}
        )

    def _retranscribe_voicepack(self):
        """Re-read a saved voice's clip and store what was actually said.

        Needed because transcribing is only otherwise reachable while building
        a new voice, so a voice whose transcript is wrong could only be fixed
        by making it again from the original file - which the user may no
        longer have.

        The whole job runs here rather than as two calls from the browser: the
        clip may get shortened on the way through (see server/transcribe.py),
        and leaving the panel to notice that and write the text back would mean
        a failure between the two steps leaves the pair mismatched, which is
        the exact fault this is here to repair.
        """
        pack_id = self._param("id")
        packs = load_voicepacks()
        if pack_id not in packs:
            raise PanelError(404, "no such voice: %s" % pack_id)

        path = os.path.abspath(packs[pack_id].get("file", ""))
        if not path.startswith(PATHS.voices + os.sep):
            raise PanelError(400, "the clip must live in assets/voices")
        if not os.path.exists(path):
            raise PanelError(404, "the clip is missing: " + path)

        was = packs[pack_id].get("ref_text", "")
        text = transcribe_audio(path, self._param("language", "zh"))
        packs[pack_id]["ref_text"] = text
        save_voicepacks(packs)

        # Characters carry a copy of the transcript, written when the voice was
        # chosen. Nothing reads it at run time - the pipeline is served from
        # voices.json - but leaving stale text sitting next to the right text
        # is how the two drifted apart in the first place.
        updated = update_character_transcripts(pack_id, path, was, text)

        duration, _, _, _ = audio_info(path)
        self._send_json(
            {
                "ok": True,
                "id": pack_id,
                "text": text,
                "duration": duration,
                "characters": updated,
                "voices": self._list_voicepacks(),
            }
        )

    def _delete_voicepack(self):
        pack_id = self._param("id")
        packs = load_voicepacks()
        if pack_id not in packs:
            raise PanelError(404, "no such voice: %s" % pack_id)

        # Refuse rather than leave a character pointing at nothing - the only
        # symptom of that would be the pipeline falling back to some other
        # voice mid-conversation.
        #
        # Matched on the clip path as well as on voice_id: a character saved
        # before the library existed only has the path, and checking just the
        # id let the voice two characters were using be deleted with no warning
        # at all.
        def same_file(a, b):
            return bool(a) and bool(b) and os.path.normcase(os.path.normpath(a)) == os.path.normcase(
                os.path.normpath(b)
            )

        pack_file = packs[pack_id].get("file", "")
        users = [
            character.get("label") or name
            for name, character in read_characters().get("characters", {}).items()
            if character.get("voice_id") == pack_id
            or (not character.get("voice_id") and same_file(character.get("voice"), pack_file))
        ]
        if users:
            raise PanelError(409, "still used by: " + ", ".join(users))

        del packs[pack_id]
        save_voicepacks(packs)
        self._send_json({"ok": True, "voices": self._list_voicepacks()})

    def _put_characters(self):
        try:
            data = json.loads(self._read_body().decode("utf-8"))
        except ValueError as exc:
            raise PanelError(400, "invalid JSON: %s" % exc)

        data = validate_characters(data)

        # One backup is enough to undo a bad edit without turning the folder
        # into a history of every save.
        if os.path.exists(PATHS.characters):
            shutil.copyfile(PATHS.characters, PATHS.characters + ".bak")

        # Write to a temporary file first so an interrupted save cannot leave
        # characters.json truncated - the panel would fail to load on start.
        temp = PATHS.characters + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp, PATHS.characters)

        self._send_json({"ok": True})

    def _post_voice(self):
        name = self._param("name")
        if not name:
            raise PanelError(400, "missing name parameter")
        target = voice_path(name)

        try:
            start = float(self._param("start", "0") or 0)
        except ValueError:
            start = 0.0
        try:
            duration = float(self._param("duration", str(DEFAULT_CLIP_SECONDS)) or DEFAULT_CLIP_SECONDS)
        except ValueError:
            duration = DEFAULT_CLIP_SECONDS
        # Kept so the answer can say what was asked for. convert_audio clamps,
        # and until now it did so without telling anybody.
        requested = duration

        payload = self._read_body()
        # Keep the original container: ffmpeg sniffs the format, and the
        # browser may hand us mp3, m4a, webm or wav.
        upload = os.path.join(PATHS.voices, "." + name + ".upload")
        with open(upload, "wb") as handle:
            handle.write(payload)

        try:
            convert_audio(upload, target, start, duration)
        finally:
            if os.path.exists(upload):
                os.remove(upload)

        duration, rate, channels, subtype = audio_info(target)
        self._send_json(
            {
                "ok": True,
                "name": name,
                "path": target.replace("\\", "/"),
                "duration": duration,
                "sample_rate": rate,
                "channels": channels,
                "subtype": subtype,
                # Said plainly rather than silently applied. A request for 21
                # seconds became 15 with nothing on screen to say so, and the
                # cut that produced landed inside a sentence.
                "clamped_to": MAX_CLIP_SECONDS if requested > MAX_CLIP_SECONDS else None,
                "requested": requested,
                # Cheap, and worth knowing before transcribing rather than
                # after: a cut through the middle of a phrase is what makes the
                # clip and its transcript describe different speech.
                "ends_mid_speech": clip_ends_mid_speech(target),
            }
        )

    def _put_settings(self):
        """Apply value changes only.

        The file is self-describing - labels, ranges and dependencies live
        alongside the values so the UI can render itself - and none of that
        should be writable from the browser. Only known keys get updated, and
        only with a value of the declared type.
        """
        payload = json.loads(self._read_body().decode("utf-8"))
        values = payload.get("values")
        if not isinstance(values, dict):
            raise PanelError(400, "values must be an object")

        with open(PATHS.settings, "r", encoding="utf-8") as handle:
            data = json.load(handle)

        applied = {}
        for group in data.get("groups", []):
            for item in group.get("items", []):
                key = item.get("key")
                if key not in values:
                    continue
                raw = values[key]
                kind = item.get("type")
                if kind == "bool":
                    item["value"] = bool(raw)
                elif kind == "number":
                    try:
                        number = float(raw)
                    except (TypeError, ValueError):
                        raise PanelError(400, "%s must be a number" % key)
                    low = item.get("min")
                    high = item.get("max")
                    if low is not None:
                        number = max(number, float(low))
                    if high is not None:
                        number = min(number, float(high))
                    item["value"] = number
                else:
                    item["value"] = str(raw)
                applied[key] = item["value"]

        temp = PATHS.settings + ".tmp"
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write(chr(10))
        os.replace(temp, PATHS.settings)

        self._send_json({"ok": True, "applied": applied, "settings": data})

    def _service_status(self):
        """Which back ends are listening yet.

        The panel answers within seconds of launch while the voice pipeline
        spends a minute or two putting Whisper and the TTS on the GPU, and the
        window is shown in between. Without this the page offers a Connect
        button during that gap, and pressing it produces a connection error
        that looks like a broken install rather than "not up yet".

        Asked over HTTP rather than by opening a socket and dropping it. Both
        services are asyncio servers, and a connection closed before the server
        has accepted it fails the pending accept - which the proactor answers
        by closing the listening socket outright. The process stays up with the
        models loaded and the port simply disappears, so every later check says
        "not started" about something that already started.

        That is not theoretical. The page polls this every two seconds for the
        whole of startup, which is exactly the window where the race lives, and
        it took the voice pipeline off its port at 117 ms after it opened. An
        HTTP request cannot do it: the server has to accept and answer before
        the client is in a position to close anything.
        """

        def answering(url):
            try:
                # No proxy: this machine sets HTTP_PROXY, and a loopback check
                # sent through it would report every service as down.
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(url, timeout=1.0):
                    return True
            except urllib.error.HTTPError:
                # 404 from the voice pipeline, which serves only a websocket
                # route. Answering at all is the question being asked.
                return True
            except Exception:
                return False

        return {
            "voice": answering("http://127.0.0.1:8765/"),
            "lipsync": answering(MUSETALK_URL + "/health"),
        }

    def _musetalk_status(self):
        """Whether the lip-sync service is up, so the panel can say so."""
        try:
            with urllib.request.urlopen(MUSETALK_URL + "/health", timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))
            self._send_json({"up": True, "health": payload})
        except Exception as exc:
            self._send_json({"up": False, "error": str(exc)})

    def _prepare_musetalk(self):
        """Forward an avatar preparation request to the lip-sync service.

        Proxied rather than called from the browser directly so the panel stays
        the single origin the UI talks to, and so a video path is resolved
        against the panel directory the same way every other asset is.
        """
        payload = json.loads(self._read_body().decode("utf-8"))

        # video_path is the source clip for MuseTalk and the reference still for
        # FlashHead; idle_video is the clip the panel loops between turns, which
        # FlashHead needs so it can frame the still to match it.
        for field in ("video_path", "idle_video"):
            value = payload.get(field, "")
            if not value or os.path.isabs(value):
                continue
            resolved = os.path.abspath(os.path.join(PATHS.root, value))
            # Keep the lookup inside the assets folder: the path comes from the
            # browser and would otherwise reach anywhere on disk.
            if not resolved.startswith(PATHS.assets + os.sep):
                raise PanelError(400, field + " must stay inside the assets directory")
            if not os.path.exists(resolved):
                raise PanelError(404, "no such file: " + value)
            payload[field] = resolved.replace("\\", "/")

        # How tightly the still is cropped around the face. Checked here
        # because it arrives from a browser: the service would take any number
        # and a silly one produces a crop of a few pixels enlarged to fill the
        # frame, which fails somewhere far less obvious. The upper bound is
        # where a 1024 still stops having pixels to give - past it the crop is
        # being enlarged rather than reduced, so the detail is invented.
        if payload.get("face_zoom") not in (None, ""):
            try:
                zoom = float(payload["face_zoom"])
            except (TypeError, ValueError):
                raise PanelError(400, "face_zoom must be a number")
            if not 1.0 <= zoom <= 2.5:
                raise PanelError(400, "face_zoom must be between 1.0 and 2.5")
            payload["face_zoom"] = zoom
        else:
            payload.pop("face_zoom", None)

        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            MUSETALK_URL + "/prepare",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            # Preparation is minutes of GPU work, so the timeout is generous.
            with urllib.request.urlopen(request, timeout=1800) as response:
                self._send_json(json.loads(response.read().decode("utf-8")))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise PanelError(exc.code, detail)
        except Exception as exc:
            raise PanelError(502, "lip-sync service unreachable: %s" % exc)

    def _pick_musetalk_still(self):
        """Derive a reference still from the idle clip, for characters with none.

        A reference still is required, and leaving it empty did not report
        anything - the prepare button simply did nothing, which is how a
        character ended up configured that way and apparently just broken.

        The panel decides where the file goes; the service only decides which
        frame. Writing it next to the clip under a derived name means it shows
        up in the folder scan like any other asset, so it can be previewed,
        kept, or replaced with a better photograph - which it usually should
        be. A supplied still tends to have far more face pixels than any frame
        of the clip; see docs/05-lipsync-spike.md.
        """
        payload = json.loads(self._read_body().decode("utf-8"))
        idle = payload.get("idle_video", "")
        if not idle:
            raise PanelError(400, "idle_video is required")

        resolved = idle if os.path.isabs(idle) else os.path.abspath(os.path.join(PATHS.root, idle))
        if not resolved.startswith(PATHS.assets + os.sep):
            raise PanelError(400, "idle_video must stay inside the assets directory")
        if not os.path.exists(resolved):
            raise PanelError(404, "no such file: " + idle)

        stem = os.path.splitext(os.path.basename(resolved))[0]
        out_path = os.path.join(os.path.dirname(resolved), stem + "-frame.png")

        body = json.dumps(
            {"idle_video": resolved.replace("\\", "/"), "out_path": out_path.replace("\\", "/")}
        ).encode("utf-8")
        request = urllib.request.Request(
            MUSETALK_URL + "/pick_still",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            # Decoding a few dozen frames and running a CPU face detector over
            # them; seconds, not minutes.
            with urllib.request.urlopen(request, timeout=180) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:400]
            raise PanelError(exc.code, detail)
        except Exception as exc:
            raise PanelError(502, "lip-sync service unreachable: %s" % exc)

        # Hand back the path the browser can use, which is relative to the
        # project root like every other asset in the editor's lists.
        still = data.get("still") or {}
        if still.get("path"):
            still["path"] = os.path.relpath(still["path"], PATHS.root).replace("\\", "/")
        self._send_json(data)

    def _post_record(self):
        """Store a recorded reply, muxing in the subtitle track if asked.

        The video arrives base64-encoded inside the JSON body so that it can
        travel alongside the subtitle text in one request. That costs a third
        more bytes over a loopback connection, which is a good trade against
        hand-rolling multipart parsing on top of the stdlib.
        """
        import base64

        # Comfortably above a base64-encoded minute of the 8 Mbit/s
        # intermediate the browser produces.
        payload = json.loads(self._read_body(limit=256 * 1024 * 1024).decode("utf-8"))

        try:
            video = base64.b64decode(payload.get("video") or "", validate=True)
        except Exception:
            raise PanelError(400, "video must be base64")
        if not video:
            raise PanelError(400, "empty recording")

        mode = payload.get("mode") or "none"
        if mode not in ("soft", "burn", "none"):
            mode = "none"
        subtitle = payload.get("subtitle") or ""
        if not subtitle.strip():
            # Asking for a subtitle track and supplying no cues would produce a
            # file with an empty track, which reads as a bug in the player.
            mode = "none"

        try:
            crf = int(payload.get("crf") or 20)
        except (TypeError, ValueError):
            crf = 20
        crf = max(14, min(crf, 32))

        stem = recording_stem(payload.get("name"))

        if not os.path.isdir(PATHS.recordings):
            os.makedirs(PATHS.recordings)
        workdir = os.path.join(PATHS.recordings, "." + stem)
        os.makedirs(workdir)

        try:
            source = os.path.join(workdir, "in.webm")
            with open(source, "wb") as handle:
                handle.write(video)

            subtitle_path = "sub.ass"
            if mode != "none":
                with open(os.path.join(workdir, subtitle_path), "w", encoding="utf-8") as handle:
                    handle.write(subtitle)

            produced = mux_recording(workdir, "in.webm", subtitle_path, mode, crf)
            target = os.path.join(PATHS.recordings, stem + os.path.splitext(produced)[1])
            os.replace(produced, target)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

        prune_recordings()

        self._send_json(
            {
                "ok": True,
                "path": target,
                "name": os.path.basename(target),
                # Where the browser fetches it from to run its own download.
                "url": "/recordings/" + urllib.parse.quote(os.path.basename(target)),
                "bytes": os.path.getsize(target),
            }
        )

    def _post_transcribe(self):
        name = self._param("file")
        if not name:
            raise PanelError(400, "missing file parameter")
        path = voice_path(name)
        if not os.path.exists(path):
            raise PanelError(404, "no such voice: " + name)
        language = self._param("language", "zh")
        text = transcribe_audio(path, language)
        # Transcribing can shorten the clip: a phrase the cut left unfinished
        # is dropped from both the text and the audio, because the two have to
        # describe the same speech. Report the length back so the panel shows
        # what the reference actually is now.
        duration, _, _, _ = audio_info(path)
        self._send_json({"ok": True, "text": text, "duration": duration})

    # ---------- static ----------

    # The browser reaches two directories: the app itself in web/, and the
    # user's avatar files in assets/. They are separate because an update
    # replaces one and must not touch the other, but the page still has to be
    # able to fetch a VRM over HTTP - hence a second mount rather than keeping
    # the models inside the served code.
    #
    # Only the two subdirectories the page actually loads from are exposed.
    # assets/ also holds the voice samples, which have their own endpoint and
    # no reason to be browsable, especially with LAN access turned on.
    ASSET_MOUNTS = ("models", "media")

    def translate_path(self, path):
        clean = urllib.parse.urlparse(path).path
        # Saved replies are fetched back by the browser so it can run its own
        # download - which is what puts the file where the user wants it, under
        # whatever name, using the Save As dialog they already have. Served
        # read-only and one directory deep; the base implementation's traversal
        # handling is reused rather than reimplemented, same as /assets/.
        recordings = "/recordings/"
        if clean.startswith(recordings):
            saved = self.directory
            try:
                self.directory = PATHS.recordings
                return super().translate_path("/" + clean[len(recordings):])
            finally:
                self.directory = saved
        prefix = "/assets/"
        if clean.startswith(prefix):
            rest = clean[len(prefix):]
            head = rest.split("/", 1)[0]
            if head in self.ASSET_MOUNTS:
                # Resolve through the base implementation against assets/, so
                # its traversal handling still applies rather than being
                # reimplemented here.
                saved = self.directory
                try:
                    self.directory = PATHS.assets
                    return super().translate_path("/" + rest)
                finally:
                    self.directory = saved
            # Anything else under /assets/ is not served at all.
            return os.path.join(PATHS.assets, "__denied__")
        return super().translate_path(path)

    def guess_type(self, path):
        _, ext = os.path.splitext(path)
        override = EXTRA_TYPES.get(ext.lower())
        if override is not None:
            return override
        return super().guess_type(path)

    def end_headers(self):
        # The panel is edited while it runs; caching would hide those edits
        # behind a hard refresh every time.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is noise for a single-user local panel, so only
        # failures are surfaced.
        status = args[1] if len(args) > 1 else ""
        if isinstance(status, str) and status.startswith(("4", "5")):
            sys.stderr.write("%s %s\n" % (self.requestline, status))


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    # Without this a quick restart hits "address already in use" while the old
    # socket sits in TIME_WAIT.
    allow_reuse_address = True
    daemon_threads = True


def main():
    global PATHS, STORE

    parser = argparse.ArgumentParser(description="Serve the companion panel.")
    parser.add_argument(
        "--host",
        default=None,
        help="Bind address. Defaults to the lan_access setting.",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="Project root holding web/, config/ and assets/.",
    )
    args = parser.parse_args()

    PATHS = Paths(args.root)
    STORE = llm_router.ProviderStore(PATHS.providers)

    # Before anything reads settings, including the line below.
    sync_settings_from_template(PATHS.config)

    host = args.host
    if host is None:
        host = ALL_INTERFACES if read_lan_setting(PATHS.config) else LOOPBACK

    # The document root is fixed rather than taken from the process working
    # directory, so where the server was launched from cannot change what it
    # serves.
    handler = functools.partial(PanelRequestHandler, directory=PATHS.web)

    with ReusableTCPServer((host, args.port), handler) as httpd:
        print("Panel serving %s" % PATHS.web)
        print("Assets from   %s" % PATHS.assets)
        print("Config in     %s" % PATHS.config)
        if host == ALL_INTERFACES:
            print("Reachable from the local network on port %d." % args.port)
            print("Anyone who can reach it can edit characters and use your API keys.")
        print("LLM proxy at  http://%s:%d/v1/chat/completions" % (host, args.port))
        print("Open http://%s:%d/" % (host or LOOPBACK, args.port))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nPanel stopped.")


if __name__ == "__main__":
    main()
