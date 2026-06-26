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

## 작업 원칙

- 기존 TypeScript 다윈 레거시를 수정할 때는 현재 live 경로와 V2 경로를 먼저 구분한다.
- Darwin V2(`elixir/darwin_v2/**`)와 TeamJay.Darwin 공용 인프라(`elixir/team_jay/**`)는 책임 경계를 섞지 않는다.
- 파일 이동은 반드시 `git mv`를 사용해 히스토리를 보존한다.
- 키, 토큰, 인증값, 외부 계정 정보는 코드와 문서에 남기지 않는다.

## Darwin V2 Phase별 상태

| Phase | 상태 | 핵심 산출물 |
|---|---|---|
| Phase 0 | 완료 | 아키텍처 문서, 원칙 문서, 전환 계획 |
| Phase 1 | 완료 | Commander, Directive, RunCycle |
| Phase 2 | 완료 | Memory L1/L2, Reflexion |
| Phase 3 | 완료 | Cycle DISCOVER~LEARN |
| Phase 4 | 완료 | Skill 3종 |
| Phase 5 | 완료 | HTTP/MCP 서버 |
| Phase 6 | 완료 | L3/L4/L5 자율 레벨 |
| Phase 7 | 완료 | launchd runtime |
| Phase 8 | 완료 | 리포트/운영 문서 |
| CODEX-A | 완료 | Cycle wait/promotion 수렴 |
| CODEX-B | 완료 | apply proof 기록 |
| CODEX-C | 완료 | sensor 확장 |
| CODEX-E | 완료 | approval-less L5 운영 |
| CODEX-H | 완료 | hypothesis/measure 경로 |

## 코드 작성 표준

- Elixir Agent는 `use Jido.AI.Agent`를 기본으로 하고, Action은 `use Jido.Action` 패턴을 따른다.
- 공개 모듈에는 `@moduledoc`을 남긴다.
- Elixir 변경 후에는 가능하면 `mix compile --warnings-as-errors`를 기준으로 확인한다.
- TypeScript live 경로는 기존 `tsx` + CommonJS 혼재 패턴을 보존한다.
- Darwin TS 변경 후에는 `bash bots/darwin/scripts/typecheck-darwin-ts.sh`를 우선 검증한다.
- 공통 유틸이 이미 있으면 새 helper보다 기존 helper를 확장한다.

## LLM 정책

Darwin V2 LLM 라우팅은 `Darwin.V2.LLM.Selector`를 기준으로 한다.

| 역할 | 기본 모델 |
|---|---|
| evaluator, planner, implementor, verifier | `claude-sonnet-4-6` |
| scanner, applier, learner, self_rag.* | `claude-haiku-4-5-20251001` |
| principle.critique | `claude-opus-4-7` |

## Kill Switch 환경변수

| 변수 | 기준값 | 의미 |
|---|---:|---|
| `DARWIN_V2_ENABLED` | `true` | V2 전체 활성화 |
| `DARWIN_CYCLE_ENABLED` | `true` | 주기 실행 활성화 |
| `DARWIN_SHADOW_MODE` | `false` | shadow 비교 모드 |
| `DARWIN_KILL_SWITCH` | `false` | 전체 즉시 중단 |
| `DARWIN_TIER2_AUTO_APPLY` | `true` | Tier2 자동 적용 |
| `DARWIN_L5_ENABLED` | `true` | L5 운영 |
| `DARWIN_MCP_ENABLED` | `true` | MCP 서버 |
| `DARWIN_ESPL_ENABLED` | `true` | ESPL 주간 진화 |
| `DARWIN_SELF_RAG_ENABLED` | `true` | Self-RAG |
| `DARWIN_TEAM_INTEGRATION_ENABLED` | `false` | 팀 통합 실험 |
| `DARWIN_HYPOTHESIS_ENGINE_ENABLED` | `false` | 가설 엔진 |
| `DARWIN_HYPOTHESIS_LLM_DAILY_BUDGET_USD` | `2.0` | 가설 LLM 일일 예산 |
| `DARWIN_MEASURE_STAGE_ENABLED` | `false` | 측정 단계 |
| `DARWIN_CODEBASE_ANALYZER_ENABLED` | `false` | 코드베이스 분석기 |
| `DARWIN_SENSOR_PWC_ENABLED` | `true` | Papers with Code 센서 |
| `DARWIN_SENSOR_SEMANTIC_SCHOLAR_ENABLED` | `true` | Semantic Scholar 센서 |
| `DARWIN_SENSOR_HN_ENABLED` | `true` | Hacker News 센서 |
| `DARWIN_SENSOR_OPENREVIEW_ENABLED` | `true` | OpenReview 센서 |

## 커밋 컨벤션

- 다윈 작업 커밋은 가능한 한 기능 단위로 작게 나눈다.
- 운영 전환, DB 변경, launchd 변경, 외부 알림 재전송은 명시 승인 없이는 커밋 범위에 포함하지 않는다.
- 검증 결과는 커밋 메시지 또는 후속 보고에 간결히 남긴다.

## 막히면

- live 경로와 V2 경로가 충돌하면 live 안전을 우선하고, V2 변경은 shadow/dry-run으로 분리한다.
- 외부 계정, secret, 운영 승인, 실제 알림 재전송이 필요하면 실행하지 말고 증거와 필요한 사용자 조치를 보고한다.
- 원인이 코드인지 운영 데이터인지 불명확하면 먼저 dry-run/smoke/evidence trail을 만든다.
