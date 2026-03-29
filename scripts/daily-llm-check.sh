#!/bin/bash
# scripts/daily-llm-check.sh — 매일 09:30 KST 실행
# 1. LLM 속도 테스트 → 결과 보고 (적용은 마스터가 수동 결정)
# 2. 사용량 리포트 텔레그램 전송

set -e

NODE="/opt/homebrew/bin/node"
ROOT="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 속도 테스트 시작"
$NODE "$ROOT/scripts/speed-test.js" --telegram --runs=2

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 사용량 리포트 전송"
$NODE "$ROOT/scripts/api-usage-report.js" --telegram

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 완료"
