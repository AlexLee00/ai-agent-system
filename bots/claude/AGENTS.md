# AGENTS.md — 클로드팀 (모니터링·자율 리팩터)

> 이 파일은 OpenAI Codex·Claude Code가 클로드팀(bots/claude) 작업 시 읽는 가이드다.
> 상위 규칙 상속: 루트 AGENTS.md(세션 규칙) + ~/.codex/AGENTS.md(Lean Mode). 본 파일은 클로드팀 특화 컨텍스트만 추가한다.

## 역할 경계 (불변)
- **메티(Claude app)** = 전략·설계·코드점검·독립검증. 코드 직접 수정 금지.
- **코덱스(OpenAI Codex)** = 명세 기반 구현.
- **마스터(제이)** = 승인·git commit·launchctl·DB write. 마스터 전용.
- 절차: 메티 설계 → 코덱스 구현 → 메티 검증 → 마스터 승인.

## ★ 절대 무중단 (PROTECTED)
- launchd `ai.claude.*` (refactor-mcp 등) 직접 중지 금지.
- 클로드팀은 **시스템 모니터링 담당** — 닥터 복구·덱스터 감지가 멈추면 전체 시스템 감시 공백. 무중단.

## 팀 구조
```
클로드(팀장)
  [감지] 덱스터(dexter) — 22개 체크 시스템 점검
  [인텔] 아처 — 기술 인텔리전스
  [복구] 닥터 — L1 재시작 + L2 설정 + L3 코드패치
  [리팩터] 리팩터(refactorer) — 기술부채 분석 + @ts-nocheck 복구 + 대형파일 분할
  [예정] 리뷰어·가디언(보안6계층)·빌더(배포)
```

## 핵심 파일
- **src/**: dexter.js, dexter-quickcheck.js
- **lib/checks/**: bots.js, resources.js, database.js, n8n.js, patterns.js
- **lib/**: team-bus.js, config.js
- **리팩터 (2026-05 신설)**: scripts/refactor-cycle-runner.ts(자율 리팩터 사이클, shadow analyze+plan, 오류피드백 학습, PROTECTED 가드), agents/refactorer.md
- **MCP (port 8774)**: mcp/claude-refactor-mcp/src/server.ts (5도구: analyze_tech_debt/suggest_refactoring/split_large_file/restore_types/verify_refactoring)
- **하네스**: lib/refactor-harness/plugin-eval.ts (3계층 Static/LLM Judge/Monte Carlo)
- **훅 6계층**: hooks/refactor-hooks/ (pre-refactor/type-check/test-green/complexity/dependency/verify-loop)
- **A2A**: a2a/skills/refactor-analysis.ts

## 현재 상태
- 운영 안정 + 리팩터 에이전트 신설 완료.
- refactor-cycle-runner.ts: shadow mode (analyze+plan만, 자동적용 OFF). Prior failures 학습 내장.

## 운영 주의
- **shadow 우선**: 리팩터 자동수정은 shadow→검증→마스터 승인. REFACTORER_APPLY_ENABLED 등 기본 OFF.
- **PROTECTED 가드**: refactor-cycle-runner는 ai.{ska,luna,...} 보호 대상을 리팩터 후보에서 자동 제외. 이 가드 유지 필수.
- **모니터링 무중단**: 덱스터 22체크·닥터 복구는 시스템 안정의 핵심. 변경 시 신중.

## 공용 유틸 강제 (신규 코드 필수)
- 시간: packages/core/lib/kst.js | DB: packages/core/lib/pg-pool.js (또는 Hub)
- LLM: packages/core/lib/llm-fallback.js | RAG: packages/core/lib/rag.js
- launchd: StartCalendarInterval은 KST 기준

## 구현 하네스
1. Karpathy 4원칙 (Lean Mode 상속): 최소 변경, 기존 패턴 우선, surgical, 검증 가능 성공기준.
2. 검증 루프: node --check → npx tsc --noEmit -p [tsconfig] → smoke. 실패 시 3회 자동수정, 3회 실패 시 마스터 보고.
3. 미검증 "완료" 금지.

## 참조: docs/strategy/TECH_DEBT_INVENTORY.md | Claude Forge 패턴(/plan→/tdd→/code-review→/verify-loop)
