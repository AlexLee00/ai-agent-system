#!/bin/bash
# ============================================================
# 02-setup.sh — 맥미니 초기 설정
# 실행: 맥미니에서 (01-push.sh 이후)
# 사용법: bash ~/projects/ai-agent-system/scripts/migrate/02-setup.sh
# ============================================================

set -e

ROOT="$HOME/projects/ai-agent-system"

# ── 색상 출력 ─────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()    { echo -e "${BLUE}[SETUP]${NC} $*"; }
ok()     { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()   { echo -e "${YELLOW}[경고]${NC} $*"; }
err()    { echo -e "${RED}[오류]${NC} $*"; exit 1; }
section(){ echo ""; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BOLD}  $*${NC}"; echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# ── 이 스크립트가 맥미니에서 실행되는지 확인 ─────────────
if [[ ! -d "$ROOT" ]]; then
  err "프로젝트 없음: $ROOT\n  먼저 맥북프로에서 01-push.sh 실행 후 재시도하세요."
fi

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   맥미니 이전 설정 (02-setup.sh)        ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

# ═══════════════════════════════════════════════════════════
section "1단계: 기본 도구 확인"
# ═══════════════════════════════════════════════════════════

# Homebrew
if ! command -v brew &>/dev/null; then
  log "Homebrew 설치 중 ..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Apple Silicon 경로 추가
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
  eval "$(/opt/homebrew/bin/brew shellenv)"
  ok "Homebrew 설치 완료"
else
  ok "Homebrew 이미 설치됨: $(brew --version | head -1)"
fi

# tmux
if ! command -v tmux &>/dev/null; then
  log "tmux 설치 중 ..."
  brew install tmux
  ok "tmux 설치 완료"
else
  ok "tmux: $(tmux -V)"
fi

# ═══════════════════════════════════════════════════════════
section "2단계: Node.js (Homebrew)"
# ═══════════════════════════════════════════════════════════

if ! command -v node &>/dev/null; then
  log "Homebrew Node.js 설치 중 ..."
  brew install node
  ok "Node.js 설치 완료: $(node --version)"
else
  ok "Node.js 이미 설치됨: $(node --version)"
fi

# ═══════════════════════════════════════════════════════════
section "3단계: Python 3.12"
# ═══════════════════════════════════════════════════════════

if ! python3.12 --version &>/dev/null; then
  log "Python 3.12 설치 중 ..."
  brew install python@3.12
  ok "Python 3.12 설치 완료"
else
  ok "Python 3.12: $(python3.12 --version)"
fi

# ═══════════════════════════════════════════════════════════
section "4단계: npm 전역 패키지"
# ═══════════════════════════════════════════════════════════

log "openclaw 설치 ..."
npm install -g openclaw || warn "openclaw 설치 실패 — 수동으로 설치 필요"
ok "openclaw: $(openclaw --version 2>/dev/null || echo '설치됨')"

log "claude-code 설치 ..."
npm install -g @anthropic-ai/claude-code || warn "claude-code 설치 실패"
ok "claude-code 설치 완료"

# ═══════════════════════════════════════════════════════════
section "5단계: ai-agent-system Node 의존성"
# ═══════════════════════════════════════════════════════════

log "루트 패키지 설치 ..."
cd "$ROOT"
npm install
ok "루트 npm install 완료"

log "reservation 봇 패키지 설치 ..."
cd "$ROOT/bots/reservation"
npm install
ok "reservation npm install 완료"

# Playwright Chromium
log "Playwright Chromium 설치 ..."
npx playwright install chromium
ok "Playwright Chromium 설치 완료"

# ═══════════════════════════════════════════════════════════
section "6단계: ska Python venv 설치"
# ═══════════════════════════════════════════════════════════

SKA_DIR="$ROOT/bots/ska"
VENV_DIR="$SKA_DIR/venv"

log "ska Python venv 생성 ..."
python3.12 -m venv "$VENV_DIR"
ok "venv 생성: $VENV_DIR"

log "ska 패키지 설치 (requirements.txt) ..."
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r "$SKA_DIR/requirements.txt"
ok "ska 패키지 설치 완료"

# Prophet용 Stan 컴파일러 설치 (cmdstanpy)
log "CmdStan 설치 (Prophet 의존성) ..."
"$VENV_DIR/bin/python" -c "import cmdstanpy; cmdstanpy.install_cmdstan()" \
  && ok "CmdStan 설치 완료" \
  || warn "CmdStan 설치 실패 — Prophet 예측 기능 비활성화될 수 있음"

# ═══════════════════════════════════════════════════════════
section "7단계: RAG 서버 확인 (pgvector)"
# ═══════════════════════════════════════════════════════════
# Python rag-system(ChromaDB) 제거됨 — pgvector(rag-server.js)로 전환 완료 (2026-03-09)
# RAG 서버: packages/core/lib/rag-server.js (launchd: ai.rag.server, 포트 8100)
ok "RAG: pgvector 전환 완료 — Python venv 설치 불필요"

# ═══════════════════════════════════════════════════════════
section "8단계: launchd plist 수정 및 등록"
# ═══════════════════════════════════════════════════════════

# TMPDIR 자동 수정 (맥미니 실제 TMPDIR로)
REAL_TMPDIR=$(launchctl getenv TMPDIR 2>/dev/null || echo "/tmp/")
PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"

if [[ -f "$PLIST" ]]; then
  log "openclaw.gateway.plist TMPDIR 수정 → $REAL_TMPDIR"
  # TMPDIR 값 교체 (플레이스홀더 또는 맥북프로의 값 → 맥미니 값)
  sed -i '' \
    "s|<string>/var/folders/[^<]*</string>|<string>${REAL_TMPDIR}</string>|g" \
    "$PLIST"
  ok "TMPDIR 수정 완료"
fi

# Node 경로 수정 (Homebrew 경로 기준)
NODE_PATH="$(which node)"
NODE_BIN_DIR="$(dirname "$NODE_PATH")"
OPENCLAW_BIN="$(ls "$NODE_BIN_DIR/../lib/node_modules/openclaw/dist/index.js" 2>/dev/null || echo "")"

if [[ -n "$OPENCLAW_BIN" && -f "$PLIST" ]]; then
  log "openclaw 경로 수정: $NODE_PATH"
  # ProgramArguments의 node 경로 수정
  python3 -c "
import plistlib, sys

with open('$PLIST', 'rb') as f:
    d = plistlib.load(f)

args = d.get('ProgramArguments', [])
if args:
    args[0] = '$NODE_PATH'
    if len(args) > 1:
        args[1] = '$OPENCLAW_BIN'
    d['ProgramArguments'] = args

# PATH 업데이트
env = d.get('EnvironmentVariables', {})
env['HOME'] = '$HOME'
env['TMPDIR'] = '$REAL_TMPDIR'
d['EnvironmentVariables'] = env

with open('$PLIST', 'wb') as f:
    plistlib.dump(d, f)

print('plist 업데이트 완료')
"
  ok "openclaw.gateway.plist 경로 수정 완료"
fi

# 모든 plist의 HOME 경로 확인 (보통 /Users/alexlee로 동일)
  log "PATH 환경변수 수정 (Homebrew node 경로 반영) ..."
  for plist in ~/Library/LaunchAgents/ai.ska.*.plist ~/Library/LaunchAgents/ai.agent.*.plist; do
    [[ -f "$plist" ]] || continue
  # 기존 node 경로를 현재 시스템의 node 경로로 교체
  sed -i '' \
    "s|/Users/alexlee/.*/versions/node/v[^/]*/bin|$NODE_BIN_DIR|g" \
    "$plist" 2>/dev/null && true
done
ok "PATH 경로 수정 완료"

# launchd 등록
log "launchd 서비스 등록 ..."
LOADED=0; FAILED=0
for plist in ~/Library/LaunchAgents/ai.*.plist; do
  label=$(basename "$plist" .plist)
  if launchctl load "$plist" 2>/dev/null; then
    LOADED=$((LOADED+1))
  else
    warn "로드 실패: $label"
    FAILED=$((FAILED+1))
  fi
done
ok "$LOADED개 서비스 등록 완료 (실패: $FAILED개)"

# ═══════════════════════════════════════════════════════════
section "9단계: git hooks 설치"
# ═══════════════════════════════════════════════════════════

cd "$ROOT"
if [[ -f scripts/setup-hooks.sh ]]; then
  bash scripts/setup-hooks.sh
  ok "git hooks 설치 완료"
fi

# ═══════════════════════════════════════════════════════════
section "10단계: 검증"
# ═══════════════════════════════════════════════════════════

echo ""
log "서비스 상태 확인 ..."
sleep 3  # 서비스 시작 대기

SERVICES=(
  "ai.openclaw.gateway"
  "ai.ska.naver-monitor"
  "ai.ska.kiosk-monitor"
)

ALL_OK=true
for svc in "${SERVICES[@]}"; do
  STATUS=$(launchctl list "$svc" 2>/dev/null | grep '"PID"' | grep -v '"PID" = 0' || true)
  if [[ -n "$STATUS" ]]; then
    PID=$(launchctl list "$svc" 2>/dev/null | grep '"PID"' | awk '{print $3}' | tr -d ';')
    ok "$svc (PID: $PID)"
  else
    warn "$svc — 실행 안 됨 (수동 확인 필요)"
    ALL_OK=false
  fi
done

echo ""
log "DB 파일 확인 ..."
STATE_DB="$HOME/.openclaw/workspace/state.db"
DUCKDB="$ROOT/bots/ska/db/ska.duckdb"
[[ -f "$STATE_DB" ]] && ok "state.db: $(du -sh "$STATE_DB" | cut -f1)" || warn "state.db 없음!"
[[ -f "$DUCKDB" ]]   && ok "ska.duckdb: $(du -sh "$DUCKDB" | cut -f1)" || warn "ska.duckdb 없음!"

echo ""
log "secrets.json 확인 ..."
SECRETS="$ROOT/bots/reservation/secrets.json"
[[ -f "$SECRETS" ]] && ok "secrets.json 존재" || warn "secrets.json 없음! AirDrop으로 수동 복사 필요"

# ── 완료 ──────────────────────────────────────────────────
echo ""
if $ALL_OK; then
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}${BOLD}  설정 완료! 맥미니 이전 성공 ✅${NC}"
  echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
else
  echo -e "${YELLOW}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${YELLOW}${BOLD}  설정 완료 (일부 경고 있음) — 위 경고 확인하세요${NC}"
  echo -e "${YELLOW}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
fi

echo ""
echo -e "${BOLD}남은 수동 작업:${NC}"
echo "  1. Google Gemini 재인증:  openclaw auth login google-gemini-cli"
echo "  2. 스카 텔레그램 응답 확인"
echo "  3. 맥북프로 서비스 중단:    launchctl unload ~/Library/LaunchAgents/ai.*.plist"
echo "  4. 검증 스크립트 실행:    bash scripts/migrate/03-verify.sh"
echo ""
