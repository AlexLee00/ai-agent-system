#!/bin/bash
# scripts/sync-dev-secrets.sh
# OPS(맥 스튜디오)에서 DEV(맥북 에어)로 시크릿/설정 파일을 안전하게 동기화

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }

PROJECT_DIR="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"
OPS_HOST="${OPS_HOST:-mac-studio}"
OPS_PROJECT="${OPS_PROJECT:-~/projects/ai-agent-system}"

echo ""
echo "🔄 팀 제이 — DEV 시크릿 동기화"
echo "   OPS (${OPS_HOST}) → DEV (로컬)"
echo ""

echo "[ 0 ] SSH 접속 확인"
if ! ssh -o ConnectTimeout=5 "$OPS_HOST" "echo ok" >/dev/null 2>&1; then
  fail "${OPS_HOST} 접속 불가 — SSH 설정 또는 Tailscale 확인"
fi
ok "${OPS_HOST} 접속 확인"

echo "[ 1 ] OPS에서 시크릿/설정 파일 복사"
FILES=(
  "bots/reservation/secrets.json"
  "bots/investment/config.yaml"
  "bots/reservation/config.yaml"
  "bots/blog/config.json"
  "bots/claude/config.json"
  "bots/ska/config.json"
  "bots/orchestrator/config.json"
)

COPIED=0
for file in "${FILES[@]}"; do
  mkdir -p "$PROJECT_DIR/$(dirname "$file")"
  if scp -q "${OPS_HOST}:${OPS_PROJECT}/${file}" "$PROJECT_DIR/$file" 2>/dev/null; then
    ok "복사: $file"
    COPIED=$((COPIED+1))
  else
    warn "복사 실패 (파일 없음?): $file"
  fi
done
echo "  ${COPIED}/${#FILES[@]} 파일 복사 완료"

echo ""
echo "[ 2 ] 투자 설정 DEV 패치 (paper 모드)"
INV_YAML="$PROJECT_DIR/bots/investment/config.yaml"
if [ -f "$INV_YAML" ]; then
  python3 - "$INV_YAML" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace('trading_mode: live', 'trading_mode: paper')
text = text.replace('paper_mode: false', 'paper_mode: true')
text = text.replace('  testnet: false', '  testnet: true')
path.write_text(text)
PY
  TM=$(grep "^trading_mode:" "$INV_YAML" | head -1 || true)
  PM=$(grep "^paper_mode:" "$INV_YAML" | head -1 || true)
  BT=$(grep "^  testnet:" "$INV_YAML" | head -1 || true)
  if echo "$TM" | grep -q "paper" && echo "$PM" | grep -q "true"; then
    ok "config.yaml: $TM, $PM, ${BT:-testnet 미검출}"
  else
    warn "config.yaml 패치 불완전: ${TM:-없음} / ${PM:-없음} / ${BT:-없음}"
  fi
else
  warn "config.yaml 없음 — 투자 설정 수동 확인 필요"
fi

echo ""
echo "[ 3 ] OPS 전용 키 마스킹"
RSV_SECRETS="$PROJECT_DIR/bots/reservation/secrets.json"
if [ -f "$RSV_SECRETS" ]; then
  node - "$RSV_SECRETS" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const mask = [
  'naver_id', 'naver_pw',
  'pickko_id', 'pickko_pw',
  'naver_url', 'pickko_url',
  'db_encryption_key', 'db_key_pepper',
  'datagokr_holiday_key', 'datagokr_weather_key',
  'datagokr_neis_key', 'datagokr_festival_key',
];
let count = 0;
for (const key of mask) {
  if (Object.prototype.hasOwnProperty.call(data, key)) {
    data[key] = '';
    count++;
  }
}
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log(`  마스킹 완료: ${count}개 키`);
NODE
  ok "reservation/secrets.json 마스킹"
else
  warn "reservation/secrets.json 없음"
fi
echo ""
echo "[ 4 ] 파일 권한 설정"
find "$PROJECT_DIR/bots" -name "secrets.json" -not -path "*/node_modules/*" -exec chmod 600 {} \; 2>/dev/null || true
ok "secrets.json → 600"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ DEV 시크릿 동기화 완료${NC}"
echo ""
echo "  적용된 전략:"
echo "    티어 1 (Hub 프록시): DB/n8n 키 불필요"
echo "    티어 2 (공유): LLM API 키, Telegram 그대로 복사"
echo "    티어 3 (DEV 패치): trading_mode=paper, testnet=true"
echo "    티어 4 (마스킹): Naver/Pickko/DB암호화 → 빈값"
echo ""
if [ -f "$INV_YAML" ]; then
  echo "  investment/config.yaml:"
  grep -E "^(trading_mode|paper_mode)" "$INV_YAML" | sed 's/^/    /'
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
