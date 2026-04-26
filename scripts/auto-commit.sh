#!/bin/bash
# auto-commit.sh - ai-agent-system 변경사항 자동 커밋 & 푸시

REPO_DIR="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"
LOG_DIR="${AI_AGENT_LOGS:-${JAY_LOGS:-$HOME/.ai-agent-system/logs}}"
LOG_FILE="$LOG_DIR/auto-commit.log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

cd "$REPO_DIR" || { log "ERROR: 디렉토리 이동 실패 - $REPO_DIR"; exit 1; }

# 변경사항 확인
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  log "변경사항 없음. 스킵."
  exit 0
fi

log "변경사항 감지됨. 커밋 시작."

# 변경된 파일 목록 수집 (커밋 메시지용)
CHANGED=$(git status --short | awk '{print $2}' | head -10 | tr '\n' ', ' | sed 's/,$//')

# 스테이징
git add -A

# 커밋 메시지 생성
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
COMMIT_MSG="auto: $TIMESTAMP 자동 저장

변경 파일: $CHANGED"

git commit -m "$COMMIT_MSG"

if [ $? -ne 0 ]; then
  log "ERROR: 커밋 실패"
  exit 1
fi

# 푸시
git push origin HEAD

if [ $? -eq 0 ]; then
  log "SUCCESS: 커밋 & 푸시 완료 - $CHANGED"
else
  log "ERROR: 푸시 실패"
  exit 1
fi
