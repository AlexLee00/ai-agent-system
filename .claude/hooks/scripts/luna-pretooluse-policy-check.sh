#!/bin/zsh
# Luna PreToolUse Hook — 매매 명령 실행 전 정책 검증 (7중 안전 가드 #7)
# stdin: JSON {"tool_name":"Bash","tool_input":{"command":"..."}}
# exit 0 = 허용 / exit 2 = 차단

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

input="$(cat)"
command_str="$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")"

# 루나 관련 명령어가 아니면 즉시 통과
if ! echo "$command_str" | grep -qE '(luna|investment|hephaestos|order|trade|binance|upbit|kis)'; then
  exit 0
fi

echo "[Luna][PreToolUse] 매매 정책 검증 중..." >&2

# Kill Switch 확인
CANONICAL_KILL_SWITCH_FILE="$REPO_ROOT/bots/investment/data/kill-switch.json"
if [[ "${LUNA_HOOK_TEST_MODE:-false}" == "true" && -n "${LUNA_HOOK_KILL_SWITCH_FILE:-}" ]]; then
  KILL_SWITCH_FILE="$LUNA_HOOK_KILL_SWITCH_FILE"
else
  KILL_SWITCH_FILE="$CANONICAL_KILL_SWITCH_FILE"
fi
if [[ -f "$KILL_SWITCH_FILE" ]]; then
  kill_active="$(python3 -c "import sys,json; d=json.load(open('$KILL_SWITCH_FILE')); print(d.get('active', False))" 2>/dev/null || echo "false")"
  if [[ "$kill_active" == "True" || "$kill_active" == "true" ]]; then
    echo "[Luna][PreToolUse] ❌ Kill Switch 활성! 모든 매매 차단." >&2
    echo "BLOCKED: Luna kill switch is active. Deactivate before trading."
    exit 2
  fi
fi

# 일일 손실 한도 확인 (Hub API — 미가동 시 스킵)
HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  daily_loss="$(curl -sf --max-time 3 "$HUB_URL/api/luna/daily-loss" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('loss_pct',0.0))" 2>/dev/null || echo "0.0")"
  max_daily_loss=5.0
  exceeds="$(python3 -c "print('yes' if float('$daily_loss') >= $max_daily_loss else 'no')" 2>/dev/null || echo "no")"
  if [[ "$exceeds" == "yes" ]]; then
    echo "[Luna][PreToolUse] ❌ 일일 손실 한도 초과! loss=${daily_loss}% >= ${max_daily_loss}%" >&2
    echo "BLOCKED: Daily loss limit exceeded (${daily_loss}% >= ${max_daily_loss}%)."
    exit 2
  fi
fi

echo "[Luna][PreToolUse] ✅ 정책 검증 통과" >&2
exit 0
