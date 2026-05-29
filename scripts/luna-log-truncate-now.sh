#!/bin/bash
# OPS 맥스튜디오에서 실행 — 디스크 긴급 회복 (inode 유지 truncate, 최근 5000줄 보존)
set -euo pipefail

KEEP="${1:-5000}"

for f in \
  /tmp/investment-runtime-autopilot.log \
  /tmp/ai.luna.ops-scheduler.out.log \
  /tmp/ai.luna.tradingview-ws.log \
  /tmp/ai.luna.tradingview-ws.err.log \
  /tmp/ai.luna.marketdata-mcp.err.log \
  /tmp/ai.luna.ops-scheduler.err.log \
  /tmp/investment-runtime-autopilot.err.log; do
  if [ -f "$f" ]; then
    SIZE=$(stat -f%z "$f" 2>/dev/null || echo 0)
    tail -n "$KEEP" "$f" > "$f.keep" && cat "$f.keep" > "$f" && rm -f "$f.keep"
    NEW_SIZE=$(stat -f%z "$f" 2>/dev/null || echo 0)
    echo "truncated: $f  ${SIZE}B → ${NEW_SIZE}B"
  fi
done

echo ""
df -h /System/Volumes/Data
