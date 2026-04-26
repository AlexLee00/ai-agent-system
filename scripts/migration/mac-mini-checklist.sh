#!/bin/bash
# scripts/migration/mac-mini-checklist.sh — 맥미니 이관 체크리스트
#
# 사용법:
#   bash scripts/migration/mac-mini-checklist.sh        # 체크리스트 출력
#   bash scripts/migration/mac-mini-checklist.sh --verify # 현재 환경 자동 검증
set -euo pipefail

VERIFY=${1:-""}

echo ""
echo "🖥️  맥미니 이관 체크리스트"
echo "══════════════════════════════════════════════"
echo "  대상: Mac Mini M4 Pro 64GB / ai-agent-system"
echo "  일정: 2026-04 중순 (맥미니 도착 후)"
echo ""

# ── Phase A: 기본 세팅 ────────────────────────────────────────────
echo "=== Phase A: 기본 세팅 (맥미니 도착 즉시) ==="
echo "  □ macOS 최신 업데이트 + 보안 설정 (FileVault, 방화벽)"
echo "  □ Homebrew 설치: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
echo "  □ Node.js v24 LTS: brew install nvm && nvm install 24"
echo "  □ Python 3.12: brew install pyenv && pyenv install 3.12.4"
echo "  □ Git + SSH 키 생성 + GitHub 연동"
echo "  □ Tailscale 설치 + 맥북과 동일 계정 로그인"
echo "  □ PostgreSQL 17: brew install postgresql@17 && brew services start postgresql@17"
echo "  □ createdb jay && psql jay -c 'CREATE SCHEMA claude; CREATE SCHEMA reservation; CREATE SCHEMA investment; CREATE SCHEMA ska; CREATE EXTENSION IF NOT EXISTS pgcrypto;'"
echo "  □ Claude Code CLI 설치 + Anthropic 인증"
echo "  □ Hub runtime secret/launchd 설정"
echo ""

# ── Phase B: 시스템 복제 ──────────────────────────────────────────
echo "=== Phase B: 시스템 복제 ==="
echo "  □ git clone git@github.com:AlexLee00/ai-agent-system.git"
echo "  □ cd ai-agent-system && npm install"
echo "  □ bots/ska/venv 재생성: python3.12 -m venv bots/ska/venv && bots/ska/venv/bin/pip install -r bots/ska/requirements.txt"
echo "  □ secrets.json 복사 (Git 아님 — 직접 전송):"
echo "      맥북: scp bots/reservation/secrets.json mac-mini:~/projects/ai-agent-system/bots/reservation/"
echo "      권한: chmod 600 bots/reservation/secrets.json"
echo "  □ PostgreSQL 데이터 이관:"
echo "      맥북: pg_dump jay > /tmp/jay_\$(date +%Y%m%d).sql"
echo "      전송: scp /tmp/jay_*.sql mac-mini:/tmp/"
echo "      복원: psql jay < /tmp/jay_*.sql"
echo "  □ AI Agent 워크스페이스 복사:"
echo "      scp -r ~/.ai-agent-system mac-mini:~/"
echo "  □ ~/.ai-agent-system/ 하위 runtime/logs/backups 확인"
echo ""

# ── Phase C: 병렬 운영 검증 ───────────────────────────────────────
echo "=== Phase C: 병렬 운영 검증 (맥미니 DEV + 맥북 OPS 동시) ==="
echo "  □ 맥미니에서 MODE=dev 전체 실행 테스트"
echo "  □ 덱스터 퀵체크: node bots/claude/src/dexter.js"
echo "  □ 텔레그램 발송 테스트:"
echo "      node -e \"require('./packages/core/lib/telegram-sender').send('general', '맥미니 연결 확인')\""
echo "  □ PostgreSQL 연결 테스트: node -e \"require('./packages/core/lib/pg-pool').query('claude','SELECT 1').then(console.log)\""
echo "  □ 스카팀 상태 확인: node bots/claude/scripts/team-status.js"
echo "  □ 최소 48시간 병렬 운영 후 전환"
echo ""

# ── Phase D: 최종 전환 ────────────────────────────────────────────
echo "=== Phase D: 최종 전환 (새벽 02:00 KST 권장) ==="
echo "  □ 맥북 OPS 서비스 중단:"
echo "      launchctl bootout gui/\$(id -u) scripts/launchd/*.plist"
echo "  □ 최종 DB 백업 + 맥미니로 전송"
echo "  □ 맥미니 launchd 서비스 등록:"
echo "      cd scripts/launchd && bash install.sh"
echo "  □ 전체 헬스체크: node bots/claude/src/dexter.js"
echo "  □ 텔레그램 포럼 전송 테스트 (6개 Topic)"
echo "  □ 루나팀 PAPER 모드 24시간 검증 후 OPS 전환"
echo "  □ 24시간 집중 모니터링 (덱스터 퀵체크 5분 주기)"
echo ""
echo "══════════════════════════════════════════════"

# ── 자동 검증 모드 ────────────────────────────────────────────────
if [ "$VERIFY" = "--verify" ]; then
  echo ""
  echo "🔍 현재 환경 자동 검증..."
  echo ""

  pass=0; fail=0

  check() {
    local desc="$1"; local cmd="$2"
    if eval "$cmd" &>/dev/null; then
      echo "  ✅ $desc"; ((pass++))
    else
      echo "  ❌ $desc"; ((fail++))
    fi
  }

  check "Node.js v24"         "node -e 'process.exit(parseInt(process.version.slice(1))>=24?0:1)'"
  check "Python 3.12"         "python3 --version 2>&1 | grep -q '3\.12'"
  check "PostgreSQL 실행 중"  "pg_isready -d jay -q"
  check "jay DB 존재"         "psql jay -c 'SELECT 1' -q"
  check "claude 스키마"       "psql jay -c 'SELECT 1 FROM claude.agent_state LIMIT 1' -q"
  check "reservation 스키마"  "psql jay -c 'SELECT 1 FROM reservation.reservations LIMIT 1' -q"
  check "investment 스키마"   "psql jay -c 'SELECT 1 FROM investment.trades LIMIT 1' -q"
  check "secrets.json 존재"   "[ -f bots/reservation/secrets.json ]"
  check "secrets.json 권한"   "[ \"\$(stat -f '%A' bots/reservation/secrets.json 2>/dev/null || stat -c '%a' bots/reservation/secrets.json)\" = '600' ]"
  check "Hub health"          "curl -s http://127.0.0.1:18789/hub/health &>/dev/null || nc -z 127.0.0.1 18789"
  check "npm install 완료"    "[ -d node_modules ]"
  check "ska venv 존재"       "[ -d bots/ska/venv ]"

  echo ""
  echo "검증 결과: ✅ ${pass}건 통과 | ❌ ${fail}건 실패"
  [ "$fail" -gt 0 ] && exit 1 || exit 0
fi
