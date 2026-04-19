#!/bin/bash
# Hub LLM 전체 부하 테스트 실행 스크립트
# 사용법: bash tests/load/run-all.sh [--skip-chaos]
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RESULTS_DIR="${PROJECT_ROOT}/results/load-$(date +%Y%m%d-%H%M)"
HUB_URL="${HUB_URL:-http://localhost:7788}"

mkdir -p "${RESULTS_DIR}"
echo "결과 저장 경로: ${RESULTS_DIR}"

check_k6() {
  if ! command -v k6 &>/dev/null; then
    echo "k6 미설치. 설치: brew install k6"
    exit 1
  fi
}

run_scenario() {
  local name=$1
  local script=$2
  echo ""
  echo "===== [${name}] ====="
  k6 run \
    --out json="${RESULTS_DIR}/${name}.json" \
    --env HUB_URL="${HUB_URL}" \
    --env HUB_AUTH_TOKEN="${HUB_AUTH_TOKEN:-}" \
    "${SCRIPT_DIR}/${script}"
}

check_k6

run_scenario "baseline" "baseline.js"
run_scenario "peak" "peak.js"

if [[ "$1" != "--skip-chaos" ]]; then
  echo ""
  echo "===== [chaos] — Ollama 중단 후 시작 ====="
  echo "⚠️  MLX/Ollama를 중단해주세요 (pkill -f ollama 또는 launchctl unload)"
  echo "   30초 후 자동 시작..."
  sleep 30
  run_scenario "chaos" "chaos.js"
  echo "✅ Ollama를 다시 시작해주세요"
fi

run_scenario "multi-team" "multi-team.js"

echo ""
echo "===== 결과 분석 ====="
cd "${PROJECT_ROOT}"
npx ts-node tests/load/analyze-results.ts "${RESULTS_DIR}" || true

echo ""
echo "✅ 부하 테스트 완료. 결과: ${RESULTS_DIR}"
