#!/bin/bash
set -euo pipefail

TARGET_DIR="${1:?사용법: bash scripts/luna-ts-convert.sh <디렉토리>}"
COUNT=0
SKIP=0

echo "=== 루나팀 TS 실전환: $TARGET_DIR ==="

while IFS= read -r legacyfile; do
  base="${legacyfile%.legacy.js}"
  tsfile="${base}.ts"

  if [ ! -f "$tsfile" ]; then
    echo "  SKIP (no .ts): $legacyfile"
    SKIP=$((SKIP + 1))
    continue
  fi

  tslines=$(wc -l < "$tsfile" | tr -d ' ')
  if [ "$tslines" -gt 5 ]; then
    echo "  SKIP (already converted, ${tslines}줄): $tsfile"
    SKIP=$((SKIP + 1))
    continue
  fi

  first_line="$(head -n 1 "$legacyfile" || true)"
  if [ "$first_line" = "#!/usr/bin/env node" ]; then
    {
      echo "#!/usr/bin/env node"
      echo "// @ts-nocheck"
      tail -n +2 "$legacyfile"
    } > "$tsfile"
  else
    {
      echo "// @ts-nocheck"
      cat "$legacyfile"
    } > "$tsfile"
  fi

  COUNT=$((COUNT + 1))
  echo "  ✅ $tsfile ($(wc -l < "$tsfile" | tr -d ' ')줄)"
done < <(find "$TARGET_DIR" -maxdepth 1 -name "*.legacy.js" | sort)

echo ""
echo "=== 전환 완료: ${COUNT}개 / 스킵: ${SKIP}개 ==="
