# AGENTS.md — 시그마팀 에이전트 정의

시그마팀은 **Commander 1 + Pod 3 + Skill 5 + 분석가 6**으로 구성된 Jido 기반 메타 오케스트레이터입니다.

## 1. Commander (`sigma/v2/commander.ex`)

메타 오케스트레이터 허브. Jido.AI.Agent 매크로 사용.

- **역할**: Directive 생성, Constitutional 원칙 자기평가, Pod 조율
- **입력**: 9팀 데일리 이벤트 로그, 팀 메트릭
- **출력**: `Directive{tier, team, action, rollback_spec}`
- **LLM**: Claude Sonnet 4.7 (기본) / Haiku (경량 호출) / Opus (중대 자기비평)
- **Kill Switch**: `SIGMA_V2_ENABLED=true`

## 2. Pod (3개)

동적 편성 단위. 마스터 제이의 "고용 조합 = 전략 선택" 원칙.

### 2-1. Pod.Risk (`pod/risk.ex`)
- **편성**: hawk(위험감지) + optimizer(최적화)
- **도메인**: 리스크 실패, SRE 이슈, 예산 초과
- **Skill 사용**: DataQualityGuard + CausalCheck

### 2-2. Pod.Growth (`pod/growth.ex`)
- **편성**: dove(성장) + librarian(지식 통합)
- **도메인**: 성과 향상, 신규 기능, A/B 실험
- **Skill 사용**: DataQualityGuard + ExperimentDesign

### 2-3. Pod.Trend (`pod/trend.ex`)
- **편성**: owl(관찰) + forecaster(예측)
- **도메인**: 중장기 트렌드, 시장 시그널, 리소스 예측
- **Skill 사용**: ObservabilityPlanner + FeaturePlanner

## 3. Skill (5개 — agentskills.io 포맷)

Jido.Action + Zoi 스키마. TS 원본 로직을 Elixir로 포팅.

| Skill | 역할 | 원본 TS | Elixir 파일 |
|-------|------|---------|-------------|
| DataQualityGuard | 데이터 품질 검증 (dup/missing/stale/outlier) | 114줄 | `skill/data_quality_guard.ex` |
| CausalCheck | 인과관계 검증 (confounder/reverse/selection) | 52줄 | `skill/causal_check.ex` |
| ExperimentDesign | 실험 설계 (hypothesis/sample-size/guardrail) | 63줄 | `skill/experiment_design.ex` |
| FeaturePlanner | 피처 우선순위 (impact/effort/confidence) | 36줄 | `skill/feature_planner.ex` |
| ObservabilityPlanner | 관측성 계획 (metric/log/alert) | 43줄 | `skill/observability_planner.ex` |

## 4. 분석가 (6명)

Pod에 편성되는 동적 편성 단위. AgentSelector(ε-greedy 20%)로 선택.

| 분석가 | 도메인 | 성향 |
|--------|--------|------|
| **hawk** | 리스크 감지 | 공격적, 조기경보 |
| **dove** | 성장 발굴 | 낙관적, 기회 포착 |
| **owl** | 트렌드 관찰 | 중립적, 장기 시야 |
| **optimizer** | 최적화 | 분석적, 효율 우선 |
| **librarian** | 지식 통합 | 종합적, 기억 연결 |
| **forecaster** | 예측 | 확률적, 불확실성 표기 |

## 5. Memory (2계층)

- **L1 (ETS)**: `memory/l1_session.ex` — 세션 내 휘발성
- **L2 (pgvector)**: `memory/l2_pgvector.ex` — PostgreSQL + Qwen3-0.6B 임베딩

## 6. Principle Loader + Self-Critique

- `principle/loader.ex` — `config/sigma_principles.yaml` 로드
- `self_critique/2` — Directive 실행 전 7원칙 자기평가 → Tier 3 차단 가능

## 7. Telemetry + Shadow Mode

- `telemetry.ex` — Jido.Observe + OpenTelemetry 1.7 (파일 exporter)
- `shadow_runner.ex` — TS v1과 v2 병렬 실행
- `shadow_compare.ex` — 결과 diff 비교 → 일치율 임계치 감시

## 8. LLM Selector (대기 중)

**Phase 1.5에서 추가 예정**. 루나팀 패턴 참고:

```elixir
# bots/sigma/elixir/lib/sigma/v2/llm/selector.ex
Sigma.V2.LLM.Selector.call_with_fallback(:commander, prompt, opts)
  → req_llm을 통한 적절한 모델/provider 선택 + fallback + 비용 추적
```

## 9. HTTP + MCP Server (Phase 5)

- `http/router.ex` — Plug 기반 `/sigma/v2/run-daily`
- `mcp/server.ex` — agentskills.io MCP 서버 (5개 skill 노출)
- `mcp/auth.ex` — Bearer Token 인증

---

**참조**: 설계서 `docs/PLAN.md` §4~§6, 연구 `docs/RESEARCH_V{1,2,3}.md`

