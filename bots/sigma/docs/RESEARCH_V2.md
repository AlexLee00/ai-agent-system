# 시그마팀 리모델링 — 외부 보강 연구 v2 (실전 구현 층)

> **작성일**: 2026-04-17 (32차 세션)
> **작성자**: 메티 (Metis, claude.ai)
> **상위 문서**:
> - `docs/SIGMA_REMODELING_PLAN_2026-04-17.md` (1,405줄, 원본 설계)
> - `docs/SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md` (373줄, 30차 v1 보강)
> **이 문서 위치**: v1(개념·논문) → v2(실전·버전·API) 층으로 심화
> **상태**: Phase 0 착수 전 최종 보강 — 마스터 승인에 영향

---

## 📋 목차

1. [v2 요약](#1-v2-요약)
2. [Jido 생태계 실제 버전 확정](#2-jido-생태계-실제-버전-확정)
3. [Jido 2.2 실전 API 샘플](#3-jido-22-실전-api-샘플)
4. [agentskills.io — Anthropic 공식 포맷 대발견](#4-agentskillsio--anthropic-공식-포맷-대발견)
5. [설계서 의존성 표 교체](#5-설계서-의존성-표-교체)
6. [Phase 0 코덱스 프롬프트 수정사항](#6-phase-0-코덱스-프롬프트-수정사항)
7. [추가 기각 + 승격](#7-추가-기각--승격)

---

## 1. v2 요약

30차 보강이 **논문·개념 층**이었다면, 32차 v2는 **실전 구현·버전·API 층**. 핵심 결론:

### 1.1 5대 핵심 발견

1. **Jido 실제 최신 2.2.0** (2026-03-29 릴리스, downloads 34,155)
2. **jido_action / jido_signal / jido_ai / req_llm 4개 패키지 모두 hex.pm 실존** — 각각 별도 설치 필요 (29차 설계대로)
3. **Jido 2.2는 `Zoi` 스키마 사용** (NimbleOptions 아님) + **`Jido.AI.Agent`** 매크로 (Jido.Agent 아님!)
4. **`req_llm 1.9.0` 다운로드 89,895회** — Jido 생태계 중 가장 인기, Anthropic/OpenAI/Google 통합 추상화
5. **🏆 `agentskills.io` = Anthropic 공식 오픈 포맷** (16,451★, `github.com/agentskills/agentskills` maintained by Anthropic)

### 1.2 설계서에 반영할 변경 5건

| # | 변경 |
|---|------|
| D-01 | **의존성 버전 업데이트**: 모든 `jido_*` 및 `req_llm` 2.x/1.9.x로 명시 |
| D-02 | **NimbleOptions → Zoi 스키마 교체** (Skill Action 정의 코드 샘플) |
| D-03 | **`Jido.AI.Agent` 매크로 사용** (Commander + Pod 정의) |
| D-04 | **Skills를 `agentskills.io` 포맷으로 작성** (Anthropic 공식 표준 — `github.com/anthropics/skills` 참조) |
| D-05 | **CloudEvents 별도 패키지 제거** (`jido_signal`이 이미 CloudEvents envelope 구현) |

---

## 2. Jido 생태계 실제 버전 확정

### 2.1 hex.pm API 결과 (2026-04-17 조회)

| 패키지 | 최신 버전 | 릴리스 날짜 | 총 다운로드 | 주간 다운로드 | 설명 |
|--------|-----------|-------------|-------------|---------------|------|
| **jido** | **2.2.0** | 2026-03-29 | 34,155 | 2,513 | 자율 에이전트 프레임워크 |
| **jido_action** | **2.2.1** | recent | 17,082 | — | 검증된 액션 + AI tool 통합 |
| **jido_signal** | **2.1.1** | recent | 25,116 | — | CloudEvents envelope + pub/sub |
| **jido_ai** | **2.1.0** | 2026-03-14 | — | — | AI 런타임 레이어 |
| **req_llm** | **1.9.0** | — | **89,895** | — | LLM HTTP 추상화 (가장 인기!) |
| **postgrex** | **1.0.0-rc.1** | — | 134,013,916 | — | PostgreSQL 드라이버 |
| **opentelemetry** | **1.7.0** | — | 27,243,027 | — | OTel Elixir |
| **cloudevents** | 0.6.1 | — | 37,801 | — | ⚠️ 필요 없음 (jido_signal 포함) |

### 2.2 Jido 릴리스 히스토리 (활발함 확인)

```
2.2.0   — 2026-03-29  (현재 최신)
2.1.0   — 2026-03-14
2.0.0   — 2026-02-22  (stable 첫 릴리스)
2.0.0-rc.5 — 2026-02-16
2.0.0-rc.4 — 2026-02-07
```

**최신 2개월 내 4개 릴리스** — 매우 활발, 하지만 RC→2.2.0까지 안정화 기간 확보.

### 2.3 다운로드 순위 해석

`req_llm`이 가장 많이 쓰인다는 건 **Jido 없이도 많은 Elixir 프로젝트가 req_llm을 LLM 통합에 사용**한다는 뜻. 시그마팀이 `req_llm` 의존하면 **큰 생태계에 합류** 효과.

---

## 3. Jido 2.2 실전 API 샘플

### 3.1 실제 jido_ai README에서 발췌 (검증된 패턴)

```elixir
# 1. Action 정의 — Zoi 스키마 사용 (v1 설계의 NimbleOptions 교체)
defmodule MyApp.Actions.AddNumbers do
  use Jido.Action,
    name: "add_numbers",
    schema: Zoi.object(%{a: Zoi.integer(), b: Zoi.integer()}),
    description: "Add two numbers."

  @impl true
  def run(%{a: a, b: b}, _context), do: {:ok, %{sum: a + b}}
end

# 2. Agent 정의 — Jido.AI.Agent 매크로 (Jido.Agent 아님!)
defmodule MyApp.MathAgent do
  use Jido.AI.Agent,
    name: "math_agent",
    model: :fast,                      # model alias (fast/smart/local/...)
    tools: [MyApp.Actions.AddNumbers],
    system_prompt: "Solve accurately. Use tools for arithmetic."
end

# 3. 에이전트 실행 — AgentServer + ask_sync
{:ok, pid} = Jido.AgentServer.start(agent: MyApp.MathAgent)
{:ok, answer} = MyApp.MathAgent.ask_sync(pid, "What is 19 + 23?")

# 4. 에이전트 없이 직접 호출 (stateless)
{:ok, result} = Jido.AI.generate_text("What is the capital of France?")
{:ok, result} = Jido.AI.ask("...")
{:ok, result} = Jido.Exec.run(MyApp.Actions.AddNumbers, %{a: 19, b: 23})
```

### 3.2 시그마팀에 적용한 재작성

**원본 v1 설계의 skeleton**:
```elixir
defmodule Sigma.V2.Skill.DataQualityGuard do
  use Jido.Action,
    name: "data_quality_guard",
    description: "...",
    schema: [                         # ❌ NimbleOptions keyword list
      rows: [type: {:list, :map}, required: true],
      required_fields: [type: {:list, :string}, default: []],
      ...
    ]
end
```

**v2 수정 (실제 Jido 2.2 API)**:
```elixir
defmodule Sigma.V2.Skill.DataQualityGuard do
  use Jido.Action,
    name: "data_quality_guard",
    description: "Evaluate dataset for duplicates, missing, stale, outliers",
    schema: Zoi.object(%{                         # ✅ Zoi 스키마
      rows: Zoi.list(Zoi.map()),
      required_fields: Zoi.optional(Zoi.list(Zoi.string()), default: []),
      freshness_field: Zoi.optional(Zoi.string(), default: nil),
      freshness_threshold_days: Zoi.optional(Zoi.integer(), default: 7),
      numeric_fields: Zoi.optional(Zoi.list(Zoi.string()), default: [])
    })

  @impl Jido.Action
  def run(params, _context) do
    # data-quality-guard.ts 114줄 로직을 Elixir 포팅
    result = %{
      passed: evaluate_pass(params),
      quality_score: compute_quality(params),
      issues: detect_issues(params),
      stats: compute_stats(params)
    }
    {:ok, result}
  end
end
```

### 3.3 Commander 재작성

```elixir
defmodule Sigma.V2.Commander do
  use Jido.AI.Agent,                              # ✅ Jido.AI.Agent
    name: "sigma_commander",
    model: :smart,                                # Claude Sonnet 계열
    tools: [
      Sigma.V2.Skill.DataQualityGuard,
      Sigma.V2.Skill.CausalCheck,
      Sigma.V2.Skill.ExperimentDesign,
      Sigma.V2.Skill.FeaturePlanner,
      Sigma.V2.Skill.ObservabilityPlanner,
      Sigma.V2.Skill.CollectTeamMetric
    ],
    system_prompt: """
    당신은 시그마팀 Commander입니다. 대도서관(팀 제이)의 메타 오케스트레이터로,
    매일 어제 이벤트와 팀 메트릭을 바탕으로 오늘 편성을 결정합니다.

    원칙은 config/sigma_principles.yaml을 따르며, 절대 금지 사항(P-001~004)은
    Tier 3로 강제합니다. Directive 실행 전 반드시 self-critique 수행.
    """
end
```

---

## 4. agentskills.io — Anthropic 공식 포맷 대발견

### 4.1 사실 관계

- **`github.com/agentskills/agentskills`**: 16,451★, maintained by **Anthropic**
- 홈페이지: https://agentskills.io
- 구조: spec + docs + reference SDK + example skills
- Example skills 리포: **`github.com/anthropics/skills`**
- 라이선스: Code Apache 2.0, Docs CC-BY-4.0

### 4.2 의미

시그마팀이 skill을 agentskills.io 포맷으로 만들면:
1. **Anthropic 공식 생태계 합류** — Claude Code, Claude.ai, Hermes가 같은 포맷 사용
2. **우리가 쓰는 Claude Code에서 즉시 로드 가능** — 마스터/메티가 개발 중에도 skill 활용
3. **"쓰는 도중 학습"** — Hermes 4단계 학습 루프가 이 포맷 전제
4. **향후 Paperclip/Hermes로 이주 시 변환 불필요**

### 4.3 skill 포맷 (30차 ECC 가이드에서 언급한 YAML frontmatter와 일치)

```markdown
---
name: data-quality-guard
description: "Evaluate dataset for duplicates, missing, stale, outliers"
version: 1.0.0
tools: [...]
model: sonnet
---

# Data Quality Guard

## When to Use
When a new dataset arrives and needs validation before downstream processing.

## Process
1. Check for duplicates (JSON fingerprint)
2. Check for missing required fields
3. Check for freshness (threshold_days)
4. Check for outliers (median ± 5*|median|)

## Returns
- passed: boolean
- quality_score: 0-10
- issues: array
- stats: {total_rows, duplicate_rows, missing_rows, stale_rows, outlier_rows}
```

### 4.4 v2 설계 변경

**설계서 §5.2 하이브리드 전략 재작성**:

```
Layer 1: Jido Action (Elixir 네이티브, 고성능)
  - Sigma.V2.Skill.* 모듈, Zoi 스키마

Layer 2: agentskills.io 포맷 (Anthropic 공식 표준)  ← NEW!
  - bots/sigma/skills/*.md (각 skill 마크다운)
  - github.com/anthropics/skills 예제 참조
  - Claude Code에서 바로 로드 가능

Layer 3: MCP 서버 (Jido 기반, agentskills 호환)
  - sigma-mcp-server.exs
  - agentskills.io 포맷의 마크다운을 MCP tool로 자동 노출
```

즉 **1개 skill 정의가 3개 레이어에 자동 노출**되도록 설계 (DRY).

---


## 5. 설계서 의존성 표 교체

### 5.1 원본 (29차 설계서 §6 Phase 0 + 30차 v1 보강)

```elixir
{:jido, "~> 2.0"},
{:jido_action, "~> 1.0"},       # ❌ 1.x가 아니라 2.2.1
{:jido_signal, "~> 1.0"},       # ❌ 1.x가 아니라 2.1.1
{:jido_ai, "~> 1.0"},            # ❌ 1.x가 아니라 2.1.0
{:req_llm, "~> 1.0"},            # ⚠️ 1.x 맞지만 1.9.x까지 올라와 있음
{:postgrex, "~> 0.20"},
{:cloudevents, "~> 0.6"},        # ❌ 필요 없음 (jido_signal 포함)
{:opentelemetry, "~> 1.5"},     # ⚠️ 1.7까지 나와 있음
```

### 5.2 v2 수정판 (실제 hex.pm 최신)

```elixir
# 시그마팀 v2 리모델링 의존성 (2026-04-17 hex.pm 기준)
{:jido,         "~> 2.2"},        # 2.2.0 (2026-03-29)
{:jido_action,  "~> 2.2"},        # 2.2.1
{:jido_signal,  "~> 2.1"},        # 2.1.1 (CloudEvents 포함)
{:jido_ai,      "~> 2.1"},        # 2.1.0 (2026-03-14)
{:req_llm,      "~> 1.9"},        # 1.9.0 (downloads 89,895 — 가장 인기)
{:postgrex,     "~> 0.20"},       # 1.0.0-rc.1 있으나 0.20 stable 사용
{:opentelemetry, "~> 1.7"},       # 1.7.0

# ❌ 제거 (jido_signal이 CloudEvents v1.0 envelope 이미 포함)
# {:cloudevents, "~> 0.6"},

# 선택적 — Zoi 스키마 (jido_action이 이미 의존하지만 명시)
# {:zoi, "~> 1.0"},
```

### 5.3 Igniter 설치 권장 경로

```bash
# 수동 deps.get 대신 Jido 공식 Igniter 사용 권장
mix igniter.install jido
mix igniter.install jido_ai
```

Igniter는:
- deps 자동 추가
- `MyApp.Jido` instance module 자동 생성
- `config/config.exs` 설정 자동 추가
- supervision tree에 자동 등록

단, 기존 Team Jay Elixir 프로젝트 구조와 충돌 가능하므로 **수동 추가 권장** (Phase 0 코덱스 프롬프트 §1 그대로).

---

## 6. Phase 0 코덱스 프롬프트 수정사항

`docs/codex/CODEX_SIGMA_REMODEL_PHASE_0.md` (199줄, 31차 작성)에 반영할 3가지 변경:

### 6.1 §1 의존성 버전 업데이트

**변경 전**:
```elixir
{:jido, "~> 2.0"},
{:jido_action, "~> 1.0"},
{:jido_signal, "~> 1.0"},
{:jido_ai, "~> 1.0"},
{:req_llm, "~> 1.0"},
{:postgrex, "~> 0.20"},
{:cloudevents, "~> 0.6"},
{:opentelemetry, "~> 1.5"},
```

**변경 후**:
```elixir
{:jido,         "~> 2.2"},
{:jido_action,  "~> 2.2"},
{:jido_signal,  "~> 2.1"},
{:jido_ai,      "~> 2.1"},
{:req_llm,      "~> 1.9"},
{:postgrex,     "~> 0.20"},
{:opentelemetry, "~> 1.7"},
# cloudevents 제거됨
```

### 6.2 §2 Skeleton 모듈 Zoi 스키마 + Jido.AI.Agent 매크로 반영

원본 skeleton이 `use Jido.Agent` + NimbleOptions로 썼다면, 실제는 **`use Jido.AI.Agent` + Zoi**. Skeleton 예시 추가:

```elixir
# bots/sigma/elixir/lib/sigma/v2/commander.ex
defmodule Sigma.V2.Commander do
  use Jido.AI.Agent,
    name: "sigma_commander",
    model: :smart,
    tools: [],  # Phase 1에서 채움
    system_prompt: "..."

  # TODO Phase 1: implement formation decision logic
end

# bots/sigma/elixir/lib/sigma/v2/skill/data_quality_guard.ex
defmodule Sigma.V2.Skill.DataQualityGuard do
  use Jido.Action,
    name: "data_quality_guard",
    description: "TODO",
    schema: Zoi.object(%{})  # TODO Phase 1: full schema

  @impl Jido.Action
  def run(params, _context) do
    # TODO Phase 1: port from bots/sigma/legacy-skills/data-quality-guard.ts
    {:ok, %{passed: false, quality_score: 0}}
  end
end
```

### 6.3 §3 agentskills.io 포맷 skill 마크다운 추가

**새 작업 추가** (Phase 0 확장):

```
bots/sigma/skills/                              (신규 디렉토리)
├ data-quality-guard.md        — agentskills.io 포맷 skill 문서
├ causal-check.md
├ experiment-design.md
├ feature-planner.md
└ observability-planner.md
```

각 .md는:
- YAML frontmatter (name/description/version/tools/model)
- When to Use / Process / Returns 섹션
- Phase 0에서는 **껍데기만 작성** (기존 TS 로직 주석 인용)

이로써 **Claude Code가 이 skills을 자동 로드** → 메티/마스터가 대화 중 직접 활용 가능.

### 6.4 Exit Criteria 추가

```
[ ] bots/sigma/skills/ 디렉토리 + 5개 .md 파일 (agentskills.io 포맷)
[ ] 각 .md 파일 `.claude/skills/` 또는 agentskills 규약 경로에 심볼릭 링크 (선택)
```

---

## 7. 추가 기각 + 승격

### 7.1 🆙 v2 추가 승격 (5건)

| 아이디어 | 원천 | 시그마 적용 |
|----------|------|-------------|
| Zoi 스키마 | Jido 2.2 README | Action 스키마 정의 (NimbleOptions 교체) |
| `Jido.AI.Agent` 매크로 | jido_ai README | Commander + Pod 정의 |
| `req_llm` Anthropic 통합 | hex.pm | Claude Sonnet/Haiku 호출 표준화 |
| `agentskills.io` 포맷 skill 마크다운 | agentskills README | Layer 2 신설, Claude Code 자동 로드 |
| `github.com/anthropics/skills` 예제 참조 | agentskills README | skill 작성 템플릿 |

### 7.2 ❌ v2 추가 기각 (2건)

| 아이디어 | 기각 사유 |
|----------|-----------|
| `cloudevents` 별도 패키지 | jido_signal 2.1이 이미 CloudEvents v1.0 envelope 포함. 중복 제거 |
| `postgrex 1.0.0-rc.1` | Release Candidate. Stable `~> 0.20` 유지. Phase 5 이후 1.0 stable 확정 시 업그레이드 |

### 7.3 📋 v2 신규 보류 (2건)

| 아이디어 | 보류 사유 | 재검토 시점 |
|----------|-----------|-------------|
| `mix igniter.install jido` 자동화 | 기존 프로젝트 구조와 충돌 가능 | Phase 1 초반 실증 후 |
| `agentskills.io` SDK reference 사용 | 현재는 spec + Anthropic Claude Code만 활용. SDK는 JS/Python | Phase 5 MCP 안정화 후 |

---

## 📌 종합 결론

v1 보강이 "방향성 검증"이었다면, v2 보강은 **실전 착수 직전 정밀화**. 가장 큰 수확은:

1. **Jido 의존성 모두 2.x 계열 최신 확정** — 설계 버전 맞춤
2. **Zoi 스키마 + Jido.AI.Agent 매크로** — Skeleton 코드 그대로 쓰지 말고 v2 패턴으로
3. **agentskills.io = Anthropic 공식** — Layer 2 신설, Claude Code 즉시 호환
4. **cloudevents 패키지 제거** — jido_signal에 포함됨

**Phase 0 코덱스 프롬프트 `docs/codex/CODEX_SIGMA_REMODEL_PHASE_0.md`는 3곳 수정 필요** (§6.1~6.4).

---

**작성**: 메티 (Metis, claude.ai) / 2026-04-17 32차 세션
**검토 요청**: 마스터 (제이)
**상위 문서**:
- `docs/SIGMA_REMODELING_PLAN_2026-04-17.md`
- `docs/SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md` (v1)
**다음 단계**: 마스터 승인 후 `CODEX_SIGMA_REMODEL_PHASE_0.md` v2 반영 → Phase 0 착수

