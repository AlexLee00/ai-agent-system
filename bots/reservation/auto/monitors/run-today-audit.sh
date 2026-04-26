#!/bin/bash
# pickko-kiosk-monitor.js --audit-today 자동 실행 래퍼 (launchd)
# - 중복 실행 방지 (lock file)
# - 매일 08:30 KST 실행 (launchd: ai.ska.today-audit)
# - 픽코 예약 vs 네이버 예약불가 상태 비교 → 누락 차단 / 초과 해제

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/opt/homebrew/bin/tsx"
RUNTIME_SCRIPT="/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.ts"
WORKSPACE_DIR="${AI_AGENT_WORKSPACE:-${JAY_WORKSPACE:-$HOME/.ai-agent-system/workspace}}"
mkdir -p "$WORKSPACE_DIR"
LOCK_FILE="$WORKSPACE_DIR/today-audit.lock"
LOG_FILE="/tmp/today-audit.log"
PICKKO_PROTOCOL_TIMEOUT_MS="${PICKKO_PROTOCOL_TIMEOUT_MS:-300000}"

# 중복 실행 방지
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[$(date)] ⚠️ today-audit already running (PID: $OLD_PID)" | tee -a "$LOG_FILE"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap "rm -f '$LOCK_FILE'" EXIT

echo "[$(date)] ▶ today-audit 시작" >> "$LOG_FILE"

# 네트워크 오류 시 최대 3회 재시도 (10분 간격)
MAX_RETRY=3
RETRY_WAIT=600  # 10분
EXIT_CODE=1

for attempt in $(seq 1 $MAX_RETRY); do
  if [ $attempt -gt 1 ]; then
    echo "[$(date)] 🔄 today-audit 재시도 ${attempt}/${MAX_RETRY} (${RETRY_WAIT}초 대기 후)" >> "$LOG_FILE"
    sleep $RETRY_WAIT
  fi
  MODE=ops TELEGRAM_ENABLED=1 PICKKO_PROTOCOL_TIMEOUT_MS="$PICKKO_PROTOCOL_TIMEOUT_MS" "$NODE" "$RUNTIME_SCRIPT" --audit-today >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    break
  fi
  echo "[$(date)] ⚠️ today-audit 실패 (exit: $EXIT_CODE, 시도: ${attempt}/${MAX_RETRY})" >> "$LOG_FILE"
done

echo "[$(date)] ⏹ today-audit 완료 (exit: $EXIT_CODE)" >> "$LOG_FILE"

# 최신 500줄만 유지
if [ -f "$LOG_FILE" ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi

exit $EXIT_CODE
