#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT_DIR="$ROOT_DIR/output/claude-hooks"
mkdir -p "$OUT_DIR"

payload="$(cat || true)"
printf '{"ts":"%s","hook":"notification-github-issue-update","mode":"audit_only","mutatesGithub":false,"payloadBytes":%s}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "${#payload}" >> "$OUT_DIR/notifications.jsonl"

exit 0
