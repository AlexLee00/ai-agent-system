# PLAN.md — 다윈팀 개발 계획

> 최종 업데이트: 2026-04-18 (40차 세션)

## Phase 완료 현황

| Phase | 내용 | 상태 | 완료일 |
|-------|------|------|--------|
| 0 | 독립 구조 (bots/darwin/elixir/) + Kill Switch | ✅ | 2026-04-18 |
| 1 | LLM Selector + CostTracker + RoutingLog | ✅ | 2026-04-18 |
| 2 | Memory L1(ETS) + L2(pgvector) + AutonomyLevel | ✅ | 2026-04-18 |
| 3 | Reflexion + SelfRAG + ESPL + Principle Loader | ✅ | 2026-04-18 |
| 4 | Commander (Jido.AI.Agent) + Skill 3개 + Cycle 7개 | ✅ | 2026-04-18 |
| 5 | MCP Server + Signal + DB 마이그레이션 | ✅ | 2026-04-18 |
| 6 | Shadow Mode (V1 TS vs V2 비교) | 🔶 예정 | - |
| 7 | 커뮤니티 스캐너 (HN/Reddit/Twitter) | 🔶 예정 | - |
| 8 | 테스트 확장 (2개 → 50+) | 🔶 예정 | - |
| 9 | TeamJay.Darwin → Darwin.V2 점진적 위임 | 🔶 예정 | - |

## 아키텍처 결정 (마스터 2026-04-18)

1. **이름**: "다윈팀" + "에디슨" 유지
2. **독립 구조**: bots/darwin/elixir/ (Sigma 패턴 동일)
3. **LLM**: Claude 전용 (Anthropic API, 로컬 MLX 제외)
4. **Jido**: Commander만 Jido.AI.Agent, Cycle은 GenServer
5. **Kill Switch**: 7개 독립 환경변수로 단계적 활성화

## 다음 세션 우선 작업

1. `mix compile --warnings-as-errors` 검증
2. Phase 6: Shadow Mode 구현
3. Phase 8: 테스트 50개 목표
4. DARWIN_V2_ENABLED=true 단계적 활성화

## 기술 부채

- Commander.on_before_run/on_after_run: Jido.AI.Agent 실제 콜백 시그니처 검증 필요
- Cycle GenServer: 각 단계별 실제 비즈니스 로직 구현 필요 (현재 scaffold)
- AutonomyLevel: TeamJay.Darwin.TeamLead와 이중 관리 → V2로 통합 예정
