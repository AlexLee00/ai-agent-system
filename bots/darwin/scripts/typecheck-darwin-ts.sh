#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

cd "$ROOT_DIR"
./node_modules/.bin/tsc -p "$ROOT_DIR/bots/darwin/tsconfig.json" --noEmit
