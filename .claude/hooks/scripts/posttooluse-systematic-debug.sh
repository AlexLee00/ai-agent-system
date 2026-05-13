#!/bin/zsh
# PostToolUse Hook — Bash 실패 감지 → systematic-debugging 제안
# Always exit 0 (post-tool hooks cannot block)

INPUT="$(cat)"

exit_code="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('output',{}).get('exitCode', d.get('exitCode', 0)))" 2>/dev/null || echo "0")"

if [[ "$exit_code" != "0" && "$exit_code" != "" ]]; then
  tool_name="$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null || echo "")"
  echo "[PostToolUse][debug] 에러 감지 (exit=$exit_code, tool=$tool_name)"
  echo "[PostToolUse][debug] → /systematic-debugging 스킬로 4단계 디버깅 권장"
fi

exit 0
