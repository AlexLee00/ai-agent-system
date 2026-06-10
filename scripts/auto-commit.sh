#!/bin/bash
# auto-commit.sh - ai-agent-system 변경사항 자동 커밋 & 푸시

REPO_DIR="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"
LOG_DIR="${AI_AGENT_LOGS:-${JAY_LOGS:-$HOME/.ai-agent-system/logs}}"
LOG_FILE="$LOG_DIR/auto-commit.log"

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

AUTO_COMMIT_EXCLUDE_PATHSPECS=(
  ':(glob,exclude)bots/**/output/**'
  ':(glob,exclude)output/**'
  ':(glob,exclude)dist/**'
  ':(glob,exclude)coverage/**'
  ':(glob,exclude)docs/codex/**'
  ':(glob,exclude)docs/auto_dev/**'
  ':(glob,exclude)docs/strategy/**'
  ':(glob,exclude)bots/sigma/docs/codex/**'
  ':(glob,exclude).claude/**'
  ':(glob,exclude)tmp/**'
  ':(glob,exclude)docs/archive/**'
)

AUTO_COMMIT_GENERATED_PATHSPECS=(
  ':(glob)bots/**/output/**'
  ':(glob)output/**'
  ':(glob)dist/**'
  ':(glob)coverage/**'
  ':(glob)docs/codex/**'
  ':(glob)docs/auto_dev/**'
  ':(glob)docs/strategy/**'
  ':(glob)bots/sigma/docs/codex/**'
  ':(glob).claude/**'
  ':(glob)tmp/**'
  ':(glob)docs/archive/**'
)

unstage_generated_or_ignored() {
  git restore --staged -- "${AUTO_COMMIT_GENERATED_PATHSPECS[@]}" 2>/dev/null || true

  local ignored_file
  ignored_file="$(mktemp)"
  git ls-files -c -i --exclude-standard -z > "$ignored_file" 2>/dev/null || true
  if [ -s "$ignored_file" ]; then
    git restore --staged --pathspec-from-file="$ignored_file" --pathspec-file-nul 2>/dev/null || true
  fi
  rm -f "$ignored_file"
}

cd "$REPO_DIR" || { log "ERROR: 디렉토리 이동 실패 - $REPO_DIR"; exit 1; }

REFACTORER_LOCK_FILE="$REPO_DIR/.refactorer-active.lock"
REFACTORER_LOCK_MAX_AGE_SECONDS="${REFACTORER_LOCK_MAX_AGE_SECONDS:-600}"
if [ -f "$REFACTORER_LOCK_FILE" ]; then
  LOCK_MTIME="$(stat -f %m "$REFACTORER_LOCK_FILE" 2>/dev/null || stat -c %Y "$REFACTORER_LOCK_FILE" 2>/dev/null || echo 0)"
  NOW="$(date +%s)"
  LOCK_AGE=$((NOW - LOCK_MTIME))
  if [ "$LOCK_MTIME" -gt 0 ] && [ "$LOCK_AGE" -lt "$REFACTORER_LOCK_MAX_AGE_SECONDS" ]; then
    log "refactorer active lock is fresh (${LOCK_AGE}s). auto-commit skipped."
    exit 0
  fi
fi

# 변경사항 확인
if [ -z "$(git status --porcelain -- . "${AUTO_COMMIT_EXCLUDE_PATHSPECS[@]}")" ]; then
  log "변경사항 없음. 스킵."
  exit 0
fi

log "변경사항 감지됨. 커밋 시작."

# 변경된 파일 목록 수집 (커밋 메시지용)
CHANGED=$(git status --short -- . "${AUTO_COMMIT_EXCLUDE_PATHSPECS[@]}" | awk '{print $2}' | head -10 | tr '\n' ', ' | sed 's/,$//')

# 스테이징 — 런타임 산출물/초안/ignored tracked 파일은 자동 커밋에서 제외
git add -A -- . "${AUTO_COMMIT_EXCLUDE_PATHSPECS[@]}"
unstage_generated_or_ignored

if git diff --cached --quiet; then
  log "커밋 대상 없음(자동생성/ignored 파일만 변경). 스킵."
  exit 0
fi

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
