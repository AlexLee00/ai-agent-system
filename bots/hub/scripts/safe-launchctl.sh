#!/usr/bin/env bash
# safe-launchctl.sh — PROTECTED launchd 서비스 실수 중단 방지 래퍼
#
# 사용법: safe-launchctl.sh [launchctl 인자...]
#   stop unload kill bootout 명령이 PROTECTED 서비스에 사용될 경우 차단.
#
# 설치 (OPS 맥 스튜디오에서 한 번):
#   sudo ln -sf /Users/alexlee/projects/ai-agent-system/bots/hub/scripts/safe-launchctl.sh /usr/local/bin/safe-launchctl
#   chmod +x /Users/alexlee/projects/ai-agent-system/bots/hub/scripts/safe-launchctl.sh

set -euo pipefail

PROTECTED_PREFIXES=(
  "ai.hub."
  "ai.ska."
  "ai.luna."
  "ai.investment."
  "ai.claude."
  "ai.elixir."
)

DESTRUCTIVE_CMDS=(stop unload kill bootout)

CMD="${1:-}"
shift || true

# 위험 명령 여부 확인
is_destructive=false
for dc in "${DESTRUCTIVE_CMDS[@]}"; do
  if [[ "$CMD" == "$dc" ]]; then
    is_destructive=true
    break
  fi
done

if $is_destructive; then
  for arg in "$@"; do
    for prefix in "${PROTECTED_PREFIXES[@]}"; do
      if [[ "$arg" == "${prefix}"* ]]; then
        echo "🛡️  [safe-launchctl] BLOCKED: '$CMD $arg'" >&2
        echo "   PROTECTED 서비스는 직접 중단 불가." >&2
        echo "   대상 네임스페이스: ai.hub.* / ai.ska.* / ai.luna.* / ai.investment.* / ai.claude.* / ai.elixir.*" >&2
        echo "   마스터(Alex) 승인 후 직접 launchctl 사용. CLAUDE.md 절대 규칙 참조." >&2
        exit 1
      fi
    done
  done
fi

exec launchctl "$CMD" "$@"
