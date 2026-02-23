#!/bin/bash
# nightly-sync.sh - 자정 자동 실행: 활성 봇 컨텍스트 보존
# launchd로 매일 00:00에 실행됨

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/nightly-sync.log"
DATE=$(date '+%Y-%m-%d %H:%M:%S')

echo "[$DATE] ====== 자정 컨텍스트 보존 시작 ======" >> "$LOG_FILE"

# 1. 활성 봇(status: ops) 역방향 동기화 (워크스페이스 → context/)
echo "[$DATE] 📥 활성 봇 역동기화 중..." >> "$LOG_FILE"
node "$ROOT/scripts/deploy-context.js" --all --sync >> "$LOG_FILE" 2>&1

# 2. git commit (변경사항 있을 때만)
cd "$ROOT"
if ! git diff --quiet bots/; then
  git add bots/
  git commit -m "chore: 자정 자동 컨텍스트 보존 ($(date '+%Y-%m-%d'))" >> "$LOG_FILE" 2>&1
  echo "[$DATE] ✅ git commit 완료" >> "$LOG_FILE"
else
  echo "[$DATE] ℹ️ 변경사항 없음 - commit 스킵" >> "$LOG_FILE"
fi

echo "[$DATE] ====== 완료 ======" >> "$LOG_FILE"
