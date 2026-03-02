#!/bin/bash
# ============================================================
# 03-verify.sh — 이전 후 전체 검증
# 실행: 맥미니에서 (02-setup.sh 이후)
# 사용법: bash ~/projects/ai-agent-system/scripts/migrate/03-verify.sh
# ============================================================

ROOT="$HOME/projects/ai-agent-system"
PASS=0; FAIL=0; WARN=0

# ── 색상 출력 ─────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}✅${NC} $*"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}❌${NC} $*"; FAIL=$((FAIL+1)); }
warn() { echo -e "  ${YELLOW}⚠️ ${NC} $*"; WARN=$((WARN+1)); }
section() { echo ""; echo -e "${BOLD}▶ $*${NC}"; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║   맥미니 이전 검증 (03-verify.sh)       ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"

# ── 환경 ──────────────────────────────────────────────────
section "환경"
[[ "$(uname -m)" == "arm64" ]] && pass "Apple Silicon (arm64)" || warn "arm64 아님: $(uname -m)"
[[ "$(whoami)" == "alexlee" ]] && pass "사용자: alexlee" || warn "사용자: $(whoami) (alexlee 아님)"

# ── 도구 ──────────────────────────────────────────────────
section "필수 도구"
command -v node   &>/dev/null && pass "node: $(node --version)"   || fail "node 없음"
command -v npm    &>/dev/null && pass "npm: $(npm --version)"     || fail "npm 없음"
command -v python3.12 &>/dev/null && pass "python3.12: $(python3.12 --version)" || fail "python3.12 없음"
command -v openclaw &>/dev/null && pass "openclaw: $(openclaw --version 2>/dev/null || echo '설치됨')" || fail "openclaw 없음"
command -v claude  &>/dev/null && pass "claude-code 설치됨"       || warn "claude-code 없음"
command -v tmux    &>/dev/null && pass "tmux: $(tmux -V)"         || warn "tmux 없음"
command -v brew    &>/dev/null && pass "Homebrew 설치됨"          || warn "Homebrew 없음"

# Node 버전 확인
NODE_VER=$(node --version 2>/dev/null || echo "none")
[[ "$NODE_VER" == v24* ]] && pass "Node LTS v24 확인" || warn "Node 버전: $NODE_VER (v24 권장)"

# ── 파일 ──────────────────────────────────────────────────
section "핵심 파일"

check_file() {
  local path="$1" label="$2"
  if [[ -f "$path" ]]; then
    SIZE=$(du -sh "$path" 2>/dev/null | cut -f1)
    pass "$label ($SIZE)"
  else
    fail "$label 없음: $path"
  fi
}
check_dir() {
  local path="$1" label="$2"
  if [[ -d "$path" ]]; then
    SIZE=$(du -sh "$path" 2>/dev/null | cut -f1)
    pass "$label ($SIZE)"
  else
    fail "$label 없음: $path"
  fi
}

check_file "$ROOT/bots/reservation/secrets.json"          "secrets.json"
check_file "$HOME/.openclaw/workspace/state.db"           "state.db (SQLite)"
check_file "$ROOT/bots/ska/db/ska.duckdb"                 "ska.duckdb (DuckDB)"
check_file "$HOME/.openclaw/openclaw.json"                "openclaw.json"
check_dir  "$HOME/.openclaw/workspace/naver-profile"      "naver-profile (Chrome)"
check_dir  "$HOME/.claude/projects/-Users-alexlee/memory" "Claude 메모리"

# ── launchd 서비스 ─────────────────────────────────────────
section "launchd 서비스"

CRITICAL_SVCS=(
  "ai.openclaw.gateway"
  "ai.ska.naver-monitor"
  "ai.ska.kiosk-monitor"
)
OTHER_SVCS=(
  "ai.ska.etl"
  "ai.ska.health-check"
  "ai.ska.log-rotate"
  "ai.ska.pickko-daily-summary"
  "ai.ska.tmux"
)

for svc in "${CRITICAL_SVCS[@]}"; do
  INFO=$(launchctl list "$svc" 2>/dev/null || true)
  PID=$(echo "$INFO" | grep '"PID"' | awk '{print $3}' | tr -d ';')
  LAST=$(echo "$INFO" | grep '"LastExitStatus"' | awk '{print $3}' | tr -d ';')
  if [[ -n "$PID" && "$PID" != "0" ]]; then
    pass "$svc (PID: $PID)"
  elif [[ -n "$INFO" ]]; then
    fail "$svc — 실행 안 됨 (LastExitStatus: $LAST)"
  else
    fail "$svc — 등록 안 됨"
  fi
done

for svc in "${OTHER_SVCS[@]}"; do
  INFO=$(launchctl list "$svc" 2>/dev/null || true)
  if [[ -n "$INFO" ]]; then
    pass "$svc 등록됨"
  else
    warn "$svc 등록 안 됨"
  fi
done

TOTAL_LOADED=$(launchctl list 2>/dev/null | grep -c "ai\." || true)
pass "총 ai.* 서비스: ${TOTAL_LOADED}개 등록"

# ── Node 의존성 ────────────────────────────────────────────
section "Node 의존성"

[[ -d "$ROOT/node_modules" ]] && pass "루트 node_modules" || fail "루트 node_modules 없음"
[[ -d "$ROOT/bots/reservation/node_modules" ]] && pass "reservation node_modules" || fail "reservation node_modules 없음"

# Playwright Chromium
CHROMIUM=$(find "$HOME/Library/Caches/ms-playwright" -name "chrome" -type f 2>/dev/null | head -1)
[[ -n "$CHROMIUM" ]] && pass "Playwright Chromium 설치됨" || fail "Playwright Chromium 없음"

# ── Python 의존성 ──────────────────────────────────────────
section "Python 의존성"

SKA_VENV="$ROOT/bots/ska/venv"
if [[ -d "$SKA_VENV" ]]; then
  pass "ska venv 존재"
  "$SKA_VENV/bin/python" -c "import duckdb" 2>/dev/null   && pass "duckdb import 성공"   || fail "duckdb import 실패"
  "$SKA_VENV/bin/python" -c "import pandas" 2>/dev/null   && pass "pandas import 성공"   || fail "pandas import 실패"
  "$SKA_VENV/bin/python" -c "import prophet" 2>/dev/null  && pass "prophet import 성공"  || warn "prophet import 실패 (CmdStan 필요)"
  "$SKA_VENV/bin/python" -c "import anthropic" 2>/dev/null && pass "anthropic import 성공" || fail "anthropic import 실패"
else
  fail "ska venv 없음: $SKA_VENV"
fi

RAG_VENV="$HOME/projects/rag-system/.venv"
if [[ -d "$RAG_VENV" ]]; then
  pass "rag-system venv 존재"
else
  warn "rag-system venv 없음 (RAG 사용 시 필요)"
fi

# ── ETL 빠른 테스트 ────────────────────────────────────────
section "ETL 동작 테스트 (--days=1)"

ETL_OUT=$("$SKA_VENV/bin/python" "$ROOT/bots/ska/src/etl.py" --days=1 2>&1 || true)
if echo "$ETL_OUT" | grep -q "ETL.*완료\|upsert"; then
  pass "ETL 실행 성공"
else
  fail "ETL 실패:\n$ETL_OUT"
fi

# ── DB 데이터 확인 ─────────────────────────────────────────
section "DB 데이터 무결성"

# state.db 테이블 확인
TABLES=$(sqlite3 "$HOME/.openclaw/workspace/state.db" ".tables" 2>/dev/null || true)
if echo "$TABLES" | grep -q "reservations"; then
  ROW_COUNT=$(sqlite3 "$HOME/.openclaw/workspace/state.db" "SELECT COUNT(*) FROM reservations" 2>/dev/null || echo 0)
  pass "reservations 테이블: ${ROW_COUNT}행"
else
  fail "reservations 테이블 없음"
fi
if echo "$TABLES" | grep -q "daily_summary"; then
  ROW_COUNT=$(sqlite3 "$HOME/.openclaw/workspace/state.db" "SELECT COUNT(*) FROM daily_summary" 2>/dev/null || echo 0)
  pass "daily_summary 테이블: ${ROW_COUNT}행"
else
  warn "daily_summary 테이블 없음"
fi

# DuckDB 확인
DUCK_COUNT=$("$SKA_VENV/bin/python" -c "
import duckdb
con = duckdb.connect('$ROOT/bots/ska/db/ska.duckdb')
n = con.execute('SELECT COUNT(*) FROM revenue_daily').fetchone()[0]
con.close()
print(n)
" 2>/dev/null || echo "오류")
if [[ "$DUCK_COUNT" =~ ^[0-9]+$ ]]; then
  pass "revenue_daily: ${DUCK_COUNT}행"
else
  fail "DuckDB 조회 실패: $DUCK_COUNT"
fi

# ── 수동 확인 필요 항목 ────────────────────────────────────
section "수동 확인 필요"

warn "Google Gemini OAuth: openclaw auth login google-gemini-cli"
warn "네이버 Chrome 프로필 로그인 유효성 확인"
warn "텔레그램 봇 응답 확인 (사장님한테 메시지 보내서 스카 응답 체크)"
warn "맥북프로 서비스 중단:  launchctl unload ~/Library/LaunchAgents/ai.*.plist"

# ── 결과 요약 ─────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  검증 결과: ✅ ${PASS}개 통과 / ❌ ${FAIL}개 실패 / ⚠️  ${WARN}개 경고${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}이전 성공! 맥미니 정상 운영 가능합니다.${NC}"
else
  echo -e "${RED}${BOLD}$FAIL개 항목 실패. 위 오류를 확인하세요.${NC}"
fi
echo ""
