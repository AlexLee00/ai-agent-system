#!/bin/bash
# scripts/daily-llm-check.sh — 매일 09:30 KST 실행
# 1. LLM 속도 테스트 → 가장 빠른 Gemini로 primary 자동 교체
# 2. 사용량 리포트 텔레그램 전송

set -e

NODE="/Users/alexlee/.nvm/versions/node/v24.13.1/bin/node"
ROOT="/Users/alexlee/projects/ai-agent-system"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 속도 테스트 시작 (스카팀 + 루나팀)"
$NODE "$ROOT/scripts/speed-test.js" --apply --luna --telegram --runs=2

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 사용량 리포트 전송"
$NODE "$ROOT/scripts/api-usage-report.js" --telegram

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 완료"
