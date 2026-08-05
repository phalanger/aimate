#!/usr/bin/env bash
# Detached launcher for the CPU voice bridge, mirroring how the panel itself
# is started on this box (setsid, logs to var/logs/voice.log). The panel's
# error hint already points users at that log; this makes it real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/runtime/python/voice_cpu/bin/python"
LOG_DIR="$ROOT/var/logs"

if [ ! -x "$PY" ]; then
  echo "venv missing: $PY" >&2
  echo "create it with:" >&2
  echo "  python3.11 -m venv \"$ROOT/runtime/python/voice_cpu\"" >&2
  echo "  \"$ROOT/runtime/python/voice_cpu/bin/pip\" install -r \"$ROOT/services/voice_cpu/requirements.txt\"" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

# faster-whisper pulls its model from huggingface.co, which is slow or blocked
# from the China network this box is on (it talks to GLM). The mirror makes the
# first-run download actually finish; harmless elsewhere. Override by exporting
# HF_ENDPOINT before launching.
export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

# Refuse to fight another process already on the port.
if ss -tlnH 2>/dev/null | awk '{print $4}' | grep -q ":8765$"; then
  echo "port 8765 already in use:" >&2
  ss -tlnp 2>/dev/null | grep ':8765' >&2 || true
  echo "stop it first (e.g. docker stop bricks-lab-web, or kill the holder)" >&2
  exit 1
fi

setsid "$PY" "$ROOT/services/voice_cpu/server.py" \
  --host 0.0.0.0 --port 8765 \
  > "$LOG_DIR/voice.log" 2>&1 < /dev/null &

echo "voice_cpu started (pid $!), logging to var/logs/voice.log"
echo "tail with: tail -f \"$LOG_DIR/voice.log\""
