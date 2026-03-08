#!/bin/bash
# ============================================================
# 01-push.sh — 맥북프로 → 맥미니 파일 전송
# 실행: 맥북프로에서
# 사용법: ./scripts/migrate/01-push.sh <맥미니-IP>
# 예시:  ./scripts/migrate/01-push.sh 192.168.1.100
# ============================================================

set -e

TARGET_IP="${1:-}"
TARGET_USER="alexlee"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── 색상 출력 ─────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${BLUE}[PUSH]${NC} $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}  $*"; }
warn() { echo -e "${YELLOW}[경고]${NC} $*"; }
err()  { echo -e "${RED}[오류]${NC} $*"; exit 1; }

# ── 인자 확인 ─────────────────────────────────────────────
if [[ -z "$TARGET_IP" ]]; then
  echo -e "${BOLD}사용법:${NC} $0 <맥미니-IP>"
  echo "  예시: $0 192.168.1.100"
  echo ""
  echo "맥미니 IP 확인: 맥미니에서 'ipconfig getifaddr en0' 또는"
  echo "  시스템 설정 → Wi-Fi → 세부사항"
  exit 1
fi

TARGET="${TARGET_USER}@${TARGET_IP}"

# ── SSH 연결 확인 ─────────────────────────────────────────
log "SSH 연결 확인: $TARGET ..."
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "$TARGET" "echo ok" &>/dev/null; then
  err "SSH 연결 실패. 확인사항:
  1. 맥미니에서 원격 로그인 활성화 (시스템 설정 → 공유 → 원격 로그인)
  2. SSH 키 등록: ssh-copy-id $TARGET
  3. IP 주소 확인: $TARGET_IP"
fi
ok "SSH 연결 성공"

# ── 원격 디렉토리 생성 ────────────────────────────────────
log "원격 디렉토리 생성 ..."
ssh "$TARGET" "mkdir -p ~/projects ~/Library/LaunchAgents"

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  1단계: 프로젝트 코드 전송${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# ai-agent-system (node_modules, venv 제외 — 맥미니에서 재설치)
log "ai-agent-system 전송 (의존성 제외) ..."
rsync -avz --progress \
  --exclude='node_modules' \
  --exclude='.venv' \
  --exclude='venv' \
  --exclude='*.pyc' \
  --exclude='__pycache__' \
  --exclude='*.egg-info' \
  --exclude='.git' \
  "$ROOT/" \
  "$TARGET:~/projects/ai-agent-system/"
ok "ai-agent-system 전송 완료"

# rag-system 제거됨 — pgvector(rag-server.js)로 전환 완료 (2026-03-09)

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  2단계: OpenClaw 워크스페이스 전송${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# .openclaw (전체 — Chrome 프로필 포함, 시간 좀 걸림)
log "~/.openclaw 전송 (Chrome 프로필 포함, ~600MB) ..."
rsync -avz --progress \
  --exclude='logs' \
  ~/.openclaw/ \
  "$TARGET:~/.openclaw/"
ok "~/.openclaw 전송 완료"

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  3단계: Claude 메모리·설정 전송${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

# Claude 메모리 (히스토리 제외 — 용량 큼)
log "Claude 메모리 전송 ..."
ssh "$TARGET" "mkdir -p ~/.claude/projects/-Users-alexlee/memory"
rsync -avz \
  ~/.claude/projects/-Users-alexlee/memory/ \
  "$TARGET:~/.claude/projects/-Users-alexlee/memory/"

# Claude 설정 (API 키 포함)
log "Claude 설정 전송 ..."
rsync -avz \
  ~/.claude/settings.json \
  ~/.claude/settings.local.json \
  "$TARGET:~/.claude/" 2>/dev/null || warn "settings 파일 일부 없음 — 스킵"

ok "Claude 설정 전송 완료"

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  4단계: launchd plist 전송${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

log "launchd plist 전송 ..."
rsync -avz \
  ~/Library/LaunchAgents/ai.*.plist \
  "$TARGET:~/Library/LaunchAgents/"
ok "plist 전송 완료 (등록은 02-setup.sh에서)"

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  5단계: SSH 키 전송${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ -f ~/.ssh/id_ed25519 ]]; then
  log "SSH 키 전송 ..."
  ssh "$TARGET" "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
  rsync -avz ~/.ssh/id_ed25519 ~/.ssh/id_ed25519.pub \
    "$TARGET:~/.ssh/"
  ssh "$TARGET" "chmod 600 ~/.ssh/id_ed25519"
  ok "SSH 키 전송 완료"
else
  warn "~/.ssh/id_ed25519 없음 — 스킵 (필요 시 수동 복사)"
fi

# ── 완료 ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  파일 전송 완료!${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "다음 단계 — 맥미니에 SSH 접속 후:"
echo ""
echo -e "  ${BOLD}ssh $TARGET${NC}"
echo -e "  ${BOLD}cd ~/projects/ai-agent-system${NC}"
echo -e "  ${BOLD}bash scripts/migrate/02-setup.sh${NC}"
echo ""
