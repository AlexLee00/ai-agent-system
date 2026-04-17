# 시그마팀(Σ) 리모델링 종합 설계서

> **작성일**: 2026-04-17 (29차 세션)
> **작성자**: 메티 (Metis, claude.ai)
> **대상**: 시그마팀(대도서관의 핵심 — 데이터 수집·분석·피드백·개선 사이클)
> **요구 사항 원본**: 마스터 지시 29차 세션
> **전제 자료**: 28회 감사 세션 + `RESEARCH_CC_COMPREHENSIVE.md` + `ECC_APPLICATION_GUIDE.md` + 외부 서칭(Jido/Hermes/AI Scientist)
> **상태**: 설계안 v1 — 마스터 승인 대기

---

## 📋 목차

1. [Executive Summary](#1-executive-summary)
2. [현재 상태 완전 분석](#2-현재-상태-완전-분석)
3. [발견 문제점 8건](#3-발견-문제점-8건)
4. [외부 서칭 결과 집대성](#4-외부-서칭-결과-집대성)
5. [리모델링 설계안](#5-리모델링-설계안)
   - 5.1 [Elixir 전면 전환](#51-elixir-전면-전환-tsx--otp--jido)
   - 5.2 [MCP vs Skills 전환 검토](#52-mcp-vs-skills-전환-검토)
   - 5.3 [완전 자율 운영 — 승인 루프 제거](#53-완전-자율-운영--승인-루프-제거)
   - 5.4 [피드백 루프 개선 — 4 Generation](#54-피드백-루프-개선--4-generation-loop)
   - 5.5 [n8n / RAG 재검토](#55-n8n--rag-재검토)
   - 5.6 [다윈팀 TS Only 분리](#56-다윈팀-ts-only-분리)
6. [단계적 실행 계획 Phase 0~5](#6-단계적-실행-계획-phase-05)
7. [리스크 + 롤백 전략](#7-리스크--롤백-전략)
8. [KPI + 성공 기준](#8-kpi--성공-기준)
9. [외부 보강 포인트 (향후)](#9-외부-보강-포인트-향후)

---

## 1. Executive Summary

### 🎯 리모델링 목표

**시그마팀을 "대도서관의 심장"으로 재설계** — 수동 모니터링 도구에서 **Jido(Elixir) 기반 완전 자율 메타 오케스트레이터**로 진화시킨다. 데이터 수집 → 인과 분석 → 피드백 → 실제 적용 → 효과 측정 → 자기 개선의 **폐쇄 루프**를 완성하여, 마스터 개입 없이 지속적으로 시스템을 업데이트한다.

### 📊 Before / After 개요

| 차원 | 현재 (Before) | 목표 (After) |
|------|---------------|--------------|
| **런타임** | TS 946줄 + Elixir 387줄 공존 | Jido + OTP **완전 Elixir** |
| **실행 모드** | 일일 `runDaily()` cron | Jido AgentServer + Signal(CloudEvents) **reactive** |
| **피드백 경로** | DB 기록만, 대상팀 실행 X | Directive-driven **자동 적용** |
| **Skills 활용** | 5개 skills 죽은 코드 | analyzer에 **실제 연결 + MCP 노출** |
| **자기 개선** | ε-greedy 1D + heuristic 점수 | **Reflexion + Self-RAG + GEPA** (Hermes 패턴) |
| **승인 게이트** | 있음 (Manual) | **없음** + Mailbox + 리스크티어 자동 가드 |
| **관찰성** | `daily_runs` 테이블 + 주간 메타 리뷰 | **Jido Observe + GStack `/retro`** + OpenTelemetry |
| **n8n 의존** | 0 (시그마는 미사용) | **유지 (0)** — 이 상태가 정답 |
| **RAG 저장** | pgvector `publishToRag` 단일 경로 | **Strict Write + Self-RAG 검증** + L1/L2/L3 Hermes 계층 |
| **다윈팀 결합** | 혼재 (JS 레거시 1개) | **TS only**로 완전 분리 |

### 🏆 기대 성과

1. **자율성**: 마스터 1일 개입 빈도 **5~10회 → 주 1~2회** (약 95% 절감)
2. **피드백 효과 발현 속도**: 평균 **7일 (현재 measurePast) → 24시간** (Directive 자동 적용)
3. **관찰성**: Jido Observe로 **100% 에이전트 스텝 추적** 가능
4. **확장성**: Jido pod 토폴로지로 **9팀 → 20팀+ 확장 용이**
5. **안정성**: OTP supervision으로 **장애 시 자동 복구** (현재는 cron 재실행 의존)

### ⚠️ 리스크 계층

| 리스크 | 확률 | 영향 | 대응 |
|--------|------|------|------|
| Elixir 전환 중 기존 자동화 중단 | 중 | 고 | Phase 0~3 병렬 운영(shadow mode) |
| 자동 적용이 잘못된 방향으로 학습 | 중 | 고 | 리스크 티어별 가드 + 롤백 rollback_spec |
| Jido 학습 비용 | 고 | 저 | 이미 Elixir 포트 일부 존재, jido만 추가 |
| MCP 전환으로 오히려 컨텍스트 증가 | 중 | 중 | Progressive Disclosure 패턴 적용 |

---


## 2. 현재 상태 완전 분석

### 2.1 코드 분포 (총 2,041줄)

```
┌───────────────────────────────────────────────────────────┐
│ 영역                              │ 파일 수 │ 줄 수        │
├───────────────────────────────────────────────────────────┤
│ bots/orchestrator/src/            │    1   │   263        │  ← 진입점
│   └ sigma-daily.ts                                         │
│ bots/orchestrator/lib/sigma/      │    3   │   946        │  ← 핵심 로직
│   ├ sigma-analyzer.ts                         168          │
│   ├ sigma-scheduler.ts                        287          │
│   └ sigma-feedback.ts                         491          │
│ elixir/team_jay/lib/team_jay/jay/sigma/         │ 3 │ 387 │  ← 부분 포트
│   ├ analyzer.ex                                86          │
│   ├ scheduler.ex                              138          │
│   └ feedback.ex                               163          │
│ packages/core/lib/skills/sigma/   │    5   │   308        │  ← 죽은 코드
│   ├ data-quality-guard.ts                     114          │
│   ├ causal-check.ts                            52          │
│   ├ experiment-design.ts                       63          │
│   ├ feature-planner.ts                         36          │
│   └ observability-planner.ts                   43          │
├───────────────────────────────────────────────────────────┤
│ 총계                              │  12    │ 1,904        │
└───────────────────────────────────────────────────────────┘

외부 의존성 (핵심):
  packages/core/lib/hiring-contract.ts   (401줄) — ε-greedy 고용 엔진
  packages/core/lib/agent-memory.ts      (529줄) — 3층 메모리 (episodic/semantic/procedural)
  packages/core/lib/agent-memory-consolidator.ts (131줄) — episodic → semantic 통합
  packages/core/lib/event-lake.ts        (624줄) — CloudEvents 유사 저장소
  packages/core/lib/pg-pool              — PostgreSQL pool
  packages/core/lib/rag                  — pgvector RAG
  packages/core/lib/reporting-hub        — publishToRag / publishToWebhook
  packages/core/lib/kst                  — 한국 시간
```

### 2.2 실행 흐름 (sigma-daily.ts `runDaily()`)

```
1. ensureSigmaTables()                       — 스키마 보증 (sigma.daily_runs + feedback_effectiveness)
2. measurePastFeedbackEffectiveness()        — 7일 지난 피드백 50건의 before/after 비교
3. collectScoutQualityMetric()               — 루나팀 스카우트 품질 메트릭 수집
4. sigmaMemory.recall(episodic, semantic)    — 최근 결정 기억 조회 (pgvector)
5. decideTodayFormation({ memories })        — 오늘 타겟팀 + 분석가 편성
   ├ collectYesterdayEvents()                  (blog posts / investment trades / research / launchd 등)
   ├ ROTATION weekday 선택                     (ska/worker/claude/justin/video 순환)
   ├ CORE_ANALYSTS 3명 기본                    (pipe, canvas, curator)
   ├ selectBestAgent() ε-greedy (×4)           (perspective/optimizer/librarian/forecaster)
   └ 메모리 기반 boost teams / hint
6. analyzeFormation(formation, recentMemories)
   ├ collectTeamMetric(team)                   (각 타겟팀 DB 메트릭)
   └ buildRecommendation(team, metric, analyst) (하드코딩 템플릿 문장)
7. recordFeedbackRecommendation() × N        — DB만 저장, 대상 팀에 전달 X ⚠️
8. recordDailyRun() / recordScoutQualityEvent()
9. publishToRag() + sigmaMemory.remember()   — episodic 저장
10. sigmaMemory.consolidate()                — episodic → semantic 통합
11. (금요일만) weeklyMetaReview()            — 분석가별 효과 집계 + Telegram
12. publishToWebhook()                       — Telegram 발송
```

### 2.3 분석가 체계

```
┌─────────────────────────────────────────────────────────────┐
│ 분석가     │ 역할       │ 선택 조건                         │
├─────────────────────────────────────────────────────────────┤
│ hawk       │ 리스크     │ errorSpikes>0 / failed>=3 / pnl<-50 │
│ dove       │ 성장       │ performanceUp / published_7d>=5     │
│ owl        │ 추세 감시  │ market_regime in [volatile, bull]   │
│ pivot      │ 기본       │ fallback                            │
│ optimizer  │ 워크플로우 │ workflowSlow or unhealthy>0         │
│ librarian  │ 지식 축적  │ newExperiences>10                   │
│ forecaster │ 예측       │ luna 포함 시                        │
│ pipe       │ 파이프     │ CORE (데이터 파이프라인 전담)       │
│ canvas     │ 시각화     │ CORE (대시보드/리포트 전담)         │
│ curator    │ 큐레이션   │ CORE (RAG/메모리 정제 전담)         │
└─────────────────────────────────────────────────────────────┘

핵심 알고리즘: hiring-contract.selectBestAgent()
  adjustedScore = score - (fatigue×0.1) + (confidence×0.05)
                + roleBonus + specialtyBonus
  ε-greedy: 80% 최고점수 + 20% 랜덤 탐색 (SIGMA_RANDOM_EPSILON=0.2)
```

### 2.4 Skills 5개 (죽은 코드)

모두 순수 함수로 잘 설계되었으나 **analyzer/scheduler에서 호출 없음**:

- `data-quality-guard.evaluateDataset()` — duplicate/missing/stale/outlier 판정 + quality_score (0~10)
- `causal-check.evaluateCausalRisk()` — correlation × confounders × sample_size → risk (low/med/high)
- `experiment-design.evaluateExperimentDesign()` — hypothesis/metric/baseline/variants/guardrail → passed + score
- `feature-planner.planFeatures()` — signal×2 − effort − leakage → prioritized + quick_wins
- `observability-planner.buildObservabilityPlan()` — failure_modes → metrics + alerts + dashboards + gaps

### 2.5 Elixir 포트 현황 (387줄, 부분)

- `analyzer.ex` (86줄): TS 포트, atom 기반 분석가 선택, metric_hint 생성
- `scheduler.ex` (138줄): weekday ROTATION + low_score_teams 결합
- `feedback.ex` (163줄): ensure_tables + record_feedback + record_daily_run + measure_effectiveness

**Elixir 쪽 구조적 결함**:
- SQL 문자열 보간 (`escape_sql` + uuid regex만) → 파라미터 바인딩 부재
- `effectiveness = 1.0 or 0.0` 이진 판정 (TS는 연속값)
- `TeamJay.HubClient.pg_query` 파라미터 바인딩 미지원으로 알려짐

---

## 3. 발견 문제점 8건

### 🔴 P1-001 [HIGH] 피드백 생성 후 실제 적용 경로 부재

**위치**: `sigma-feedback.ts:recordFeedbackRecommendation`

**문제**:
```typescript
// 현재: INSERT into feedback_effectiveness만
return pgPool.get(SCHEMA, `
  INSERT INTO ${SCHEMA}.feedback_effectiveness ...
`);
// 끝. 대상 팀에 전달/적용되는 로직 없음.
```

피드백이 DB에 기록되고 **7일 후 효과 측정만 하면서 실제로는 아무것도 바뀌지 않음**. 이는 "자율 운영 피드백 루프"의 **가장 큰 결함**. Reflexion/STELLA 패턴이 요구하는 **action → outcome → learning** 중 action 연결이 끊김.

**영향**: 시스템이 "관찰자"일 뿐, "행위자"가 아니게 됨.

### 🔴 P1-002 [HIGH] Skills 5개 죽은 코드

**문제**: `packages/core/lib/skills/sigma/*.ts`가 존재하지만 `grep -r 'evaluateDataset\|evaluateCausalRisk\|evaluateExperimentDesign\|planFeatures\|buildObservabilityPlan' bots/orchestrator/` 결과 0건.

**영향**: 300줄의 잘 설계된 함수가 운영에 기여하지 않음. 보수 비용만 발생.

### 🟡 P2-003 [MEDIUM] Elixir 쪽 SQL 파라미터 바인딩 부재

**위치**: `feedback.ex:record_feedback`

**문제**: `TeamJay.HubClient.pg_query`가 파라미터 바인딩 미지원 → 수동 `escape_sql` + UUID regex로 방어. 문자열 치환 기반으로 **Jido 런타임에서 확장 시 취약 가능**.

**대응**: Jido + Postgrex(직접 커넥션) 또는 Ecto 도입 시 `^var` 바인딩으로 전환.

### 🟡 P2-004 [MEDIUM] Effectiveness 계산이 Elixir 쪽에서 이진 판정

**위치**: `feedback.ex:measure_effectiveness`

**문제**:
```elixir
effectiveness = if effective, do: 1.0, else: 0.0
```
vs TS의 연속값:
```typescript
return Number((((afterScore - beforeScore) / Math.max(1, Math.abs(beforeScore))) * 100).toFixed(2));
```

**영향**: Elixir 루트로 기록되면 효과 측정 정밀도 소실. 분석가 랭킹 왜곡.

### 🟡 P2-005 [MEDIUM] `safeExec('launchctl list ...')` OS 의존 직접 실행

**위치**: `sigma-scheduler.ts:safeExec`

**문제**: `child_process.execSync('launchctl list | egrep "ai\\."')` — macOS 전용 + Jido 환경으로 옮기면 포터블하지 않음. 또한 쉘 경유 파이프.

**대응**: Jido Signal로 Claude팀 Dexter heartbeat에서 unhealthy 이벤트 수신하는 방식으로 전환.

### 🟡 P2-006 [MEDIUM] 분석가 선정에 LLM 판단 미활용

**위치**: `hiring-contract.selectBestAgent` 기반

**문제**: 스코어 기반 ε-greedy는 강점이지만, **CC Leak/GStack의 `/plan-eng-review` 같은 LLM 판단**이 없음. 결과: 스코어가 비슷한 두 분석가 중 하나를 랜덤 선택.

**대응**: 시그마 분석가장(`sigma.commander`)이 short LLM 호출로 최종 결정 (80% 스코어 / 15% 탐색 / 5% LLM 판단).

### 🟢 P3-007 [LOW] 로직 이중화 (TS/Elixir)

**문제**: 동일 비즈니스 로직이 TS 946줄 + Elixir 387줄 양쪽에 포트됨. 변경 시 2곳 동기화 필요.

**대응**: Elixir를 **진실의 원천(SSOT)**으로 승격, TS는 호환 어댑터로만 남김 (Phase 3에서).

### 🟢 P3-008 [LOW] 주간 메타리뷰 분석가 평균만, 팀별/피드백 타입별 없음

**위치**: `sigma-feedback.ts:weeklyMetaReview`

**문제**: 집계가 `GROUP BY analyst_used`만. 팀별/피드백 타입별/시간대별 효과 못 봄.

**대응**: 다차원 GROUP BY + Heatmap 대시보드 추가 (Jido Observe).


---

## 4. 외부 서칭 결과 집대성

### 4.1 Jido — Elixir 에이전트 프레임워크 (⭐1,652 / `agentjido/jido`)

**최신 커밋**: 2026-04-14 (매우 활발)

**핵심 철학**:
> "Jido는 GenServer를 형식화한 에이전트 패턴 — Redux/Elm 영향받은 불변 에이전트 + OTP 런타임"

**설계 원칙 (시그마팀에 바로 적용)**:

| 개념 | 의미 | 시그마 매핑 |
|------|------|-------------|
| **Agent** | state + `cmd/2` 함수 | `Sigma.Analyst.Hawk` / `Sigma.Commander` 등 |
| **Action** | 순수 state 변환 | `CollectMetric` / `BuildRecommendation` |
| **Signal** | CloudEvents 기반 이벤트 envelope | 어제 이벤트 / 다른 팀 alert 수신 |
| **Directive** | 타입드 효과 서술 | `ApplyFeedback(team, action)` 등 |
| **Plugin** | 재사용 capability + schema 병합 | `DataQualityGuard` skill → plugin |
| **Pod (토폴로지)** | 논리 파티션 + 수직적 스폰 | `sigma_pod` (분석가 3~5명 묶음) |
| **FSM 전략** | 유한상태기계 실행 | `formation → analyze → apply → measure` 상태 머신 |

**핵심 API 샘플**:
```elixir
defmodule Sigma.Analyst.Hawk do
  use Jido.Agent,
    name: "sigma_hawk",
    description: "리스크 관점 분석가",
    schema: [
      fatigue: [type: :float, default: 0.0],
      confidence: [type: :float, default: 0.5],
      specialty: [type: :string, default: "risk_review"]
    ]
end

{agent, directives} = Sigma.Analyst.Hawk.cmd(agent, %Action.Analyze{metric: m})
# directives 예: [%Directive.Emit{signal: ...}, %Directive.Schedule{ms: 3600_000}]
```

**왜 시그마팀에 완벽한가**:
1. **immutable + directive 분리** → 자동 적용 시 롤백 용이 (directive를 다시 전송하면 됨)
2. **Signal Routing** → 타 팀 이벤트를 시그마가 reactive하게 수신 가능
3. **Pod 토폴로지** → 분석가 3~5명을 하나의 pod으로 묶어 hierarchical supervision
4. **Plugin 시스템** → 기존 Skills 5개를 그대로 jido_action으로 포팅 가능

**의존성 (mix.exs)**:
```elixir
{:jido, "~> 2.0"},
{:jido_action, "~> 1.0"},       # 합성 가능한 검증된 액션
{:jido_signal, "~> 1.0"},       # CloudEvents 메시지
{:jido_ai, "~> 1.0"},           # LLM 통합 (Claude/GPT/로컬 Ollama)
{:req_llm, "~> 1.0"}            # LLM HTTP client
```

### 4.2 Hermes Agent — 자기 진화 에이전트 (⭐95,187 / `NousResearch/hermes-agent`)

**핵심 통찰** (ECC 가이드 기반):

**4단계 학습 루프**:
```
1. 실행 (Execute) — 도구로 작업 수행
2. 평가 (Evaluate) — 명시적+암시적 피드백으로 성공/실패 판별
3. 추출 (Extract) — 성공 패턴을 스킬 문서로 자동 추출
4. 개선 (Improve) — 다음 사용 시 스킬 자동 업데이트
→ 10~20회 반복 후 실행 속도 2~3배 향상
```

**3층 메모리**:
```
L1 세션 메모리 — 대화 컨텍스트 (in-memory)
L2 영구 메모리 — SQLite+FTS5, 10ms 검색
L3 스킬 메모리 — 마크다운 파일, 점진적 노출 (L0=이름만 3K토큰 → L1=전체 로드)
```

**시그마팀 적용**:
- 3층 메모리 → **`agent-memory.ts` 529줄 (episodic/semantic/procedural)과 이미 유사**
- 자율 스킬 생성 → 시그마 분석가가 성공한 피드백 → **skill로 자동 승격**
- 점진적 노출 → LLM 컨텍스트 절약 (스킬 이름만 기본, 필요시 전체 로드)

### 4.3 Hermes Self-Evolution — DSPy + GEPA (⭐1,840)

**GEPA = Generative Evolutionary Prompt Adaptation** — 프롬프트/스킬/코드를 **유전 알고리즘**으로 진화시키는 프레임워크.

**시그마팀 적용**:
- `buildRecommendation(team, metric, analyst)`의 하드코딩 템플릿 → **GEPA로 진화하는 프롬프트**
- 주간 메타리뷰 결과를 fitness signal로 사용
- 효과 점수 높은 분석가의 프롬프트 패턴이 다른 분석가에게 교차 적용

### 4.4 Paperclip + GStack 통합 교훈

**Paperclip** (⭐31K, 회사 OS):
- **Goal Ancestry**: 태스크 → 프로젝트 → 미션으로 "왜"를 항상 알 수 있음
- **Budget**: 에이전트별 월 예산, 80% 경고, 100% 자동 중지
- **Governance**: 승인 게이트 + 설정 버전관리 + 롤백

**GStack** (⭐54K, Garry Tan/YC):
- `/investigate` — "조사 없이 수정 없다"
- `/plan-eng-review` — **필수 게이트 (유일!)**
- `/retro` — 회고
- `AGENTS.md` — 매 실수마다 줄 추가 (Engineer Corrections Permanently)

**시그마팀 적용**:
- 각 피드백에 **Goal Ancestry 태그** (daily_run_id → formation → target_team → action)
- 분석가별 **LLM 호출 예산** (일일 토큰/비용 상한)
- GStack `/retro` 패턴 → 시그마 주간 메타리뷰를 **"What Worked / What Didn't / What to Try"** 3섹션으로 재구성

### 4.5 AI Scientist v2 + STELLA 패턴

**AI Scientist v2** (⭐4.4K / SakanaAI):
- Progressive agentic tree-search + 전용 experiment manager
- VLM 피드백 루프: 그래프/차트를 시각적으로 평가하고 반복 개선

**STELLA 패턴** (바이오의학 자기진화 에이전트):
- 도구 라이브러리 + 추론 템플릿 라이브러리를 **동적으로 확장**
- 운영 경험 ↑ → 정확도 **2배** 향상

**시그마팀 적용**:
- 분석가가 사용한 skill 조합을 **library로 저장** → 다음 유사 상황에서 재사용
- `experiment-design.ts` skill을 실제로 연결하여 시그마 피드백 자체를 실험으로 취급 (A/B 버전)

### 4.6 Reflexion + Self-RAG 패턴

**Reflexion** (ReAct 후속):
```
Actor → Evaluator → Self-Reflection → Experience Buffer
```
- **실패에서 자연어 리플렉션 생성** → 다음 시도 전 참고

**Self-RAG**:
```
retrieve?(yes/no) → retrieve → isRel? → isSup? → isUse?
```
- **RAG 조회가 실제로 도움되는지 검증**하고 조회 자체를 선별

**시그마팀 적용**:
- `measurePastFeedbackEffectiveness()`가 실패(`effective=false`) 감지 시 → **Reflexion 노트 자동 생성** → 동일 (team, analyst, feedback_type) 조합 재시도 시 노트 주입
- RAG 회수 쿼리에 Self-RAG 게이트 추가 → 부적합 회수 방지

### 4.7 Strict Write — CC Leak 핵심 패턴

**원리**: "메모리는 힌트, 코드베이스로 검증. **성공한 것만** 메모리에 기록."

**시그마팀 현재**: `sigmaMemory.remember(analysis.report, 'episodic', { importance: feedbackRows.length > 0 ? 0.72 : 0.58 })` — 실패/빈 결과도 기록됨.

**개선**: **피드백이 실제 적용되어 효과 측정에서 `effective=true`된 경우만 semantic 승격**. episodic은 전부 기록하되, consolidate 단계에서 성공만 필터.

---


## 5. 리모델링 설계안

### 5.1 Elixir 전면 전환 — TSX → OTP + Jido

#### 5.1.1 목표 아키텍처

```
┌──────────────────────────────────────────────────────────────────────┐
│                 TeamJay.Sigma Supervisor (OTP Tree)                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Sigma.Commander (Jido.Agent, LLM 판단 + 편성 결정)             │ │
│  │   - state: {today_formation, llm_budget, last_meta_review}     │ │
│  │   - plugins: [HiringContract, MemoryRecall, LLMDeliberation]   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│        │                    │                    │                   │
│        │ SpawnAgent          │ SpawnAgent         │ SpawnAgent       │
│        ▼                    ▼                    ▼                   │
│  ┌──────────┐         ┌──────────┐         ┌──────────┐              │
│  │ Sigma Pod│         │ Sigma Pod│         │ Sigma Pod│              │
│  │ [hawk,   │         │ [dove,   │         │ [owl,    │              │
│  │  opt]    │         │  lib]    │         │  fore]   │              │
│  └──────────┘         └──────────┘         └──────────┘              │
│        │                    │                    │                   │
│        └────────────────────┼────────────────────┘                   │
│                             ▼                                        │
│              Jido.Signal (CloudEvents Router)                        │
│                             │                                        │
│   ┌─────────┬───────────────┼───────────────┬──────────┐             │
│   ▼         ▼               ▼               ▼          ▼             │
│ Luna      Blog            Claude          Darwin     Worker          │
│ (target)  (target)        (target)        (target)   (target)        │
│                                                                      │
│                  ┌────────────────────┐                              │
│                  │  Sigma.Observer    │  (Jido Observe + OpenTelemetry) │
│                  │  Sigma.Archivist   │  (Strict Write → RAG + Memory)  │
│                  └────────────────────┘                              │
└──────────────────────────────────────────────────────────────────────┘
```

#### 5.1.2 모듈 매핑 (현재 TS → 목표 Elixir Jido)

| 현재 (TS) | 목표 (Elixir/Jido) | 노트 |
|-----------|---------------------|------|
| `sigma-daily.ts runDaily()` | `Sigma.Commander` Agent + `Cron` sensor | OTP supervision으로 장애 복구 |
| `decideTodayFormation()` | `Sigma.Commander.cmd(:decide_formation)` | Action 반환 |
| `analyzeFormation()` | `Sigma.Pod.analyze/2` (Pod 단위 병렬) | 분석가별 병렬 실행 |
| `collectTeamMetric(team)` | `Sigma.Skill.CollectMetric` (Jido Action) | Plugin으로 팀별 특수화 |
| `recordFeedbackRecommendation()` | `Directive.ApplyFeedback(team, action)` | **실제 적용 경로 추가!** |
| `measurePastFeedbackEffectiveness()` | `Sigma.Measurer` Agent + `Schedule` directive | 24h + 7d 두 시점 측정 |
| `weeklyMetaReview()` | `Sigma.Retro` Agent + `/retro` 패턴 | 주간 회고 자동화 |
| `sigmaMemory.remember/recall/consolidate` | `Jido.Memory` + Hermes 3층 | L1 ETS / L2 Postgres / L3 RAG |
| `hiring-contract.selectBestAgent` | `Sigma.Hire` Plugin | ε-greedy 유지 + LLM 판단 5% 추가 |

#### 5.1.3 Jido Action 예시 (시그마 skill 포팅)

```elixir
defmodule Sigma.Skill.DataQualityGuard do
  use Jido.Action,
    name: "data_quality_guard",
    description: "dataset 중복/누락/stale/outlier 검사",
    schema: [
      rows: [type: {:list, :map}, required: true],
      required_fields: [type: {:list, :string}, default: []],
      freshness_field: [type: :string, default: nil],
      freshness_threshold_days: [type: :integer, default: 7],
      numeric_fields: [type: {:list, :string}, default: []]
    ]

  @impl Jido.Action
  def run(params, _context) do
    # data-quality-guard.ts 114줄 로직을 순수 Elixir로 포팅
    # duplicates, missing, stale, outliers 계산 → quality_score 반환
    result = %{
      passed: false,
      quality_score: compute_quality(params),
      issues: detect_issues(params),
      stats: compute_stats(params)
    }
    {:ok, result}
  end
end
```

#### 5.1.4 Signal 흐름 예시

```
[Blog posted_new_article] Signal
         │ {type: "post.published", source: "blog", data: {...}}
         ▼
    Sigma.Signal.Router
         │
         ▼
  Sigma.Commander (reactive)
    "블로그에 새 글 발행 → 품질 피드백 필요한가?"
         │
         ├─ directive: SpawnAgent(Sigma.Pod, [canvas, librarian])
         ▼
  Sigma.Pod analyze()
    Jido.Action.CollectMetric + DataQualityGuard + CausalCheck
         │
         ▼
    {feedbacks, directives}
         │
         ├─ directive: ApplyFeedback(team: "blog", action: "품질 스코어 조회")
         └─ directive: Schedule(after: 24h, signal: :measure_effect)
         ▼
   Blog 팀 (target) 에 Signal 라우팅
         │
         ▼
   Blog.Feedback.Receiver 수신 → 실제 적용
```

#### 5.1.5 전환 장점

1. **장애 복구**: OTP supervision → cron crash 시 자동 재시작 (현재는 launchd re-run 의존)
2. **병렬화**: Pod 단위 분석가 병렬 실행 → 현재 for loop 대비 3~5배 빠름
3. **Reactive**: 일일 cron만이 아니라 **이벤트 주도** (블로그 발행 즉시 시그마 반응 가능)
4. **Type Safety**: Jido NimbleOptions schema → 런타임 검증 자동
5. **Traceability**: Jido Observe → 모든 Action/Signal/Directive를 OpenTelemetry로 추적

---

### 5.2 MCP vs Skills 전환 검토

#### 5.2.1 현재 상태

**Skills**: `packages/core/lib/skills/sigma/*.ts` 5개, **Node.js 내부 함수**로만 사용 가능. 다른 에이전트(claude.ai 대화, Codex, 외부 LLM)에서 호출 불가.

**MCP**: 프로젝트에 이미 `bots/investment/scripts/tradingview-mcp-server.py` 존재. Anthropic MCP 타입 패키지 설치됨 (`bots/ska/venv/.../anthropic/types/beta/beta_mcp_*`).

#### 5.2.2 결정 매트릭스

| 기준 | Skills 유지 | MCP 전환 | 하이브리드 |
|------|-------------|----------|-------------|
| 내부 에이전트 성능 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ (RPC 오버헤드) | ⭐⭐⭐⭐ |
| 외부 LLM 접근성 | ❌ 불가 | ✅ 표준 프로토콜 | ✅ 선택적 |
| 개발 속도 | ⭐⭐⭐⭐⭐ (이미 존재) | ⭐⭐ (서버 구현 필요) | ⭐⭐⭐ |
| 유지보수 | 1곳 | 2곳 (Skill + MCP wrapper) | 1.5곳 |
| Jido 통합 | `jido_action` 직접 포팅 | MCP client 필요 | 둘 다 |
| 타 팀 재사용 | Node.js만 | 언어 무관 | 언어 무관 |
| **Progressive Disclosure** | 어려움 (다 로드) | ✅ 이름만 광고 | ✅ 이름만 광고 |

#### 5.2.3 권고: **하이브리드 전략**

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Jido Action (Elixir 내부, 고성능)                   │
│   Sigma.Skill.DataQualityGuard                              │
│   Sigma.Skill.CausalCheck                                   │
│   Sigma.Skill.ExperimentDesign                              │
│   Sigma.Skill.FeaturePlanner                                │
│   Sigma.Skill.ObservabilityPlanner                          │
│                                                             │
│ Layer 2: MCP 서버 (외부 노출, 선택적)                        │
│   sigma-mcp-server.exs (Elixir MCP server)                  │
│   - expose all 5 skills as MCP tools                        │
│   - Progressive Disclosure: 이름만 먼저, 호출 시 전체 로드    │
│                                                             │
│ Layer 3: TS Skill 폐기 (Phase 3)                            │
│   packages/core/lib/skills/sigma/*.ts → archive             │
│   단, JS/TS 봇이 여전히 필요 시 MCP client로 접근            │
└─────────────────────────────────────────────────────────────┘
```

#### 5.2.4 MCP 서버 구현 스케치

```elixir
defmodule Sigma.MCP.Server do
  use Hermes.MCP.Server,    # NousResearch/hermes-mcp (공식 Elixir MCP 구현 존재)
    name: "sigma-analytics",
    version: "1.0.0"

  # Progressive Disclosure: L0 = 이름만 (이것만 응답에 포함)
  def list_tools do
    [
      %{name: "data_quality_guard", description: "dataset 품질 평가"},
      %{name: "causal_check", description: "인과 관계 리스크 평가"},
      %{name: "experiment_design", description: "A/B 테스트 설계 검증"},
      %{name: "feature_planner", description: "피처 우선순위"},
      %{name: "observability_planner", description: "관측성 계획"}
    ]
  end

  # L1 = 호출 시 Jido Action으로 위임
  def call_tool(name, params) do
    case name do
      "data_quality_guard" -> Jido.Action.run(Sigma.Skill.DataQualityGuard, params)
      "causal_check"       -> Jido.Action.run(Sigma.Skill.CausalCheck, params)
      # ...
    end
  end
end
```

#### 5.2.5 왜 완전 MCP 전환이 아니고 하이브리드인가

1. **성능**: Jido 내부 Action 호출은 ~50μs, MCP는 ~5ms (100배 차이). 시그마는 일일 N×M×K회 호출 → 성능 중요
2. **타입 안전**: NimbleOptions schema는 MCP JSON Schema보다 Elixir에 더 잘 맞음
3. **Directive 연동**: Jido Directive는 Action과 같은 프로세스 공간에서 만들어져야 함
4. **외부 노출 요구**: 마스터가 claude.ai/Codex에서 직접 호출하고 싶을 때 → MCP Layer만 있으면 됨


---

### 5.3 완전 자율 운영 — 승인 루프 제거

#### 5.3.1 현재 승인 흐름의 한계

시그마팀은 분석 자체는 자동이지만, 피드백이 **대상 팀에 자동 적용되지 않음** → 사실상 "마스터가 매일 리포트 읽고 수동 적용" 모델. 이는:
- 마스터 집중 시간 잠식
- 피드백 지연 (효과 측정까지 7일 대기)
- 피드백 → 효과 인과 추정이 약해짐 (마스터의 다른 개입으로 교란)

#### 5.3.2 자율 적용 안전 원칙: **4티어 리스크 게이트**

CC Leak의 "4티어 권한" + GStack `/guard` 패턴을 시그마팀에 적용:

```
┌───────────────────────────────────────────────────────────────────┐
│ Tier 0 — 관찰 (Observe)                                           │
│   피드백 = 로그/대시보드만. 자동 적용 없음.                         │
│   예: "블로그 발행 2건 증가 감지" → 기록만                         │
│   조건: 항상 Tier 0부터 시작                                       │
├───────────────────────────────────────────────────────────────────┤
│ Tier 1 — 제안 (Suggest) — ⚡ 자동                                  │
│   피드백 = 다른 팀에 **알림만** (Signal 보내기, 실행 X).            │
│   예: "luna에 forecast 재조정 권고" → Signal `sigma.advisory`       │
│   조건: 과거 동일 (team, feedback_type) 조합 누적 7일 effective>0.3 │
├───────────────────────────────────────────────────────────────────┤
│ Tier 2 — 경량 개입 (Light Intervention) — ⚡ 자동, 롤백 자동        │
│   피드백 = **설정값 튜닝** (config JSON 수정), 범위 ±10%.           │
│   예: blog.posting_interval_hours 24 → 26                          │
│   조건: 변경 전 snapshot 저장 + 자동 rollback 24h 내 effective<0    │
│   적용 대상: config only (코드/DB스키마 X)                         │
├───────────────────────────────────────────────────────────────────┤
│ Tier 3 — 중개입 (Heavy Intervention) — ⚠️ 마스터 승인 필수          │
│   피드백 = 신규 에이전트 고용/해고, 스킬 추가/제거, 팀 편성 변경.    │
│   조건: Mailbox에 대기 + Telegram 승인 슬래시 명령                  │
└───────────────────────────────────────────────────────────────────┘
```

#### 5.3.3 Directive 구현 (Jido)

```elixir
defmodule Sigma.Directive.ApplyFeedback do
  @enforce_keys [:team, :tier, :action, :rollback_spec]
  defstruct [:team, :tier, :action, :rollback_spec, :timeout]
end

defimpl Jido.Directive.Executor, for: Sigma.Directive.ApplyFeedback do
  def execute(%{team: team, tier: tier} = dir, context) do
    case tier do
      0 ->
        Sigma.Archivist.log_observation(dir)

      1 ->
        # Signal 송신만 (대상 팀이 수신 후 자율 판단)
        Jido.Signal.emit(%{
          type: "sigma.advisory.#{team}",
          source: "sigma",
          data: dir.action
        })

      2 ->
        # 설정 튜닝 + snapshot + 24h 자동 측정
        {:ok, snapshot} = Sigma.Config.snapshot(team)
        Sigma.Config.apply_patch(team, dir.action)
        schedule_rollback_check(dir, snapshot, after_ms: 24 * 3600 * 1000)

      3 ->
        # Mailbox + Telegram 승인 대기
        Sigma.Mailbox.enqueue(dir)
        Sigma.Notify.request_approval(dir)
    end
  end
end
```

#### 5.3.4 롤백 프로토콜 (Tier 2)

```elixir
defp schedule_rollback_check(dir, snapshot, after_ms: ms) do
  Process.send_after(self(), {:measure_effect, dir, snapshot}, ms)
end

def handle_info({:measure_effect, dir, snapshot}, state) do
  before_score = snapshot.metric_score
  after_score  = Sigma.Metric.collect(dir.team) |> score()

  cond do
    after_score < before_score * 0.9 ->
      # 효과 악화 10% 이상 → 자동 롤백
      Sigma.Config.restore(dir.team, snapshot)
      Sigma.Memory.remember("rollback: #{inspect(dir)}", :procedural)
      {:noreply, state}

    true ->
      # OK, 효과 유지/개선
      Sigma.Memory.remember("success: #{inspect(dir)}", :semantic)
      {:noreply, state}
  end
end
```

#### 5.3.5 자율 진입 조건 (Graduation Criteria)

자동 적용은 **학습된 신뢰도 기반**으로 티어 승격:

```
Tier 0 → Tier 1 승격:
  해당 (team, feedback_type) 조합의 관찰 횟수 ≥ 20
  AND 패턴 일관성 > 0.7 (같은 상황에 같은 권고)

Tier 1 → Tier 2 승격:
  Tier 1 발송 후 대상팀이 "수용"한 비율 ≥ 60%
  AND 수용 후 effective>0 비율 ≥ 70%

Tier 2 → Tier 3 승격:
  현재는 불가 (마스터 명시 승인 필요) — 장기 로드맵에서 검토
```

#### 5.3.6 세이프가드 — Circuit Breaker

어떤 티어든 **연속 3회 rollback** 발생 시 해당 (team, feedback_type)은 자동으로 Tier 0 강등 + 마스터 Telegram 알림.

---

### 5.4 피드백 루프 개선 — 4 Generation Loop

#### 5.4.1 현재 피드백 루프의 한계 분석

```
[현재]
수집 → 분석 → 권고 → DB 저장 → (7일 대기) → 효과 측정 → 주간 메타리뷰
  이진 effective (Elixir) / 연속 effectiveness% (TS)
  분석가 평균만 주간 회고, 팀별/타입별 분해 X
```

3가지 핵심 결함:
1. **권고 → 실행** 연결 없음 (→ 5.3에서 해결)
2. **효과 측정 → 프롬프트 업데이트** 없음 (→ GEPA 적용)
3. **실패 경험 활용** 없음 (→ Reflexion 패턴)

#### 5.4.2 목표: 4 Generation Loop

```
┌──────────────────────────────────────────────────────────────────┐
│ Gen 1: Observe & Hypothesize                                     │
│   Signal 수신 + Team Metric + 과거 기억(L2) → 가설 생성           │
│   (Sigma.Commander + jido_ai LLM 간단 호출)                     │
├──────────────────────────────────────────────────────────────────┤
│ Gen 2: Experiment Design                                         │
│   experiment-design skill → hypothesis/metric/baseline/variants  │
│   → Sigma.Directive.ApplyFeedback (Tier 1~2)                     │
├──────────────────────────────────────────────────────────────────┤
│ Gen 3: Measure & Reflect (24h + 7d 이중 측정)                    │
│   24h: 즉각 효과 체크 (Circuit Breaker 트리거)                    │
│   7d:  장기 효과 (기존 measurePastFeedbackEffectiveness 유지)      │
│   실패 시 → Reflexion 노트 자동 생성 → experience buffer         │
├──────────────────────────────────────────────────────────────────┤
│ Gen 4: Evolve (GEPA-inspired)                                    │
│   주간 메타리뷰 → 분석가 프롬프트/스킬을 GEPA로 진화              │
│   성공 패턴 → semantic memory 승격                                │
│   실패 패턴 → procedural "avoid" 기록                             │
│   Hermes Self-Evolution 패턴 직접 포팅                            │
└──────────────────────────────────────────────────────────────────┘
```

#### 5.4.3 Reflexion 노트 스키마

```elixir
defmodule Sigma.Reflexion do
  @moduledoc "실패 피드백에서 자연어 리플렉션 자동 추출"

  def reflect(feedback_row, outcome) do
    prompt = """
    시그마 분석가 "#{feedback_row.analyst_used}"가 팀 "#{feedback_row.target_team}"에
    다음 피드백을 제공했으나 실패했습니다.

    피드백: #{feedback_row.content}
    예상 효과: positive
    실제 효과: #{outcome.effectiveness_pct}%
    측정 지표 변화: #{inspect(outcome.metric_delta)}

    다음 세 질문에 답하세요 (각 2~3줄):
    1. 왜 이 피드백이 효과적이지 않았을 가능성이 높은가?
    2. 같은 상황에서 다른 피드백을 시도한다면 무엇이 좋을까?
    3. 이런 상황을 사전에 식별하려면 어떤 신호를 봐야 하는가?
    """

    {:ok, reflection} = Sigma.LLM.complete(prompt, model: :haiku, max_tokens: 500)

    %{
      feedback_id: feedback_row.id,
      analyst: feedback_row.analyst_used,
      team: feedback_row.target_team,
      reflection: reflection,
      tags: extract_tags(reflection)
    }
    |> Sigma.Memory.store(:procedural, importance: 0.7)
  end
end
```

다음 회차 분석 시:
```elixir
# Sigma.Commander.decide_formation/1 내부
recent_reflections = Sigma.Memory.recall(:procedural, %{
  team: team,
  analyst: analyst,
  limit: 3,
  threshold: 0.35
})

# LLM 컨텍스트에 주입
prompt = base_prompt <> """

[최근 유사 상황 실패에서 배운 것]
#{format_reflections(recent_reflections)}

이 교훈을 반영하여 다른 각도로 접근하세요.
"""
```

#### 5.4.4 24h + 7d 이중 측정

현재 단일 7일 측정은 너무 느림. 새로운 측정 윈도우:

```
Tier 2 자동 적용 시:
  T+1h:   sanity check (즉시 오류 감지)
  T+24h:  primary measurement — Circuit Breaker 트리거 기준
  T+7d:   long-term measurement — 메타 리뷰용
  T+30d:  trend measurement — 분기 회고용 (신규)
```

각 측정은 독립된 Jido Schedule directive:
```elixir
directives = [
  %Directive.Schedule{after_ms: 3_600_000,        signal: :sanity_check},
  %Directive.Schedule{after_ms: 86_400_000,       signal: :primary_measure},
  %Directive.Schedule{after_ms: 604_800_000,      signal: :longterm_measure},
  %Directive.Schedule{after_ms: 2_592_000_000,    signal: :trend_measure}
]
```

#### 5.4.5 GEPA로 분석가 프롬프트 진화

주간 메타리뷰 직후:
```elixir
defmodule Sigma.GEPA do
  @moduledoc "Generative Evolutionary Prompt Adaptation — 분석가 프롬프트 진화"

  def evolve_weekly do
    top_analysts = Sigma.Metric.weekly_top(limit: 3)
    bottom_analysts = Sigma.Metric.weekly_bottom(limit: 3)

    # Top 분석가의 성공 케이스 3건을 다른 분석가에게 crossover
    Enum.each(bottom_analysts, fn poor ->
      success_cases = Sigma.Memory.recall(:semantic, %{
        analyst: Enum.random(top_analysts),
        effective: true,
        limit: 3
      })

      new_prompt = Sigma.LLM.evolve_prompt(
        current: poor.prompt,
        success_samples: success_cases,
        method: :crossover
      )

      Sigma.Registry.update_prompt(poor.name, new_prompt, generation: poor.generation + 1)
    end)
  end
end
```

#### 5.4.6 Strict Write 적용

```elixir
# 현재: sigmaMemory.remember() 무조건 호출
# 개선:
defp persist_to_memory(feedback, outcome) do
  case outcome.effectiveness do
    eff when eff >= 0.3 ->
      # 성공 → semantic (장기 기억)
      Sigma.Memory.remember(summarize(feedback), :semantic, importance: min(eff, 1.0))

    eff when eff >= 0 and eff < 0.3 ->
      # 약한 성공 → episodic (30일 만료)
      Sigma.Memory.remember(summarize(feedback), :episodic, expires_in: :timer.hours(24 * 30))

    _negative ->
      # 실패 → procedural (avoid 패턴, Reflexion 노트와 함께)
      Sigma.Reflexion.reflect(feedback, outcome)
      Sigma.Memory.remember("AVOID: #{summarize(feedback)}", :procedural, importance: 0.75)
  end
end
```


---

### 5.5 n8n / RAG 재검토

#### 5.5.1 n8n — 시그마팀에는 **불필요** (현재 상태 유지)

**현재**: 프로젝트 전체에서 n8n 워크플로우는 `bots/video/n8n/video-pipeline-workflow.json` 단 1개. 시그마팀은 n8n 미사용.

**검토 결과**: 시그마팀에 n8n 도입은 **권고하지 않음**.

| 이유 | 설명 |
|------|------|
| Jido가 더 강력 | Jido의 Signal Routing + Directive 실행이 n8n 트리거/액션보다 타입 안전 |
| OTP supervision | 장애 복구가 n8n보다 우수 (cron-style 재실행 대비) |
| 성능 | in-process Elixir가 HTTP webhook 기반 n8n보다 10~100배 빠름 |
| 의존성 최소화 | n8n 서버 프로세스 + DB 분리 불필요 |
| n8n 자격증명 에러 | 팀 제이 운영 기록에 "n8n 자격증명 에러 미해결" 이슈 존재 |

**예외**: **비개발자 UI로 워크플로우를 시각 편집**해야 한다면 n8n 고려 (예: 마스터가 직접 편성 규칙 수정). 하지만 Jido는 Elixir 코드로 관리하는 것이 **설계 일관성** 면에서 우수.

**결정**: 시그마팀은 **n8n 도입 안 함**. 단, `bots/video` n8n 워크플로우는 별개 사안으로 유지.

#### 5.5.2 RAG — 구조 재설계: Hermes 3층 + Self-RAG

**현재 RAG 사용처**:
1. `rag.store(collection, content, metadata, scope)` — 직접 저장
2. `publishToRag(payload)` — reporting-hub 래퍼 (dedupe + cooldown)
3. `sigmaMemory.remember()` — agent-memory 경유
4. `sigmaMemory.recall(query, opts)` — episodic/semantic 두 타입

**관찰된 문제**:
- 동일 내용이 여러 경로로 저장 (rag + reporting-hub + agent-memory)
- Strict Write 부재 → 실패 경험도 무조건 저장
- 회수 시 Self-RAG 검증 없음 → 관련 없는 기억이 컨텍스트 오염

#### 5.5.3 목표 RAG 아키텍처 (Hermes 3층)

```
┌────────────────────────────────────────────────────────────────┐
│ L1 — 세션 메모리 (in-memory ETS)                                │
│   현재 runDaily() 실행 중의 intermediate state                  │
│   Elixir ETS 테이블, 프로세스 종료 시 소멸                      │
│   크기: 수 MB 수준                                             │
├────────────────────────────────────────────────────────────────┤
│ L2 — 영구 메모리 (PostgreSQL + pgvector)                        │
│   episodic (30일 TTL) + semantic (영구)                        │
│   기존 agent-memory.ts 로직 유지 + Elixir 포팅                  │
│   회수: cosine 유사도 + Self-RAG 게이트                        │
│   크기: 수 GB까지 무제한 (pgvector)                             │
├────────────────────────────────────────────────────────────────┤
│ L3 — 스킬 메모리 (마크다운 파일, 점진적 노출)                    │
│   `packages/core/lib/skills/sigma/` 각 스킬은                   │
│     L0: 이름 + 1줄 설명 (기본 로드, 20토큰/skill)              │
│     L1: 전체 스킬 문서 (호출 시에만 로드)                       │
│   Jido plugin이 on-demand 로드                                  │
└────────────────────────────────────────────────────────────────┘
```

#### 5.5.4 Self-RAG 게이트 구현

```elixir
defmodule Sigma.SelfRAG do
  @moduledoc """
  Self-RAG 논문 패턴: retrieve? → isRel? → isSup? → isUse?
  회수 전/후 LLM으로 필요성/관련성 판단.
  """

  def retrieve(query, opts \\ []) do
    # 1. retrieve? — 이 질문에 RAG가 필요한가?
    if needs_retrieval?(query) do
      raw_hits = Sigma.Memory.recall(query, opts)
      # 2. isRel? — 각 hit이 실제로 관련 있는가?
      relevant = Enum.filter(raw_hits, &relevant?(&1, query))
      # 3. isSup? — 이 hit이 주장을 지지하는가?
      supporting = Enum.filter(relevant, &supports_claim?(&1, query))
      # 4. isUse? — 사용할 만한 품질인가?
      useful = Enum.filter(supporting, &useful_quality?/1)
      useful
    else
      []
    end
  end

  defp needs_retrieval?(query) do
    # 간단 휴리스틱 + LLM 짧은 호출 (hit/miss 이진)
    String.length(query) > 20 and not trivial_query?(query)
  end
end
```

#### 5.5.5 pgvector 활용 상태

**현재** 이미 프로젝트에 pgvector 확장 적용됨 (memory 기록 참조). 좋은 기반.

**개선**:
- **GraphRAG 추가** 검토: 피드백 간 인과 관계 그래프 (neo4j 대신 PostgreSQL recursive CTE로 시작)
- **Hybrid search**: pgvector 코사인 + PostgreSQL FTS (tsvector) 병행

---

### 5.6 다윈팀 TS Only 분리

#### 5.6.1 다윈팀 현재 상태

```
bots/darwin/ 총 2,838 LOC
├ src/ (테스트 파일) — research-task-runner-smoke / research-monitor-smoke
├ scripts/research-task-runner.ts
└ lib/
   ├ research-scanner.ts      (612 LOC)  — arXiv/HF 스캔
   ├ research-tasks.ts        (512 LOC)  — 태스크 관리
   ├ implementor.ts           (407 LOC)  — 구현 에이전트
   ├ verifier.ts              (295 LOC)  — 검증
   ├ applicator.ts            (252 LOC)  — 적용
   ├ arxiv-client.ts          (150 LOC)  — arXiv API
   ├ research-monitor.ts      (111 LOC)  — 모니터링
   ├ event-reminders.ts       (94  LOC)
   ├ autonomy-level.ts        (77  LOC)
   └ (기타 research-evaluator, keyword-evolver, hf-papers-client, proposal-store 등)

JS 파일 존재 여부: **0개** (이미 100% TS!)
Elixir 포트 존재 여부: elixir/team_jay/lib/team_jay/darwin/ 존재 (확인 필요)
```

#### 5.6.2 TS only 분리 전략

**결정**: 다윈팀은 **TS로 남기고, 시그마팀과는 Signal로만 통신**.

**근거**:
1. 다윈팀은 이미 2,838 LOC TS, **JS 0개** → 이미 거의 완료 상태
2. 다윈팀 주업무는 **arXiv/HF 논문 크롤링 + LLM 요약**이므로 Node.js 생태계 이점 큼 (fetch/cheerio/axios 등)
3. Elixir로 포팅하면 JSON 파싱/LLM 스트리밍/외부 SDK 이용이 비효율
4. 시그마 ↔ 다윈 통신은 **이벤트 주도**이므로 Signal로 충분 (프로세스 경계 OK)

#### 5.6.3 시그마 → 다윈 이벤트 인터페이스

Jido Signal을 다윈팀이 수신하도록 연결:

```typescript
// bots/darwin/src/signal-receiver.ts (새 파일)
import { connect as connectHub } from '@team-jay/core/signal-hub';

const hub = connectHub({ endpoint: process.env.TJ_SIGNAL_HUB_URL });

hub.subscribe('sigma.advisory.darwin', async (signal) => {
  // 시그마가 "다윈에 지식 축적 권고"를 보낼 때
  if (signal.data.action === 'knowledge_capture') {
    await triggerStandingOrderPromotion(signal.data);
  }
});

hub.subscribe('sigma.directive.darwin.config_patch', async (signal) => {
  // Tier 2 자동 적용 시 다윈 설정 수정
  await applyConfigPatch(signal.data.patch, { rollbackSpec: signal.data.rollback });
});
```

#### 5.6.4 Elixir 잔여 다윈 코드 처리

**확인 필요**: `elixir/team_jay/lib/team_jay/darwin/` 경로의 존재 여부 + 기능. **만약 존재하면**:
- 기능이 TS에 동일하게 있는지 확인 → 중복이면 Elixir 쪽 삭제 (archive)
- TS에 없는 기능이면 **TS로 포팅 후** Elixir 삭제

**명령 예시** (다음 세션에서 실행):
```bash
# 확인
ls elixir/team_jay/lib/team_jay/darwin/ 2>/dev/null
# 존재 시 별도 SESSION에서 정리
```

#### 5.6.5 다윈팀 독자 개선 로드맵 (리모델링 범위 밖)

리서치 컴프리헨시브 §17-18에 이미 상세 기술:
- Sprint 1: arXiv + HF Papers 자동 스캔 사이클
- Sprint 2: 논문 → 적용 가능성 자동 평가 (proof-r + skeptic-r)
- Sprint 3: AI Scientist v2 패턴 도입 (scholar → edison → proof-r)

이 부분은 **본 리모델링에서 분리**, 다윈팀 독자 리모델링으로 진행.

---

## 6. 단계적 실행 계획 Phase 0~5

### Phase 0 — 준비 (1주)

**목표**: 기존 시그마팀 운영 중단 없이 Elixir 기반 리모델링을 시작할 수 있는 기반 구축

**작업**:
1. `mix.exs`에 Jido 생태계 의존성 추가 (`jido ~> 2.0`, `jido_action`, `jido_signal`, `jido_ai`, `req_llm`)
2. `elixir/team_jay/lib/team_jay/sigma/v2/` 새 디렉토리 생성 (v2 네임스페이스)
3. 기존 `lib/team_jay/jay/sigma/*`는 유지 (shadow mode 비교용)
4. `docs/SIGMA_REMODELING_PLAN_2026-04-17.md` 마스터 승인
5. 롤백 계획 문서 작성 (`docs/SIGMA_REMODELING_ROLLBACK.md`)

**인도물**:
- mix.lock 업데이트
- 빈 모듈 skeleton: `Sigma.V2.Commander`, `Sigma.V2.Pod`, `Sigma.V2.Skill.*`
- 마스터 승인 서명 (이 문서에 approval_ts 추가)

**Exit Criteria**:
- `mix deps.get` 성공
- `mix compile` 경고 없음
- 기존 `runDaily()` cron은 그대로 동작 중

### Phase 1 — Elixir Jido 기반 코어 구축 (2~3주)

**목표**: Jido Agent 3개 + Pod 1개 + Skill 5개 Elixir 포팅 + shadow mode 병렬 실행

**작업**:

**1.1 Sigma.V2.Commander** (메인 오케스트레이터)
- Jido.Agent로 구현
- `cmd(:decide_formation, ctx)` → {agent, [SpawnAgent, Schedule]}
- 기존 `decideTodayFormation()` 로직 포팅
- LLM 판단 5% 추가 (Phase 1에서는 플래그 off로 시작)

**1.2 Sigma.V2.Pod.* (3개 Pod: risk/growth/trend)**
- 각 Pod은 2~3명 분석가를 보유
- `Sigma.V2.Pod.Risk` = [hawk, optimizer]
- `Sigma.V2.Pod.Growth` = [dove, librarian]
- `Sigma.V2.Pod.Trend` = [owl, forecaster]

**1.3 Sigma.V2.Skill.* (5개)**
- `data_quality_guard`, `causal_check`, `experiment_design`, `feature_planner`, `observability_planner`
- 각각 `jido_action` Action으로 포팅 (기존 TS 로직 100% 보존)
- NimbleOptions schema 추가

**1.4 Shadow Mode**
- 현재 `runDaily()`가 실행 후, Elixir v2 Commander도 **병렬 실행 (but write to sigma_v2.* 테이블)**
- 결과 비교 대시보드 (Sigma.Observer)

**Exit Criteria**:
- 7일간 shadow mode 운영
- `sigma.daily_runs` vs `sigma_v2.daily_runs` 비교에서 feedback 생성 ≥95% 일치
- 분석가 선택 ≥80% 일치 (ε-greedy 랜덤 고려)
- Elixir 쪽 측정값이 TS와 ±10% 이내

### Phase 2 — Directive Executor + Tier 0/1 자율 (2주)

**목표**: 피드백 → 대상 팀 실제 전달 경로 구축, Tier 0 (관찰) + Tier 1 (Signal advisory) 자동 적용

**작업**:

**2.1 Sigma.Directive.ApplyFeedback**
- 구현체 5.3.3 코드 기반
- Tier 0/1만 먼저 활성화 (Tier 2/3는 mock)
- Tier 1 Signal은 `sigma.advisory.<team>` 타입

**2.2 각 팀 Signal.Receiver**
- blog/luna/worker/ska/claude/darwin에 `signal-receiver.ts` (또는 .ex) 추가
- `sigma.advisory.*` 구독
- 수신 시 로그만 (자동 행동 X, 팀 내부에서 자율 판단)

**2.3 Sigma.Mailbox** (Tier 3 준비)
- Tier 3 directive는 Mailbox enqueue
- 현재는 mailbox만 축적, Phase 4에서 처리 로직 구현

**Exit Criteria**:
- Tier 0: 14일 운영, 관찰 로그 수 ≥200개
- Tier 1: 14일 운영, Signal 수신 팀에서 "수용 카운트" 수집 ≥50건

### Phase 3 — Tier 2 자율 + Self-RAG + Reflexion (3주)

**목표**: 경량 자동 개입 + Self-RAG 회수 게이트 + Reflexion 노트 자동 생성

**작업**:

**3.1 Sigma.Config.snapshot/apply_patch/restore**
- 팀별 `config.json` snapshot/restore
- Directive.ApplyFeedback(tier: 2) 구현 완성
- 24h auto-rollback (측정 후 effectiveness < 0 → 자동 복원)

**3.2 Sigma.SelfRAG**
- needs_retrieval? / relevant? / supports_claim? / useful_quality?
- `Sigma.Memory.recall/3` 래핑

**3.3 Sigma.Reflexion**
- 실패 시 LLM 호출 (Haiku, 500 tokens) → procedural memory 저장
- 다음 회차 추천 시 자동 회수 + 프롬프트 주입

**3.4 Strict Write**
- `persist_to_memory/2` 구현 (effectiveness 기반 분기)

**Exit Criteria**:
- Tier 2 자동 적용 ≥20건
- 자동 롤백 성공률 100% (실패 10%+ 감지 시 복원)
- Reflexion 노트 ≥30건 축적
- Self-RAG 회수 품질 (hit relevance) ≥70%

### Phase 4 — GEPA 진화 + 주간 메타리뷰 확장 (2주)

**목표**: 분석가 프롬프트 유전적 진화 + 다차원 회고

**작업**:

**4.1 Sigma.GEPA.evolve_weekly/0**
- 5.4.5 코드 구현
- Top 3 / Bottom 3 분석가 식별
- crossover + mutation 전략 (DSPy Evaluate Set 활용)
- 세대 번호 추적 (generation++)

**4.2 주간 메타리뷰 확장**
- 현재: 분석가 평균만
- 추가: 팀별 / 피드백 타입별 / 요일별 / 시간대별 분해
- 대시보드: Jido Observe + Sigma.Heatmap

**4.3 분석가 프롬프트 버전 저장**
- `sigma.analyst_prompts` 신규 테이블: (name, generation, prompt_text, fitness_score, created_at)

**Exit Criteria**:
- GEPA 4주 실행, Bottom → Top 진화 비율 ≥25%
- 주간 메타리뷰 대시보드 마스터 검토 완료

### Phase 5 — TS 폐기 + MCP 서버 + 다윈 분리 (2주)

**목표**: 기존 TS 시그마 코드 폐기, MCP 서버 공개 노출, 다윈팀 Signal 연결

**작업**:

**5.1 TS 시그마 폐기**
- `bots/orchestrator/lib/sigma/*.ts` → `docs/archive/sigma-legacy/` 이관
- `bots/orchestrator/src/sigma-daily.ts` → thin adapter로 축소 (Jido v2 호출)
- `packages/core/lib/skills/sigma/*.ts` → Elixir Jido Action으로 교체 완료 후 archive

**5.2 Sigma MCP Server**
- `elixir/team_jay/lib/team_jay/sigma/mcp_server.ex`
- 5개 skill을 MCP tool로 노출
- Progressive Disclosure (L0 이름만 → L1 전체)

**5.3 다윈 Signal 수신**
- `bots/darwin/src/signal-receiver.ts` 신규
- `sigma.advisory.darwin` 구독

**5.4 Elixir `darwin` 잔여 코드 정리**
- `elixir/team_jay/lib/team_jay/darwin/` 확인 + TS로 이관 or 삭제

**Exit Criteria**:
- TS 시그마 코드 0 LOC (thin adapter 50줄 제외)
- MCP tool 5개 외부에서 호출 가능 (claude.ai/Codex)
- 다윈팀 TS only 확정 (JS 0, Elixir 0)
- 다윈이 sigma.advisory 수신 후 TELEMETRY 증가 확인


---

## 7. 리스크 + 롤백 전략

### 7.1 리스크 매트릭스

| ID | 리스크 | 확률 | 영향 | 완화 | 롤백 |
|----|--------|------|------|------|------|
| R-01 | Jido 학습 곡선으로 Phase 1 지연 | 中 | 中 | 이미 Elixir 포트 일부 존재, Jido 예제 풍부 | Phase 0 연장 |
| R-02 | Shadow mode에서 v2 결과가 v1과 크게 차이 | 低 | 高 | 7일 shadow + 95% 일치 확인 후 전환 | v1 유지, v2 원인 조사 |
| R-03 | Tier 2 자동 적용이 대상팀에 혼란 | 中 | 高 | 24h rollback + Circuit Breaker | 자동 롤백 + Tier 0 강등 |
| R-04 | Reflexion 노트가 LLM 토큰 예산 초과 | 低 | 低 | Haiku 500 tokens/건, 일일 상한 $2 | LLM 호출 차단 + 로그만 |
| R-05 | GEPA가 잘못된 방향으로 프롬프트 진화 | 低 | 中 | fitness_score 보수적, 세대 간 재현 안정성 체크 | 이전 generation 복원 |
| R-06 | MCP 서버가 외부에 민감 데이터 노출 | 低 | 高 | Bearer Token + 화이트리스트 (Hub 방어 참조) | MCP 서버 중단 |
| R-07 | Elixir 전환 중 피드백 효과 측정 끊김 | 中 | 中 | TS `measurePast`는 Phase 3까지 유지 | 없음 (이중 쓰기) |
| R-08 | 다윈팀 Signal 연결이 race condition 유발 | 低 | 低 | Signal 소비자 측 idempotency | Signal 재전송 스킵 |

### 7.2 단계별 롤백 조건

| Phase | 롤백 트리거 | 롤백 절차 |
|-------|-------------|-----------|
| P0 | mix compile 실패 | deps revert |
| P1 | shadow 7일간 불일치 > 20% | v2 코드 archive, v1 유지 |
| P2 | Tier 1 Signal 수신 팀에서 에러 10%+ | Signal emit off |
| P3 | 자동 rollback 이후에도 팀 지표 회복 안 됨 | Tier 2 off + manual review |
| P4 | GEPA로 진화된 프롬프트의 fitness가 평균 이하 | generation revert |
| P5 | MCP 서버 보안 사고 | MCP 중단 + 감사 |

### 7.3 롤백 Kill Switch

각 Phase에 **환경변수 Kill Switch** 배치:
```bash
SIGMA_V2_ENABLED=false           # 전체 v2 비활성
SIGMA_TIER2_AUTO_APPLY=false     # Tier 2 자동 적용 비활성
SIGMA_GEPA_ENABLED=false         # GEPA 진화 비활성
SIGMA_MCP_SERVER_ENABLED=false   # MCP 서버 비활성
SIGMA_SELF_RAG_ENABLED=false     # Self-RAG 비활성
```

OTP supervision + 환경변수로 **30초 내 전체 롤백** 가능.

### 7.4 이중 안전장치 (28차 감사 교훈 반영)

시그마팀 리모델링 관련 모든 AUDIT-equivalent 프롬프트는:
1. `docs/codex/SIGMA_*` (로컬 전용, gitignore)
2. `docs/SESSION_HANDOFF_*`에 **핵심 요약 이중 기록**

→ 한 세션의 아카이브 정리로 코덱스 프롬프트 손실 시 복원 가능.

---

## 8. KPI + 성공 기준

### 8.1 정량 KPI (Phase별)

| KPI | 현재 | Phase 2 후 | Phase 3 후 | Phase 5 후 |
|-----|------|-------------|-------------|-------------|
| 마스터 일일 개입 횟수 | 5~10회 | 3~5회 | 1~2회 | 0.5회 (주 1~2회) |
| 피드백 효과 발현 (중앙값) | 7일 | 7일 | 24h | 24h |
| 피드백 → 실행 전환율 | 0% | 30% (Tier 1) | 70% (Tier 1+2) | 70%+ |
| 자동 롤백 성공률 | N/A | N/A | >95% | >99% |
| 일일 Reflexion 노트 | 0 | 0 | 5~10건 | 10~20건 |
| 분석가 평균 효과 (연속값) | baseline | baseline | +15% | +30% |
| Self-RAG 회수 품질 | N/A | N/A | >70% | >85% |
| GEPA 진화 세대수 | 0 | 0 | 0 | 4+ |
| MCP tool 외부 호출 | 0 | 0 | 0 | >100/주 |

### 8.2 정성 성공 기준

- [ ] 마스터가 "시그마팀은 자율적으로 돈다"고 인정
- [ ] 다른 팀장(Luna/Blog/Worker)이 sigma.advisory Signal을 "유용하다"고 피드백
- [ ] 잘못된 자동 적용이 1회 이상 발생해도 **자동 롤백으로 복구**되어 운영 중단 없음
- [ ] 시그마 로직 변경 시 **TS + Elixir 이중 수정이 불필요** (Elixir만)
- [ ] 시그마 → 다윈팀 Signal로 자율 연구 사이클의 **초기 트리거** 제공
- [ ] 시그마팀 자체가 Jido + Hermes 패턴의 **레퍼런스 구현**이 되어 다른 팀 리모델링 참조 자료가 됨

### 8.3 장기 비전 지표 (1년 후)

- **대도서관 심장으로서의 기여**:
  - 시스템 전체 자동 개선 사이클 > 월 50회
  - 사이클당 평균 유효 효과 > 0.4 (현재 heuristic effectiveness 기준)
  - 마스터는 **전략 결정**에만 집중 (일일 운영 개입 <5%)

---

## 9. 외부 보강 포인트 (향후)

본 설계 문서는 29차 세션 도구로 가능한 범위에서 완성. 아래 항목은 **새 세션에서 `web_search` + Chrome MCP + 크롬 MCP를 모두 활성화**한 상태에서 최신 정보로 보강 권장:

### 9.1 검증 대상 외부 자료

1. **Jido v2 공식 문서 (hexdocs.pm/jido)** — v2.x 최신 API 변경사항, Pod 토폴로지 상세
2. **jido_ai 통합 가이드** — Claude/Ollama 백엔드 실제 통합 코드 샘플
3. **Hermes Agent self-evolution DSPy GEPA 논문** — GEPA 알고리즘 상세 (evolve_prompt 구현 참고)
4. **Reflexion 논문 공식 코드** (noahshinn024/reflexion) — 실패 → 리플렉션 변환 정확한 공식
5. **Self-RAG 논문** (Asai et al., ICLR 2024) — 4 gate 구현 상세
6. **STELLA paper** — 바이오의학 자기진화 정확도 2배 달성 메커니즘
7. **CloudEvents v1.0 spec** — Jido Signal이 따르는 envelope 표준 재확인
8. **OpenTelemetry Elixir** — Jido Observe 연동 최신 방식
9. **Paperclip v2 GitHub** — Goal Ancestry 구현 세부사항 확인
10. **AgentsOS / AgentFactory / SAGE / EvoSkill** (RESEARCH_CC §18 참조) — 추가 패턴 검토

### 9.2 검증할 가정

- **Hermes Agent 별 수**: 본 설계는 95K★로 기록, ECC 가이드는 8.7K★로 기록. 29차 세션에서 GitHub API로 95K 확인했으나 ECC 가이드의 8.7K가 잘못인지 재검증 필요
- **Jido v2 안정성**: 2026-04-14 최신 커밋 확인, but production deployment 사례 확인 필요
- **GEPA 실전 효과**: 논문과 실제 오픈소스 구현 간 성능 차이

### 9.3 별도 세션에서 진행 권고

- `docs/SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md` 작성 — 9.1 자료 모두 읽고 본 문서 Delta 작성
- **크롬 MCP로 Jido 공식 사이트(jido.run) 튜토리얼 실행** — 로컬에서 `Hello World` Jido Agent 성공 확인
- **agentjido/jido_ai 리포 샘플 실행** — Claude 백엔드 통합 동작 검증

---

## 📌 승인 프로토콜

**본 설계서의 승인 단위**:
- Phase 0: 마스터 승인 필요 (본 문서 최종 승인)
- Phase 1~5: 각 Exit Criteria 달성 시 메티 → 마스터 보고 → 다음 Phase 착수

**마스터 승인 서명**:
- [ ] 승인 (날짜 / 서명): ________________
- [ ] 조건부 승인 (조건): ________________
- [ ] 보류 — 보강 요청 항목: ________________

---

## 🏁 결론

시그마팀은 **데이터 수집·분석·피드백·개선의 폐쇄 루프**로 동작하며 대도서관의 심장 역할을 해야 합니다. 현재 구현은 "관찰자" 수준에 그쳐 있으며, 핵심 결함은 **피드백 → 실행 경로 부재**와 **죽은 skills**입니다.

본 리모델링 계획은:
1. **Jido + OTP로 Elixir 전면 전환**하여 장애 복구 + 병렬화 + Reactive 확보
2. **4티어 리스크 게이트**로 승인 루프 없이 안전한 자동 적용
3. **Reflexion + Self-RAG + GEPA + Strict Write**로 진정한 자기 개선 루프 구축
4. **MCP 서버**로 skill을 외부 LLM에도 노출
5. **다윈팀은 TS로 두고** Signal로 연결

Phase 0~5, 약 **12주** 로드맵으로 실행. 각 Phase는 독립적 Exit Criteria로 **Kill Switch 30초 롤백** 지원.

시그마팀이 완성되면 Team Jay 전체가 **Hermes 패턴의 자기 진화 시스템**으로 변모할 것이며, 마스터는 전략 결정에만 집중할 수 있습니다.

---

**작성**: 메티 (Metis, claude.ai) / 2026-04-17 29차 세션
**검토 요청**: 마스터 (제이)
**다음 단계**: Phase 0 준비 시작 전 마스터 승인 서명 요청
