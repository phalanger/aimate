#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_ROOT="$ROOT/runtime/python"
WITH_MUSETALK=0
MIRROR=0
SKIP_LIPSYNC=0
INSTALL_CURATED_AVATARS=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--with-musetalk] [--mirror] [--skip-lipsync]

Install mate for Linux/WSL:
  - Python 3.11 env for panel + voice pipeline
  - Python 3.10 env for FlashHead lip sync
  - CUDA PyTorch wheels
  - FlashHead and Qwen3-TTS weights
  - first-run config files
  - ~30 curated CC0 VRM avatars (~92 MB) - OPT IN with --curated-avatars

EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-musetalk) WITH_MUSETALK=1 ;;
    --mirror) MIRROR=1 ;;
    --skip-lipsync) SKIP_LIPSYNC=1 ;;
    --curated-avatars) INSTALL_CURATED_AVATARS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

if [[ $MIRROR -eq 1 ]]; then
  export HF_ENDPOINT="https://hf-mirror.com"
fi
export HF_HUB_ETAG_TIMEOUT="${HF_HUB_ETAG_TIMEOUT:-60}"
export HF_HUB_DOWNLOAD_TIMEOUT="${HF_HUB_DOWNLOAD_TIMEOUT:-60}"

step_no=0
step_total=7
if [[ $SKIP_LIPSYNC -eq 1 ]]; then step_total=7; else step_total=8; fi
if [[ $WITH_MUSETALK -eq 1 ]]; then step_total=$((step_total + 1)); fi
if [[ "${INSTALL_CURATED_AVATARS:-0}" == "1" ]]; then step_total=$((step_total + 1)); fi

step() {
  step_no=$((step_no + 1))
  printf '\n[%d/%d] %s\n' "$step_no" "$step_total" "$1"
}

note() { printf '      %s\n' "$1"; }
skip() { printf '      %s\n' "$1"; }
fail() { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 not found"
}

venv_python() {
  local name="$1"
  printf '%s/runtime/python/%s/bin/python' "$ROOT" "$name"
}

pip_install_requirements() {
  local py="$1"
  local req="$2"
  local tmp
  tmp="$(mktemp)"
  grep -Ev '^(triton-windows|win32_setctime)(==|$)' "$req" > "$tmp"
  "$py" -m pip install --disable-pip-version-check --quiet -r "$tmp"
  rm -f "$tmp"
}

create_env() {
  local name="$1"
  local python_version="$2"
  local torch_index="$3"
  shift 3
  local target="$PYTHON_ROOT/$name"
  local py
  py="$(venv_python "$name")"
  local stamp="$target/.mate-installed"

  if [[ -f "$stamp" ]]; then
    skip "$name: already installed"
    return
  fi

  if [[ ! -x "$py" ]]; then
    note "$name: creating Python $python_version environment"
    uv venv --seed --python "$python_version" "$target"
  fi

  note "$name: upgrading pip tooling"
  if ! "$py" -m pip --version >/dev/null 2>&1; then
    uv pip install --python "$py" --quiet pip setuptools wheel
  fi
  "$py" -m pip install --disable-pip-version-check --quiet --upgrade pip setuptools wheel

  note "$name: installing torch from $torch_index"
  "$py" -m pip install --disable-pip-version-check --quiet \
    --index-url "https://download.pytorch.org/whl/$torch_index" "$@"

  note "$name: installing requirements"
  pip_install_requirements "$py" "$ROOT/requirements/$name.txt"
  touch "$stamp"
}

clone_repo() {
  local url="$1"
  local target="$2"
  local label="$3"
  if [[ -d "$target/.git" ]]; then
    skip "$label already cloned"
    return
  fi
  note "Cloning $label"
  git clone --depth 1 "$url" "$target"
}

hf_model() {
  local repo="$1"
  local target="$2"
  local label="$3"
  local marker="${4:-config.json}"
  if [[ -f "$target/$marker" ]]; then
    skip "$label already downloaded"
    return
  fi
  note "Downloading $label from HuggingFace"
  mkdir -p "$target"
  "$(venv_python flashhead)" -m huggingface_hub.commands.huggingface_cli download "$repo" --local-dir "$target"
}

