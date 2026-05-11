#!/bin/zsh
# Luna PostToolUse Hook — 매매 후 Reflexion L1 트리거 + Telegram 알림
# stdin: JSON {"tool_name":"Bash","tool_input":{...},"tool_response":{...}}
# 항상 exit 0 (PostToolUse는 차단 불가)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

input="$(cat)"
command_str="$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null || echo "")"

# 루나 실행 명령에만 반응
if ! echo "$command_str" | grep -qE '(luna|investment|hephaestos|order|trade|binance|upbit|kis)'; then
  exit 0
fi

echo "[Luna][PostToolUse] 매매 후 피드백 트리거..." >&2

# bots/investment/shared/db.ts 변경 또는 trade 명령 감지 시 Reflexion 트리거
HUB_URL="${HUB_URL:-http://localhost:7788}"
if command -v curl &>/dev/null; then
  curl -sf --max-time 5 -X POST "$HUB_URL/api/luna/reflexion/trigger" \
    -H "Content-Type: application/json" \
    -d "{\"source\":\"posttooluse_hook\",\"command\":$(echo "$command_str" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null || echo '""')}" \
    >/dev/null 2>&1 || true
fi

exit 0
