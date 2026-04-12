#!/bin/bash
# pickko-verify.js 자동 실행 래퍼
# launchd (ai.ska.pickko-verify) 에서 호출
#
# 동작:
#   1. 중복 실행 방지 (락 파일)
#   2. MODE=ops 로 pickko-verify.js 실행
#   3. pending/failed 없으면 브라우저 미실행 조기 종료 (스크립트 자체 처리)
#   4. 로그 → /tmp/pickko-verify.log (최근 500줄 유지)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/opt/homebrew/bin/node"
RUNTIME_SCRIPT="/Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/admin/pickko-verify.js"
LOCK_FILE="$HOME/.openclaw/workspace/pickko-verify.lock"
LOG_FILE="/tmp/pickko-verify.log"

TS() { date '+%Y-%m-%d %H:%M:%S'; }

# ── 중복 실행 방지 ──────────────────────────────────────
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(TS)] ⚠️  pickko-verify 이미 실행 중 (PID: $OLD_PID) → 건너뜀" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

# ── 실행 (네트워크 오류 시 최대 3회 재시도, 5분 간격) ──────
echo "" >> "$LOG_FILE"
echo "[$(TS)] ━━━ pickko-verify 자동 실행 시작 ━━━" | tee -a "$LOG_FILE"

MAX_RETRY=3
RETRY_WAIT=300  # 5분
EXIT_CODE=1

for attempt in $(seq 1 $MAX_RETRY); do
  if [ $attempt -gt 1 ]; then
    echo "[$(TS)] 🔄 pickko-verify 재시도 ${attempt}/${MAX_RETRY} (${RETRY_WAIT}초 대기 후)" | tee -a "$LOG_FILE"
    sleep $RETRY_WAIT
  fi
  MODE=ops "$NODE" "$RUNTIME_SCRIPT" >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    break
  fi
  echo "[$(TS)] ⚠️ pickko-verify 실패 (exit: $EXIT_CODE, 시도: ${attempt}/${MAX_RETRY})" | tee -a "$LOG_FILE"
done

echo "[$(TS)] ━━━ pickko-verify 완료 (exit: $EXIT_CODE) ━━━" | tee -a "$LOG_FILE"

# ── 로그 500줄 유지 ─────────────────────────────────────
if [ -f "$LOG_FILE" ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $EXIT_CODE
