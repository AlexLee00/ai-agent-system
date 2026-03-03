#!/bin/bash
# cc-remote-start.sh
# tmux cc 창 전용 — Remote Control 세션 자동 유지 루프

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CC_LOG="/tmp/cc-remote.log"
CONTEXT_SCRIPT="$SCRIPT_DIR/update-rc-context.sh"
RESTART_DELAY=10

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$CC_LOG"; }

log "=== Remote Control 자동 재시작 루프 시작 ==="
log "프로젝트: $PROJECT_DIR"

while true; do
  # 1. 컨텍스트 최신화
  bash "$CONTEXT_SCRIPT" >> "$CC_LOG" 2>&1

  # 2. Remote Control 시작
  log "Claude Code Remote Control 시작..."
  cd "$PROJECT_DIR"
  claude remote-control 2>&1 | tee -a "$CC_LOG"
  EXIT_CODE=$?

  log "Remote Control 종료 (exit: $EXIT_CODE) — ${RESTART_DELAY}초 후 재시작"
  sleep "$RESTART_DELAY"
done
