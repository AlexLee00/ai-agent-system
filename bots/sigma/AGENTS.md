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
