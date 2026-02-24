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

  # naver-profile을 사용 중인 Chromium 잔존 프로세스 정리 (SingletonLock 해제)
  CHROME_PIDS=$(pgrep -f "naver-profile" 2>/dev/null)
  if [ -n "$CHROME_PIDS" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🌐 Chromium 잔존 프로세스 종료 (naver-profile 락 해제)"
    echo "$CHROME_PIDS" | xargs kill 2>/dev/null
    sleep 5
  fi

  # SingletonLock 삭제 (죽은 프로세스가 남긴 락 파일 → frame detach 원인)
  NAVER_PROFILE="$HOME/.openclaw/workspace/naver-profile"
  rm -f "$NAVER_PROFILE/SingletonLock" "$NAVER_PROFILE/SingletonCookie" "$NAVER_PROFILE/SingletonSocket" 2>/dev/null
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔓 Chrome SingletonLock 제거 완료"
}

echo "[$(date '+%Y-%m-%d %H:%M:%S')] OPS 모드 자동 재시작 루프 시작"

while true; do
  cleanup_old
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ▶ naver-monitor 시작"

  MODE=ops PICKKO_ENABLE=1 STRICT_TIME=1 NAVER_HEADLESS=1 \
  TELEGRAM_ENABLED=1 NAVER_INTERVAL_MS=300000 \
  OBSERVE_ONLY=0 \
  PICKKO_CANCEL_ENABLE=1 \
  node naver-monitor.js

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⏹ naver-monitor 종료 (5초 후 재시작...)"
  sleep 5
done
