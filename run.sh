#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtualenv…"
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  ./.venv/bin/pip install -r requirements.txt
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "WARNING: ffmpeg not found. macOS: brew install ffmpeg · Windows/Linux: see README"
fi

export PYTHONUNBUFFERED=1
cd backend
exec ../.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 "$@"
