# Darwin Team — Team Jay의 자율 R&D 에이전트

다윈팀은 최신 AI 연구를 자율적으로 탐색·평가·구현·적용하는 R&D 자율화 시스템입니다. 현재 live는 `L5 완전자율 + 주 1회 cadence` 기준으로 운영됩니다.

## 빠른 시작

```bash
# V2 Elixir (독립 진입점)
cd bots/darwin/elixir
mix compile && mix test

# JS/TS 레거시 브리지
node bots/darwin/scripts/research-task-runner.ts
```

## 7단계 자율 사이클

```
DISCOVER → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN
  (arXiv)  (LLM점수)  (Graft) (Edison)  (Proof-R) (L5↑)  (RAG+ESPL)
```

## 디렉토리 구조

```
bots/darwin/
├ elixir/lib/darwin/v2/    ← V2 Elixir 코어 (독립 앱)
│  ├ supervisor.ex
│  ├ llm/                  ← Selector + CostTracker + RoutingLog
│  ├ memory/               ← L1 세션 + L2 pgvector
│  ├ cycle/                ← 7단계 사이클
│  ├ reflexion.ex          ← 자기 회고
│  ├ self_rag.ex           ← 4-gate 검색
│  ├ espl.ex               ← 프롬프트 진화
│  ├ principle/            ← Constitutional 원칙
│  ├ community_scanner.ex  ← HN/Reddit 시그널
│  ├ shadow_runner.ex      ← 과거 V1/V2 병렬 비교 (참고용)
│  ├ signal_receiver.ex    ← Sigma advisory 구독
│  └ mcp/                  ← MCP Server
├ lib/                     ← V1 TypeScript (레거시 유지)
├ migrations/              ← DB 마이그레이션 4개
├ config/                  ← darwin_principles.yaml
└ sandbox/                 ← 실험 결과물 (gitignored)
```

## 자율 레벨

| 레벨 | 조건 | 권한 |
|------|------|------|
| L3 | 기본 | 제안서/수동 승인 |
| L4 | 5회 성공 + 7일 | 구현 자동, 적용 전 승인 |
| L5 | 10회 성공 + 3회 적용 + 14일 + DARWIN_L5_ENABLED | 정상 경로 자동 통합 |

## 현재 live 운영

- 자율 레벨: `L5`
- Kill Switch: `false`
- Shadow Mode: `false`
- 알림: 정상 경로는 공용 `postAlarm`, 예외만 수동 버튼
- 스케줄:
  - 메인 Darwin 실행 (`ai.darwin.weekly.autonomous`): 일요일 05:00
  - 운영 리포트: 일요일 06:30
  - 주간 리뷰: 일요일 19:00

## 관련 문서

- [AGENTS.md](./AGENTS.md) — 에이전트 명세
- [SOUL.md](./SOUL.md) — 7원칙
- [HEARTBEAT.md](./HEARTBEAT.md) — 헬스체크
