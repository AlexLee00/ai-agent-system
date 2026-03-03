#!/bin/bash
# tmux-start.sh
# config/tmux-windows.json 을 읽어서 tmux 세션 구성
# 사용: bash scripts/tmux-start.sh [--reload]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$PROJECT_DIR/config/tmux-windows.json"
SESSION=$(node -e "const c=require('$CONFIG'); console.log(c.session)")
LOG="/tmp/tmux-start.log"

log() { echo "[$(date '+%H:%M:%S')] $1" | tee -a "$LOG"; }

# --reload: 이미 있는 세션에 새 창만 추가
RELOAD=false
[[ "$1" == "--reload" ]] && RELOAD=true

# 세션 생성 또는 확인
if tmux has-session -t "$SESSION" 2>/dev/null; then
  if $RELOAD; then
    log "세션 '$SESSION' 존재 — 창 구성 갱신"
  else
    log "세션 '$SESSION' 이미 존재 — 스킵 (--reload 옵션으로 갱신 가능)"
    exit 0
  fi
else
  log "세션 '$SESSION' 신규 생성"
  tmux new-session -d -s "$SESSION" -n "init"
fi

# config에서 창 목록 읽어서 생성 (탭 구분자)
WINDOWS=$(node -e "
  const c = require('$CONFIG');
  c.windows.forEach(w => {
    console.log([w.name, w.dir, w.init_cmd, w.status].join('\t'));
  });
")

FIRST=true
while IFS=$'\t' read -r name dir cmd status; do
  FULL_DIR="$PROJECT_DIR/$dir"
  [ "$dir" = "." ] && FULL_DIR="$PROJECT_DIR"

  # 이미 존재하는 창이면 스킵
  if tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -q "^${name}$"; then
    log "창 '$name' 이미 존재 — 스킵"
    continue
  fi

  if $FIRST; then
    tmux rename-window -t "$SESSION:init" "$name"
    FIRST=false
  else
    tmux new-window -t "$SESSION" -n "$name"
  fi

  tmux send-keys -t "$SESSION:$name" "cd $FULL_DIR && $cmd" Enter

  if [[ "$status" == "pending" ]]; then
    tmux send-keys -t "$SESSION:$name" "echo '  ⏳ 맥미니 도착 후 구축 예정'" Enter
  fi

  log "창 '$name' 생성 완료 (status: $status)"
done <<< "$WINDOWS"

# cc 창은 항상 마지막 위치 (이미 마지막으로 선언되어 있으면 자동)
tmux select-window -t "$SESSION:ska" 2>/dev/null || true

log "tmux 세션 '$SESSION' 구성 완료"
log "접속: tmux attach -t $SESSION"
