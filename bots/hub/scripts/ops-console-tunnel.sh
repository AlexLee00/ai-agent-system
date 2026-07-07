#!/usr/bin/env bash
set -euo pipefail

PORT="${OPS_CONSOLE_PORT:-4090}"

# Quick tunnel. Use a named Cloudflare Tunnel for a stable production origin.
exec cloudflared tunnel --url "http://127.0.0.1:${PORT}" --protocol http2 --no-autoupdate
