# 클로드팀 — Claude Code 컨텍스트

## 팀 구조
클로드(팀장)
  [운영] 덱스터 — 22개 체크 시스템 점검 (감지)
  [운영] 아처 — 기술 인텔리전스
  [운영+강화] 닥터 — 복구 전문가 (L1 재시작 + L2 설정 + L3 코드패치)
  [신설] 리팩터 — 기술부채 분석 + @ts-nocheck 복구 + 대형 파일 분할
  [신설 예정] 리뷰어 — 코드 리뷰 자동화
  [신설 예정] 가디언 — 보안 분석 (6계층)
  [신설 예정] 빌더 — 빌드/배포 자동화 (워커 Next.js + npm)

## 핵심 파일
- src/dexter.js, dexter-quickcheck.js
- lib/checks/bots.js, resources.js, database.js, n8n.js, patterns.js
- lib/team-bus.js, config.js

## 리팩터 에이전트 (신설 2026-05-28)
- 정의: `agents/refactorer.md`
- MCP (port 8774): `mcp/claude-refactor-mcp/src/server.ts` — 5개 도구
  (analyze_tech_debt / suggest_refactoring / split_large_file / restore_types / verify_refactoring)
- 하네스: `lib/refactor-harness/plugin-eval.ts` — 3계층 (Static/LLM Judge/Monte Carlo)
- 훅 6계층: `hooks/refactor-hooks/` — pre-refactor/type-check/test-green/complexity/dependency/verify-loop
- A2A: `a2a/skills/refactor-analysis.ts` — refactor-analysis 스킬
- 전략: `docs/strategy/TECH_DEBT_INVENTORY.md`
- launchd: `launchd/ai.claude.refactor-mcp.plist`

## 참고: Claude Forge 패턴 (github.com/sangrokjung/claude-forge)
- /plan→/tdd→/code-review→/handoff-verify→/commit-push-pr 파이프라인
- 6계층 보안 훅 패턴
- /verify-loop 자동 수정 재시도 패턴

## 현재 상태: 운영 안정 + 리팩터 에이전트 신설 완료