download_zip() {
  local url="$1"
  local target="$2"
  local label="$3"
  if [[ -f "$target" ]]; then
    skip "$label already downloaded"
    return
  fi
  note "Downloading $label"
  mkdir -p "$(dirname "$target")"
  curl -fL --retry 5 --retry-delay 2 --connect-timeout 20 -o "$target" "$url"
}

download_curated_avatars() {
  local manifest="$ROOT/config/curated-avatars.json"
  local base="$ROOT/assets/models/curated"
  if [[ ! -f "$manifest" ]]; then
    skip "curated manifest not found (config/curated-avatars.json)"
    return
  fi
  mkdir -p "$base"
  # Bash has no JSON parser; Python does, and the s2s env is already a hard
  # dependency of this script. Each entry pulls two files: the VRM model and
  # its thumbnail, so the gallery grid never reaches a third-party CDN. One
  # failed download is logged and skipped rather than aborting the install -
  # the gallery still lists anything that did land here, and re-running picks
  # up the misses.
  "$S2S_PY" - "$manifest" "$base" <<'PY'
import json, os, subprocess, sys
manifest, base = sys.argv[1], sys.argv[2]
entries = json.load(open(manifest, encoding="utf-8")).get("entries", [])
total = len(entries)
thumb_dir = os.path.join(base, "thumbnails")
os.makedirs(thumb_dir, exist_ok=True)

def fetch(url, target, label, i):
    if os.path.exists(target) and os.path.getsize(target) > 0:
        print("      [%d/%d] skip %s (already downloaded)" % (i, total, label))
        return
    print("      [%d/%d] downloading %s" % (i, total, label))
    try:
        subprocess.run(
            ["curl", "-fL", "--retry", "5", "--retry-delay", "2",
             "--connect-timeout", "20", "-o", target, url],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        print("      WARN: %s failed (curl exit %s); skipping" % (label, exc.returncode))
        if os.path.exists(target):
            os.remove(target)

for i, entry in enumerate(entries, 1):
    fetch(entry["model_url"],
          os.path.join(base, os.path.basename(entry["file"])),
          os.path.basename(entry["file"]), i)
    # Thumbnail is optional: a missing one just shows the placeholder, and an
    # entry with no thumbnail (or no source URL) is skipped silently.
    thumb_rel = entry.get("thumbnail") or ""
    if thumb_rel and entry.get("thumbnail_url"):
        fetch(entry["thumbnail_url"],
              os.path.join(thumb_dir, os.path.basename(thumb_rel)),
              "thumbnail " + os.path.basename(entry["file"]), i)
PY
}

install_runtime_resources() {
  local nltk_dir="$PYTHON_ROOT/s2s/nltk_data"
  local downloads="$ROOT/runtime/downloads"
  local torch_hub
  torch_hub="$("$S2S_PY" - <<'PY'
import torch
print(torch.hub.get_dir())
PY
)"

  mkdir -p "$nltk_dir/tokenizers" "$nltk_dir/taggers" "$downloads" "$torch_hub"

  if [[ -d "$nltk_dir/tokenizers/punkt_tab" ]]; then
    skip "NLTK punkt_tab already installed"
  else
    download_zip "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/tokenizers/punkt_tab.zip" "$downloads/punkt_tab.zip" "NLTK punkt_tab"
    unzip -q -o "$downloads/punkt_tab.zip" -d "$nltk_dir/tokenizers"
  fi

  if [[ -d "$nltk_dir/taggers/averaged_perceptron_tagger_eng" ]]; then
    skip "NLTK averaged_perceptron_tagger_eng already installed"
  else
    download_zip "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/taggers/averaged_perceptron_tagger_eng.zip" "$downloads/averaged_perceptron_tagger_eng.zip" "NLTK averaged_perceptron_tagger_eng"
    unzip -q -o "$downloads/averaged_perceptron_tagger_eng.zip" -d "$nltk_dir/taggers"
  fi
  # speech-to-speech checks the tagger under tokenizers/ during import, while
  # NLTK itself expects it under taggers/. Satisfy both without duplicating it.
  ln -sfn ../taggers/averaged_perceptron_tagger_eng "$nltk_dir/tokenizers/averaged_perceptron_tagger_eng"

  if [[ -d "$torch_hub/snakers4_silero-vad_master" ]]; then
    skip "silero-vad torch hub cache already installed"
  else
    download_zip "https://github.com/snakers4/silero-vad/archive/refs/heads/master.zip" "$downloads/silero-vad-master.zip" "silero-vad"
    local temp="$downloads/silero-vad"
    rm -rf "$temp"
    mkdir -p "$temp"
    unzip -q -o "$downloads/silero-vad-master.zip" -d "$temp"
    rm -rf "$torch_hub/snakers4_silero-vad_master"
    mv "$temp"/silero-vad-master "$torch_hub/snakers4_silero-vad_master"
    rm -rf "$temp"
  fi

  if "$S2S_PY" - <<'PY' >/dev/null 2>&1
from huggingface_hub import snapshot_download
snapshot_download("openai/whisper-large-v3-turbo", local_files_only=True)
PY
  then
    skip "Whisper large-v3-turbo already cached"
  else
    note "Downloading Whisper large-v3-turbo from HuggingFace"
    env -u HF_ENDPOINT "$S2S_PY" -m huggingface_hub.commands.huggingface_cli download openai/whisper-large-v3-turbo
  fi
}

