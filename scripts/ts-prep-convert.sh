#!/bin/bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "사용법: bash scripts/ts-prep-convert.sh <디렉토리...>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COUNT=0
SKIP=0

convert_file() {
  local jsfile="$1"
  local base="${jsfile%.js}"
  local tsfile="${base}.ts"
  local legacyfile="${base}.legacy.js"

  if [ -f "$tsfile" ] || [ -f "${base}.tsx" ]; then
    echo "  SKIP (이미 TS): ${jsfile#$REPO_ROOT/}"
    SKIP=$((SKIP + 1))
    return
  fi

  if [ -f "$legacyfile" ]; then
    echo "  SKIP (이미 .legacy): ${jsfile#$REPO_ROOT/}"
    SKIP=$((SKIP + 1))
    return
  fi

  cp "$jsfile" "$legacyfile"

  {
    echo '// @ts-nocheck'
    cat "$legacyfile"
  } > "$tsfile"

  local relpath="${jsfile#$REPO_ROOT/}"
  local distpath="$REPO_ROOT/dist/ts-runtime/$relpath"
  local jsdir
  jsdir="$(dirname "$jsfile")"
  local reldist
  reldist="$(python3 -c 'import os.path, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$distpath" "$jsdir")"
  local legacyname
  legacyname="$(basename "$legacyfile")"

  cat > "$jsfile" <<WRAPPER
'use strict';

const path = require('path');
const runtimePath = path.join(
  __dirname,
  '${reldist}'
);

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
  module.exports = require('./${legacyname}');
}
WRAPPER

  COUNT=$((COUNT + 1))
  echo "  ✅ ${jsfile#$REPO_ROOT/} → .ts + .legacy.js + 래퍼"
}

for target in "$@"; do
  if [ ! -d "$REPO_ROOT/$target" ]; then
    echo "대상 디렉터리 없음: $target" >&2
    exit 1
  fi

  echo "=== TS 사전 전환: $target ==="
  while IFS= read -r -d '' jsfile; do
    convert_file "$jsfile"
  done < <(
    find "$REPO_ROOT/$target" -type f -name '*.js' \
      -not -name '*.legacy.js' \
      -not -path '*/node_modules/*' \
      -not -path '*/dist/*' \
      -not -path '*/.next/*' \
      -not -path '*/venv/*' \
      -print0 | sort -z
  )
  echo ""
done

echo "=== 완료: ${COUNT}개 전환 / ${SKIP}개 스킵 ==="
