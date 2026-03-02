#!/bin/bash
# pickko-pay-scan.js 자동 실행 래퍼
# launchd (ai.ska.pickko-pay-scan) 에서 호출
#
# 동작:
#   1. 중복 실행 방지 (락 파일)
#   2. 픽코 결제대기 건 전체 일괄 결제완료 처리
#   3. 로그 → /tmp/pickko-pay-scan.log (최근 500줄 유지)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/alexlee/.nvm/versions/node/v24.13.1/bin/node"
LOCK_FILE="$HOME/.openclaw/workspace/pickko-pay-scan.lock"
LOG_FILE="/tmp/pickko-pay-scan.log"

TS() { date '+%Y-%m-%d %H:%M:%S'; }

# ── 중복 실행 방지 ──────────────────────────────────────
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(TS)] ⚠️  pickko-pay-scan 이미 실행 중 (PID: $OLD_PID) → 건너뜀" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

# ── 실행 ────────────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "[$(TS)] ━━━ pickko-pay-scan 자동 실행 시작 ━━━" | tee -a "$LOG_FILE"

"$NODE" "$SCRIPT_DIR/pickko-pay-scan.js" >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

echo "[$(TS)] ━━━ pickko-pay-scan 완료 (exit: $EXIT_CODE) ━━━" | tee -a "$LOG_FILE"

# ── 로그 500줄 유지 ─────────────────────────────────────
if [ -f "$LOG_FILE" ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $EXIT_CODE
