#!/bin/zsh
# Stop Hook — HANDOFF 최신 여부 확인 (6시간 이내 업데이트 체크)
# Always exit 0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
HANDOFF="$REPO_ROOT/docs/OPUS_FINAL_HANDOFF.md"
echo "[Stop][handoff-verify] ══════════════════════════════" >&2
if [[ ! -f "$HANDOFF" ]]; then
  echo "[Stop][handoff-verify] ⚠️  HANDOFF 파일 없음: docs/OPUS_FINAL_HANDOFF.md" >&2
  echo "[Stop][handoff-verify] → 세션 종료 전 HANDOFF 작성 필요!" >&2
  echo "[Stop][handoff-verify] ══════════════════════════════" >&2
  exit 0
fi
# 마지막 수정 시간 확인 (macOS stat)
mod_epoch="$(stat -f %m "$HANDOFF" 2>/dev/null || stat -c %Y "$HANDOFF" 2>/dev/null || echo 0)"
now_epoch="$(date +%s)"
diff_hours=$(( (now_epoch - mod_epoch) / 3600 ))
if [[ "$diff_hours" -gt 6 ]]; then
  echo "[Stop][handoff-verify] ⚠️  HANDOFF 마지막 업데이트: ${diff_hours}시간 전" >&2
  echo "[Stop][handoff-verify] → 세션 종료 전 HANDOFF 업데이트 권장!" >&2
else
  echo "[Stop][handoff-verify] ✅ HANDOFF 최근 업데이트: ${diff_hours}시간 전" >&2
fi
# uncommitted 변경 확인
uncommitted="$(git -C "$REPO_ROOT" status --short 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$uncommitted" -gt 0 ]]; then
  echo "[Stop][handoff-verify] ⚠️  미커밋 변경 ${uncommitted}개 — git commit + push 권장" >&2
fi
echo "[Stop][handoff-verify] ══════════════════════════════" >&2
exit 0
