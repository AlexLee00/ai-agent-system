#!/bin/bash
set -euo pipefail

COMFYUI_HOME="${COMFYUI_HOME:-/Users/alexlee/ComfyUI}"
COMFYUI_VENV="${COMFYUI_VENV:-$COMFYUI_HOME/.venv}"
COMFYUI_HOST="${COMFYUI_HOST:-127.0.0.1}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
COMFYUI_MODE="${COMFYUI_MODE:-auto}"

if [ ! -d "$COMFYUI_HOME" ]; then
  echo "[comfyui] missing directory: $COMFYUI_HOME" >&2
  exit 1
fi

if [ ! -x "$COMFYUI_VENV/bin/python" ]; then
  echo "[comfyui] missing python runtime: $COMFYUI_VENV/bin/python" >&2
  exit 1
fi

cd "$COMFYUI_HOME"

ARGS=(main.py --listen "$COMFYUI_HOST" --port "$COMFYUI_PORT")
if [ "$COMFYUI_MODE" = "cpu" ]; then
  ARGS+=(--cpu)
fi

exec "$COMFYUI_VENV/bin/python" "${ARGS[@]}"
