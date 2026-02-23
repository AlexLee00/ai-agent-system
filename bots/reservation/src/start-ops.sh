#!/bin/bash
# OPS 모드 자동 재시작 루프
# 2시간 후 종료되면 5초 대기 후 자동 재시작

cd "$(dirname "$0")"

LOCK_FILE="$HOME/.openclaw/workspace/naver-monitor.lock"

cleanup_old() {
  # 락 파일에서 구 PID 확인
  if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔍 구 프로세스 발견 (PID: $OLD_PID) → 종료"
      kill "$OLD_PID" 2>/dev/null
      sleep 2
    fi
    rm -f "$LOCK_FILE"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🗑️  락 파일 제거"
  fi

  # 락 파일 외에도 실행 중인 naver-monitor 프로세스 잔존 확인
  STALE_PIDS=$(pgrep -f "node naver-monitor.js" 2>/dev/null)
  if [ -n "$STALE_PIDS" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔍 잔존 프로세스 발견 (PID: $STALE_PIDS) → 종료"
    echo "$STALE_PIDS" | xargs kill 2>/dev/null
    sleep 2
  fi
}

echo "[$(date '+%Y-%m-%d %H:%M:%S')] OPS 모드 자동 재시작 루프 시작"

while true; do
  cleanup_old
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ▶ naver-monitor 시작"

  MODE=ops PICKKO_ENABLE=1 STRICT_TIME=1 NAVER_HEADLESS=1 \
  TELEGRAM_ENABLED=1 NAVER_INTERVAL_MS=300000 \
  OBSERVE_ONLY=0 \
  node naver-monitor.js

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⏹ naver-monitor 종료 (5초 후 재시작...)"
  sleep 5
done
