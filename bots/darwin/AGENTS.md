# AGENTS.md — 다윈팀 에이전트 정의

## Commander (Darwin.V2.Commander)

**타입**: Jido.AI.Agent  
**역할**: 7단계 R&D 사이클 총괄 오케스트레이터  
**스킬**: EvaluatePaper, PlanImplementation, LearnFromCycle  
**LLM**: claude-sonnet-4-6 (evaluator/planner), claude-haiku-4-5-20251001 (learner)  
**트리거**: 논문 발견 이벤트 (JayBus `darwin.paper_discovered`)  

```elixir
Darwin.V2.Commander.on_paper_discovered(paper)
Darwin.V2.Commander.run_cycle(paper)
Darwin.V2.Commander.status()
```

## Cycle GenServers (Darwin.V2.Cycle.*)

7단계 각각 독립 GenServer. DARWIN_CYCLE_ENABLED=true 시 활성화.

| 단계 | 모듈 | 역할 |
|-----|------|------|
| DISCOVER | Darwin.V2.Cycle.Discover | 멀티소스 논문/커뮤니티 스캔 |
| EVALUATE | Darwin.V2.Cycle.Evaluate | LLM 기반 적합성 평가 |
| PLAN | Darwin.V2.Cycle.Plan | 구현 계획 수립 |
| IMPLEMENT | Darwin.V2.Cycle.Implement | 에디슨 코드 생성 트리거 |
| VERIFY | Darwin.V2.Cycle.Verify | Proof-R 검증 실행 |
| APPLY | Darwin.V2.Cycle.Apply | L5 정상 경로 자동 통합 |
| LEARN | Darwin.V2.Cycle.Learn | RAG 적재 + ESPL 진화 |

## 스킬 (Darwin.V2.Skill.*)

| 스킬 | 입력 | 출력 |
|-----|------|------|
| EvaluatePaper | title, abstract, source | score, implementable, summary_ko |
| PlanImplementation | title, score, summary_ko | goal, target_path, changes, verification |
| LearnFromCycle | cycle_id, outcome, metrics | learned, reflected, autonomy_updated |

## 인프라 에이전트

| 모듈 | 역할 | 트리거 |
|-----|------|-------|
| Darwin.V2.KillSwitch | 기능 On/Off 제어 | 환경변수 |
| Darwin.V2.AutonomyLevel | L3/L4/L5 상태 관리 | 성공/실패 이벤트 |
| Darwin.V2.Memory.L1 | ETS 세션 메모리 | 직접 호출 |
| Darwin.V2.Memory.L2 | pgvector 장기 메모리 | Jido.Action |
| Darwin.V2.Reflexion | 실패 반성 생성 | 실패 이벤트 |
| Darwin.V2.SelfRAG | 4-gate 자기 검색 | DARWIN_SELF_RAG_ENABLED |
| Darwin.V2.ESPL | 프롬프트 주간 진화 | DARWIN_ESPL_ENABLED |
| Darwin.V2.Principle.Loader | 연구 원칙 로드 + 자기비판 | Commander.on_before_run |
| Darwin.V2.LLM.Selector | LLM 라우팅 | call_with_fallback/3 |
| Darwin.V2.LLM.CostTracker | 일일 예산 추적 | track_tokens/1 |
| Darwin.V2.LLM.RoutingLog | 라우팅 기록 | record/1 |
| Darwin.V2.Signal | CloudEvents 발행 | emit/3 |
| Darwin.V2.MCP.Server | HTTP REST API | DARWIN_HTTP_PORT |

## 현재 live 운영 메모

- `Commander`와 JS 레거시 브리지는 현재 `L5` 정책 기준으로 동작한다.
- 정상 성공 경로는 승인 버튼 없이 자동 구현/자동 적용으로 흐른다.
- 수동 검토 버튼은 실패/충돌/예외 상황에만 남긴다.
- Darwin launchd cadence는 일일이 아니라 주 1회다.
