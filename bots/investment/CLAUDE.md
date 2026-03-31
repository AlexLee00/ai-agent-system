# 루나팀 — Claude Code 컨텍스트

## 팀 구조 (11 에이전트)
아르고스(스크리닝) → 아리아(기술) + 소피아(감성) + 헤르메스(뉴스) + 오라클(온체인)
→ 루나(팀장, 종합판단) → 네메시스(리스크) → 헤파이스토스(바이낸스)/한울(국내외)
크로노스(백테스팅), 제우스/아테나(조건부)

## 핵심 파일
- team/luna.js(963줄), nemesis.js(954줄), chronos.js(346줄)
- shared/db.js(906줄), capital-manager.js(466줄), pipeline-decision-runner.js(489줄)
- shared/ohlcv-fetcher.js(175줄), ta-indicators.js(61줄)
- packages/core/lib/local-llm-client.js(116줄) — MLX 공용

## 현재 상태
- 실투자 운영 중 (crypto LIVE, domestic/overseas MOCK)
- Chronos Phase A 완료: Layer 1 동작, Layer 2~3 LLM 검증 대기
- MLX: qwen2.5-7b(Layer 2) + deepseek-r1-32b(Layer 3) on_demand

## 전략: docs/strategy/luna.md | 개발: docs/dev/luna.md
## 코덱스: docs/codex/CODEX_CHRONOS_PHASE_A_*.md