step "Checking prerequisites"
require_cmd uv
require_cmd git
require_cmd curl
require_cmd unzip
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | sed 's/^/      GPU: /'
else
  note "nvidia-smi not found; CUDA runtime will fail until the NVIDIA WSL driver is visible."
fi
if command -v ffmpeg >/dev/null 2>&1 && [[ "$(ffmpeg -hide_banner -encoders 2>/dev/null)" == *libx264* ]]; then
  skip "ffmpeg with libx264 found"
else
  fail "Install ffmpeg with libx264 first, e.g. sudo apt install ffmpeg"
fi

step "Building Python environments"
mkdir -p "$PYTHON_ROOT"
create_env s2s 3.11 cu128 torch==2.9.1+cu128 torchaudio==2.9.1+cu128
if [[ $SKIP_LIPSYNC -eq 1 ]]; then
  skip "flashhead: skipped"
else
  create_env flashhead 3.10 cu128 torch==2.7.1+cu128 torchvision==0.22.1+cu128
fi
if [[ $WITH_MUSETALK -eq 1 ]]; then
  create_env musetalk 3.10 cu118 torch==2.0.1+cu118 torchvision==0.15.2+cu118 torchaudio==2.0.2+cu118
fi
S2S_PY="$(venv_python s2s)"

if [[ $SKIP_LIPSYNC -eq 1 ]]; then
  note "Skipping FlashHead weights. Start with --skip lipsync until they are installed."
else
  step "Lip-sync model (FlashHead, about 8.3 GB)"
  FLASH_ROOT="$ROOT/runtime/flashhead"
  clone_repo "https://github.com/Soul-AILab/SoulX-FlashHead.git" "$FLASH_ROOT" "SoulX-FlashHead"
  hf_model "Soul-AILab/SoulX-FlashHead-1_3B" "$FLASH_ROOT/models/SoulX-FlashHead-1_3B" "FlashHead weights" "Model_Lite/diffusion_pytorch_model.safetensors"
  hf_model "facebook/wav2vec2-base-960h" "$FLASH_ROOT/models/wav2vec2-base-960h" "wav2vec2" "pytorch_model.bin"
fi

step "Speech synthesis model (Qwen3-TTS-Base, about 4.2 GB)"
TTS_DIR="$ROOT/runtime/models/qwen3-tts-base"
if [[ -f "$TTS_DIR/model.safetensors" ]]; then
  skip "Qwen3-TTS already downloaded"