## 작업 원칙

- 기존 TypeScript 시그마(`bots/sigma/ts/**`, `bots/sigma/legacy-skills/**`)는 레거시 경로로 취급하고, 명시 목적 없이 수정하지 않는다.
- 공용 인프라(`elixir/team_jay/**`)는 시그마 전용 변경과 섞지 않는다.
- 파일 이동은 반드시 `git mv`를 사용해 히스토리를 보존한다.
- 키, 토큰, 인증값, 외부 계정 정보는 코드와 문서에 남기지 않는다.

## Phase별 행동

| Phase | 상태 | 행동 기준 |
|---|---|---|
| Phase 0 | 완료 | 설계/리서치/원칙 정리 |
| Phase 1 | 완료 | Commander/Directive/RunDaily 구축 |
| Phase 1.5 | 완료 | LLM Selector, 비용 추적, fail-closed 정책 |
| Phase 2 | 완료 | Memory, Principle Loader, Self-Critique |
| Phase 3 | 완료 | Pod/Skill/Analyst 실행 경로 |
| Phase 4 | 완료 | Telemetry, Shadow Mode |
| Phase 5 | 완료 | HTTP/MCP 인터페이스 |

## 코드 작성 표준

- Elixir Agent는 `use Jido.AI.Agent`를 기본으로 하고, Action은 `use Jido.Action` + Zoi 스키마 패턴을 따른다.
- 공개 모듈에는 `@moduledoc`을 남긴다.
- Elixir 변경 후에는 가능하면 `mix compile --warnings-as-errors`를 기준으로 확인한다.
- TypeScript 레거시는 기존 ESM import/export와 Luna `llm-client` 패턴을 보존한다.
- 레거시 TS의 `@ts-nocheck`는 전면 제거보다 기존 안정성을 우선해 유지할 수 있다.

## LLM Selector 운영 기준

관련 파일:

- `bots/sigma/elixir/lib/sigma/v2/llm/selector.ex`
- `bots/sigma/elixir/lib/sigma/v2/llm/policy.ex`
- `bots/sigma/elixir/lib/sigma/v2/llm/cost_tracker.ex`
- `bots/sigma/elixir/test/sigma/v2/llm*_test.exs`
- `bots/sigma/shared/llm-client.ts`

운영 원칙:

- Hub routing, shadow 검증, 승인된 Anthropic public API 경로가 없으면 fail-closed로 처리한다.
- 예산이 0 이하이거나 DB 비용 확인이 실패하면 `budget_exceeded`로 중단한다.
- Sigma V2에는 Ollama route/fallback을 두지 않는다.

```yaml
sigma.agent_policy:
  commander:       { route: anthropic_sonnet, fallback: [anthropic_haiku] }
  pod.risk:        { route: anthropic_sonnet, fallback: [anthropic_haiku] }
  pod.growth:      { route: anthropic_haiku,  fallback: [] }
  pod.trend:       { route: anthropic_haiku,  fallback: [] }
  skill.data_quality:      { route: anthropic_haiku,  fallback: [] }
  skill.causal:            { route: anthropic_sonnet, fallback: [anthropic_haiku] }
  skill.experiment_design: { route: anthropic_sonnet, fallback: [anthropic_haiku] }
  skill.feature_planner:   { route: anthropic_haiku,  fallback: [] }
  skill.observability:     { route: anthropic_haiku,  fallback: [] }
  principle.self_critique: { route: anthropic_opus,   fallback: [anthropic_sonnet] }
  reflexion:               { route: anthropic_sonnet, fallback: [anthropic_haiku] }
  espl:                    { route: anthropic_sonnet, fallback: [anthropic_haiku] }
```

## 커밋 컨벤션

- 시그마 작업 커밋은 가능한 한 기능 단위로 작게 나눈다.
- 운영 전환, DB 변경, launchd 변경, 외부 알림 재전송은 명시 승인 없이는 커밋 범위에 포함하지 않는다.
- Claude Code가 작성한 변경은 필요 시 `Co-Authored-By: Claude Sonnet 4.6` 메타데이터를 남긴다.

## 금지 행동

- 레거시 Sigma TS 경로를 V2 구현처럼 직접 개조하지 않는다.
- Hub/LLM 예산, secret, 외부 계정 설정을 임의로 변경하지 않는다.
- shadow/dry-run 없이 운영 쓰기 경로를 활성화하지 않는다.
- 실패를 감추기 위해 fail-open fallback을 추가하지 않는다.

## 막히면

- V2 경로와 레거시 경로가 충돌하면 V2는 shadow/dry-run으로 분리하고, 레거시 live 안전을 우선한다.
- 외부 계정, secret, 운영 승인, 실제 알림 재전송이 필요하면 실행하지 말고 증거와 필요한 사용자 조치를 보고한다.
- 원인이 코드인지 운영 데이터인지 불명확하면 먼저 dry-run/smoke/evidence trail을 만든다.
