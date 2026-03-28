#!/bin/bash
# start-dexter.sh — 덱스터 시작 스크립트 (launchd에서 호출)

cd "$(dirname "$0")/.." || exit 1

NODE="$(which node)"
if [ -z "$NODE" ]; then
  NODE="/opt/homebrew/bin/node"
fi

# 인수 전달 ($@ → --full, --telegram, --fix 등)
exec "$NODE" src/dexter.js "$@"