else
  note "Installing ModelScope client"
  "$S2S_PY" -m pip install --disable-pip-version-check --quiet modelscope
  note "Downloading Qwen3-TTS-Base"
  "$S2S_PY" -m modelscope.cli.cli download --model "Qwen/Qwen3-TTS-12Hz-1.7B-Base" --local_dir "$TTS_DIR"
fi

if [[ $WITH_MUSETALK -eq 1 ]]; then
  step "Lip-sync model, old backend (MuseTalk)"
  MUSE_ROOT="$ROOT/runtime/musetalk"
  clone_repo "https://github.com/TMElyralab/MuseTalk.git" "$MUSE_ROOT" "MuseTalk"
  if [[ -d "$MUSE_ROOT/models/musetalkV15" ]]; then
    skip "MuseTalk weights already downloaded"
  else
    note "Run MuseTalk's downloader manually from $MUSE_ROOT if you need this backend."
  fi
fi

step "First-launch runtime resources"
install_runtime_resources

step "ffmpeg and Live2D"
mkdir -p "$ROOT/runtime/bin"
ln -sf "$(command -v ffmpeg)" "$ROOT/runtime/bin/ffmpeg"
ln -sf "$(command -v ffprobe)" "$ROOT/runtime/bin/ffprobe" 2>/dev/null || true
CUBISM="$ROOT/web/vendor/live2d/live2dcubismcore.min.js"
if [[ -f "$CUBISM" ]]; then
  skip "Live2D Cubism Core already present"
else
  if curl -fsSL "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js" -o "$CUBISM"; then
    note "Downloaded Live2D Cubism Core"
  else
    note "Live2D Cubism Core download failed; only Live2D display mode is affected."
    rm -f "$CUBISM"
  fi
fi

step "First-run configuration"
DEFAULT_VOICE="$ROOT/assets/voices/default.wav"
if [[ -f "$DEFAULT_VOICE" ]]; then
  skip "reference clip already present"
else
  BUNDLED="$("$S2S_PY" - <<'PY'
from pathlib import Path
import speech_to_speech
root = Path(speech_to_speech.__file__).resolve().parent
print(root / "TTS" / "ref_audio.wav")
PY
)"
  if [[ -f "$BUNDLED" ]]; then
    mkdir -p "$(dirname "$DEFAULT_VOICE")"
    cp "$BUNDLED" "$DEFAULT_VOICE"
    note "Took the sample clip from the speech_to_speech package"
  else
    note "No reference clip found. Record one in Settings -> Voice library."
  fi
fi

for name in characters voices providers settings avatars; do
  live="$ROOT/config/$name.json"
  template="$ROOT/config/$name.example.json"
  if [[ -f "$live" ]]; then
    skip "config/$name.json already exists, left alone"
  elif [[ -f "$template" ]]; then
    cp "$template" "$live"
    note "Created config/$name.json"
  fi
done

if [[ "${INSTALL_CURATED_AVATARS:-0}" != "1" ]]; then
  skip "Curated VRM avatars: opt-in with --curated-avatars (or INSTALL_CURATED_AVATARS=1) for the ~92 MB CC0 pack"
else
  step "Curated VRM avatars (about 92 MB)"
  download_curated_avatars
fi

step "Smoke checks"
"$S2S_PY" - <<'PY'
import torch
print("s2s torch", torch.__version__, "cuda", torch.cuda.is_available())
if torch.cuda.is_available():
    print(torch.cuda.get_device_name(0))
PY
if [[ $SKIP_LIPSYNC -eq 0 ]]; then
  "$(venv_python flashhead)" - <<'PY'
import torch
print("flashhead torch", torch.__version__, "cuda", torch.cuda.is_available())
if torch.cuda.is_available():
    print(torch.cuda.get_device_name(0))
PY
fi

cat <<EOF

Done.

Start the panel only:
  runtime/python/s2s/bin/python scripts/supervisor.py --only panel

Start panel + voice, without lip sync:
  runtime/python/s2s/bin/python scripts/supervisor.py --skip lipsync

Start everything:
  runtime/python/s2s/bin/python scripts/supervisor.py

Open:
  http://127.0.0.1:8900/
EOF
