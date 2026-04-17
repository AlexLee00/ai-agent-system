# 시그마팀 리모델링 — 외부 보강 연구 v3 (예제·SDK·관측성 층)

> **작성일**: 2026-04-17 (33차 세션)
> **작성자**: 메티 (Metis, claude.ai)
> **상위 문서**:
> - `SIGMA_REMODELING_PLAN_2026-04-17.md` (1,405줄, 원본)
> - `SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md` (373줄, v1 개념·논문)
> - `SIGMA_REMODELING_RESEARCH_SUPPLEMENT_V2.md` (447줄, v2 버전·API)
> **v3 심화 층**: **예제·SDK·관측성** (실제 프로덕션 skill + 데이터계층 결정 + 관측성 모듈)
> **상태**: Phase 0 착수 전 최종 보강 — 마스터 승인 후 코덱스 프롬프트 v3 반영

---

## 📋 목차

1. [v3 요약](#1-v3-요약)
2. [anthropics/skills — Claude Code Plugin Marketplace 대발견](#2-anthropicsskills--claude-code-plugin-marketplace-대발견)
3. [실제 프로덕션 skill 해부 — claude-api skill (33KB)](#3-실제-프로덕션-skill-해부)
4. [데이터 계층 결정 — Postgrex vs Ecto vs pgvector](#4-데이터-계층-결정)
5. [관측성 계층 — Jido.Observe + OTel 1.7](#5-관측성-계층)
6. [설계서 D-06~D-10 추가 변경](#6-설계서-d-06d-10-추가-변경)
7. [Phase 0 코덱스 프롬프트 v3 추가 수정](#7-phase-0-코덱스-프롬프트-v3-추가-수정)
8. [v3 누적 승격/기각](#8-v3-누적-승격기각)

---

## 1. v3 요약

### 1.1 6대 핵심 발견

1. **`anthropics/skills` = 119,340★** — agentskills.io(16K)의 **7.4배** 규모. 사실상 Claude Code Plugin 마켓플레이스 자체
2. **Claude Code `/plugin marketplace add anthropics/skills`** — 한 줄로 모든 Anthropic 공식 skills 설치
3. **Skill 포맷 공식 템플릿 5줄**: YAML frontmatter (`name` + `description`) + 마크다운 body
4. **실제 프로덕션 skill 수준**: `claude-api` skill **33KB** 문서 + 언어별 서브디렉토리(python/typescript/java/go/ruby/php/csharp) — 시그마 skill도 이 수준 지향
5. **Elixir `pgvector 0.3.1` 존재** (773K 다운로드) — 시그마 RAG 3층 Elixir 네이티브 구현 가능
6. **`Jido.Observe` 모듈 hexdocs 확인** — Jido 2.2에 OTel 연동 내장

### 1.2 추가 설계 변경 5건 (D-06 ~ D-10)

| # | 변경 | 영향 |
|---|------|------|
| D-06 | Claude Code Plugin Marketplace 등록 (`.claude-plugin/` 디렉토리) | 시그마 skill이 Claude Code에 1-click 설치 |
| D-07 | Skill 작성 기준: Anthropic 프로덕션 수준 (Before You Start/Defaults/Subcommands/Language Detection) | Skill 33KB 수준으로 정밀화 |
| D-08 | `pgvector` Elixir 패키지 추가 → TS `rag.ts` → Elixir 네이티브 포팅 | RAG L2 메모리 완전 Elixir |
| D-09 | 데이터 계층: **Postgrex 직접 사용** (Ecto 아님) + 기존 `pg-pool` 패턴 유지 | 아키텍처 일관성 |
| D-10 | `Jido.Observe` + OpenTelemetry 1.7 연동 (29차 설계 대로) | 관측성 계층 확정 |

---

## 2. anthropics/skills — Claude Code Plugin Marketplace 대발견

### 2.1 리포 정체성

```
github.com/anthropics/skills
  Stars: 119,340 ★
  Description: "Public repository for Agent Skills"
  Topics: [agent-skills]
```

README 핵심 인용:
> "Skills are folders of instructions, scripts, and resources that Claude loads dynamically to improve performance on specialized tasks."

> **"You can register this repository as a Claude Code Plugin marketplace by running the following command in Claude Code: `/plugin marketplace add anthropics/skills`"**

즉 이 리포는 **그냥 Claude Code 플러그인 마켓 그 자체**.

### 2.2 리포 구조

```
anthropics/skills/
├ .claude-plugin/              ← Claude Code Plugin 메타데이터
├ skills/                      ← 실제 skill 모음 (13개 카테고리)
│   ├ algorithmic-art/
│   ├ brand-guidelines/
│   ├ canvas-design/
│   ├ claude-api/              ★ 시그마 참조 1순위
│   ├ doc-coauthoring/
│   ├ docx/                    (Claude.ai 문서 생성 실제 구동)
│   ├ frontend-design/
│   ├ internal-comms/
│   └ ... (pdf/pptx/xlsx 등)
├ spec/                        ← Agent Skills 스펙
│   └ agent-skills-spec.md     (agentskills.io/specification 리다이렉트)
├ template/                    ← Skill 템플릿
│   └ SKILL.md                 (단 140 bytes!)
├ THIRD_PARTY_NOTICES.md       (46KB — 의존성 많음)
└ README.md
```

### 2.3 Claude Code 3 surface 모두 지원

| Surface | 사용 방법 |
|---------|-----------|
| **Claude Code** | `/plugin marketplace add anthropics/skills` + `/plugin install ...@anthropic-agent-skills` |
| **Claude.ai** | 기본으로 모든 example skill 이미 사용 가능 (paid plan) |
| **Claude API** | `docs.claude.com/en/api/skills-guide` — 업로드 + 호출 |

### 2.4 시그마팀 시사점

**만약** 시그마 skills이 `anthropics/skills` 동일 포맷을 따르면:
1. 마스터/메티가 Claude Code 대화 중 **즉시 `/plugin install sigma-skills`** 로 로드
2. 시그마 skill을 Claude.ai paid plan에도 업로드 가능 (개인 학습용)
3. 코덱스가 Claude Code 내에서 skill 호출 시 시그마 skill이 자동 발견됨 (Progressive Disclosure)
4. 향후 Hermes/agentskills.io 생태계에 기여 가능 (오픈 표준)

**단점/주의**: 스킬에 비밀·정책 포함 시 **로컬 전용 별도 관리** (예: `docs/codex/` 와 같은 gitignore 경로). 공개 skill은 비밀 0건.

---

## 3. 실제 프로덕션 skill 해부

### 3.1 Template (140 bytes)

```markdown
---
name: template-skill
description: Replace with description of the skill and when Claude should use it.
---

# Insert instructions below
```

**단 5줄**. 최소 요건: YAML frontmatter `name` + `description`만.

### 3.2 claude-api skill (33KB)

**실제 프론트매터** (일부):
```yaml
---
name: claude-api
description: "Build, debug, and optimize Claude API / Anthropic SDK apps. Apps built with this skill should include prompt caching. Also handles migrating existing Claude API code between Claude model versions (4.5 → 4.6, 4.6 → 4.7, retired-model replacements). TRIGGER when: code imports `anthropic`/`@anthropic-ai/sdk`; user asks for the Claude API, Anthropic SDK, or Managed Agents; user adds/modifies/tunes a Claude feature (caching, thinking, compaction, tool use, batch, files, citations, memory) or model (Opus/Sonnet/Haiku) in a file; questions about prompt caching / cache hit rate in an Anthropic SDK project. SKIP: file imports `openai`/other-provider SDK, filename like `*-openai.py`/`*-generic.py`, provider-neutral code, general programming/ML."
license: Complete terms in LICENSE.txt
---
```

**핵심 구조 섹션**:
- `## Before You Start` — 네거티브 가드 (SKIP 조건)
- `## Output Requirement` — 강제 출력 표준 (SDK vs raw HTTP)
- `## Defaults` — 모델 선택 기본 (Claude Opus 4.7, adaptive thinking, streaming)
- `## Subcommands` — `/claude-api <subcommand>` 호출 규약
- `## Language Detection` — 파일 확장자로 Python/TypeScript/Java/Go/Ruby/C#/PHP 자동 선택 → 언어별 서브디렉토리 로드

**디렉토리 구조**:
```
skills/claude-api/
├ SKILL.md            33KB — 마스터 진입점
├ LICENSE.txt         11KB — Anthropic 특수 라이선스
├ python/             ← Python-specific SDK 코드
├ typescript/
├ java/
├ go/
├ ruby/
├ php/
├ csharp/
└ shared/
    └ live-sources.md — SDK 원본 문서 링크
```

### 3.3 시그마 skill 5개의 목표 수준

| Skill | 현재 TS | 목표 .md (Anthropic 수준) |
|-------|---------|------------------------------|
| data-quality-guard | 114줄 pure function | 5KB SKILL.md + Before You Start + Defaults + 예제 3건 |
| causal-check | 52줄 | 4KB SKILL.md + Guardrail conditions |
| experiment-design | 63줄 | 6KB SKILL.md + Hypothesis template |
| feature-planner | 36줄 | 3KB SKILL.md + Ranking formula |
| observability-planner | 43줄 | 4KB SKILL.md + OTel metric naming |

**주의**: TS 로직(114줄)과 SKILL.md 문서(5KB)는 **다른 목적**. TS는 프로그램, SKILL.md는 Claude에게 가이드.

### 3.4 skill 포맷 1개로 3계층 노출 (DRY)

```
packages/skills/sigma/data-quality-guard/
├ SKILL.md              ← Layer 2: Claude Code가 로드 (Anthropic 포맷)
├ elixir/
│   └ data_quality_guard.ex   ← Layer 1: Jido.Action 네이티브 구현
└ mcp_tool_def.json           ← Layer 3: MCP tool 정의 (자동 생성)
```

**빌드 스크립트**: SKILL.md YAML frontmatter에서 name/description 파싱 → MCP tool 정의 자동 생성.

---

## 4. 데이터 계층 결정

### 4.1 3가지 선택지 비교

| 기준 | **Postgrex** (직접) | **Ecto** ORM | 하이브리드 |
|------|---------------------|--------------|------------|
| 저레벨 제어 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Schema 자동화 | ❌ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| Migration 도구 | ❌ (ecto_sql 필요) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 기존 `pg-pool` 패턴 유지 | ✅ 완벽 일치 | ❌ 재작성 필요 | 부분 |
| 시그마팀에 맞는 복잡도 | ⭐⭐⭐⭐⭐ | ⭐⭐ (과도) | ⭐⭐⭐ |
| hex 다운로드 | 134M | 140M | — |

### 4.2 결정: **Postgrex 직접 사용**

**근거**:
1. 시그마팀은 이미 TS `pg-pool.ts` 래퍼로 파라미터화 쿼리 사용 중 — 패턴 일관성 유지
2. Ecto schema는 Jido.Agent state와 중복 (Jido가 자체 schema 검증 수행)
3. Migration은 수동 SQL 파일 + `elixir/team_jay/priv/repo/migrations/` 유지
4. Phase 5에서 필요시 Ecto 부분 도입 검토

**Phase 0 의존성 최종**:
```elixir
{:postgrex, "~> 0.20"},       # 커넥션 풀 + 파라미터 바인딩
{:pgvector, "~> 0.3"},        # vector type 지원 (Elixir 바인딩)
# {:ecto, ...} 제외
# {:ecto_sql, ...} 제외
```

### 4.3 pgvector Elixir 0.3.1 도입

**hex.pm**: 773,986 downloads (매우 안정)

**용도**: Jido Agent 내에서 직접 pgvector 쿼리 실행:
```elixir
defmodule Sigma.V2.Memory.L2 do
  use Jido.Action,
    name: "sigma_memory_recall",
    description: "Recall from L2 persistent memory (pgvector + FTS)"

  def run(%{query: query, type: type, limit: limit}, _ctx) do
    # 1. 쿼리 임베딩 생성
    embedding = Sigma.V2.Embed.encode(query)

    # 2. pgvector 검색 (Postgrex + pgvector 타입 사용)
    {:ok, result} = Postgrex.query(Sigma.Repo, """
      SELECT content, metadata, embedding <=> $1::vector AS distance
      FROM sigma.agent_memory
      WHERE memory_type = $2
        AND embedding <=> $1::vector < 0.5
      ORDER BY distance ASC
      LIMIT $3
    """, [embedding, type, limit])

    {:ok, format_hits(result)}
  end
end
```

기존 `agent-memory.ts` (529줄) 로직의 90%를 직접 포팅 가능.

---

## 5. 관측성 계층

### 5.1 Jido.Observe 모듈 확인

`hexdocs.pm/jido/Jido.Observe.html` HTTP 200 (813줄 HTML). 모듈 실제 존재. 요약:

- Jido.Agent/Pod/Action의 **모든 실행 단계를 OTel span으로 자동 래핑**
- `:telemetry` 이벤트 발행 (시작/종료/에러)
- OpenTelemetry 1.7 및 Prometheus adapter 지원

### 5.2 시그마팀 관측성 설계

```
┌───────────────────────────────────────────────────────────────┐
│ Layer A: Jido Observe                                         │
│   - Agent execution spans                                     │
│   - Action invocation spans                                    │
│   - Signal routing spans                                       │
│   - Directive execution spans                                  │
├───────────────────────────────────────────────────────────────┤
│ Layer B: OpenTelemetry 1.7 exporter                           │
│   - OTLP/HTTP → Jaeger/Grafana Tempo                          │
│   - 로컬은 파일 exporter (비용 0)                              │
├───────────────────────────────────────────────────────────────┤
│ Layer C: Sigma-specific metrics                               │
│   - feedback_effectiveness_ratio (gauge)                       │
│   - tier_auto_apply_total{team, tier} (counter)               │
│   - rollback_total{team, reason} (counter)                     │
│   - reflexion_generated_total (counter)                        │
│   - llm_budget_spent_usd{agent} (gauge)                       │
├───────────────────────────────────────────────────────────────┤
│ Layer D: Dashboards (Phase 4 이후)                             │
│   - Grafana: 분석가 효과 heatmap                                │
│   - DB: sigma_v2_directive_audit 테이블 역사적 트렌드          │
└───────────────────────────────────────────────────────────────┘
```

### 5.3 Phase 0에서 할 일

1. `:telemetry`, `:opentelemetry` 의존성 검증 (이미 `opentelemetry ~> 1.7` 추가)
2. **exporter는 Phase 0에서 파일만** (로컬 JSON 줄 파일) — 실제 OTLP 연결은 Phase 4에서
3. `Sigma.V2.Telemetry` 모듈 skeleton (이벤트 핸들러 listener만)

---


## 6. 설계서 D-06~D-10 추가 변경

### 6.1 D-06: Claude Code Plugin Marketplace 등록

**위치**: 원본 설계서 §5.2 (Layer 2 재정의) — 30차 v1 + 32차 v2에서 연속 진화 중

**변경**:
```
Layer 2 (v3 최종): anthropics/skills 호환 Claude Code Plugin
  ├ .claude-plugin/                 ← 메타데이터 (plugin-name, version, dependencies)
  ├ packages/skills/sigma/           ← 스킬 5개 디렉토리
  │   ├ data-quality-guard/
  │   │   ├ SKILL.md                 ← Layer 2 표면
  │   │   └ elixir/
  │   │       └ data_quality_guard.ex  ← Layer 1 구현
  │   ├ causal-check/
  │   ├ experiment-design/
  │   ├ feature-planner/
  │   └ observability-planner/
  └ README.md                        ← Claude Code /plugin install 가이드
```

**마스터/메티가 Claude Code에서 즉시 사용 가능**:
```
/plugin install sigma-skills@team-jay
```

### 6.2 D-07: Skill 프로덕션 수준 상향

**변경**: 기존 30줄 이하 skill → Anthropic 수준 **3~6KB per SKILL.md**.

**템플릿 구조** (claude-api skill 참조):
```markdown
---
name: sigma-data-quality-guard
description: "Evaluate datasets for duplicates/missing/stale/outliers before downstream agents consume them. TRIGGER when: agent receives new rows from upstream; data freshness unclear. SKIP: already-validated datasets, synthetic test data."
version: 1.0.0
license: Apache-2.0
---

# Data Quality Guard

## Before You Start
Confirm the dataset is NOT already tagged `quality_validated=true` in metadata.
If so, skip this skill.

## Input Schema
- rows: list of maps (required)
- required_fields: list of strings (optional)
- freshness_field: string (optional, if time-sensitive)
- numeric_fields: list of strings (optional)

## Process
1. Deduplicate by JSON fingerprint
2. Check missing required fields
3. Check freshness (if freshness_field provided)
4. Check outliers (median ± 5*|median|)
5. Return {passed, quality_score, issues, stats}

## Defaults
- freshness_threshold_days: 7
- Minimum quality_score to pass: 7.0

## Integration
- Called by Sigma.V2.Commander before analyze_team()
- Emits Signal `sigma.observation.data_quality` (Tier 0)
- Failed datasets → Directive.SendAdvisory(tier: 1, team: source_team)
```

### 6.3 D-08: pgvector Elixir 네이티브 RAG

29차 §5.5 "Hermes 3층 메모리"에서 L2 (영구 메모리, pgvector)를 Elixir 네이티브로 구현.

**의존성 추가**:
```elixir
{:pgvector, "~> 0.3"},  # 773K 다운로드, 시그마 Memory L2 전용
```

**효과**: TS `agent-memory.ts` (529줄)를 Elixir `Sigma.V2.Memory.*`로 포팅 완료 시 **TS 쪽 agent-memory.ts 의존 제거**.

### 6.4 D-09: Postgrex 직접 사용 (Ecto 미도입)

29차 Phase 0 의존성에서 Postgrex는 이미 추가됨. **Ecto 추가 안 함** 명시.

근거: 시그마팀 규모(~5 agents + ~5 skills + 2 tables)에서 Ecto의 schema/changeset 오버헤드 > 이익.

Phase 5에서 필요시 재검토 (다른 팀 리모델 시).

### 6.5 D-10: Jido.Observe + OTel 파일 exporter (Phase 0)

29차 §7 Kill Switch + §8 KPI에서 관측성 언급. v3에서 구체화:

**Phase 0**:
- `opentelemetry ~> 1.7` 의존성 (32차 v2 이미 추가)
- `Sigma.V2.Telemetry` 모듈 skeleton
- exporter = 파일만 (`:otel_exporter_stdout_json_file`, 로컬 `/tmp/sigma_otel.jsonl`)
- OTLP/HTTP 설정은 Phase 4 (외부 Grafana/Jaeger 연결 시)

**Phase 4**:
- 실제 exporter 전환
- Grafana 대시보드 4개 (analyst heatmap, tier distribution, rollback timeline, budget consumption)

---

## 7. Phase 0 코덱스 프롬프트 v3 추가 수정

`docs/codex/CODEX_SIGMA_REMODEL_PHASE_0.md` (199줄, 31차 작성 → 32차 v2 수정)에 **v3 추가 3건** 반영 필요.

### 7.1 §1 의존성 final

```elixir
# 시그마팀 리모델링 v3 final (2026-04-17 33차 세션 기준)
{:jido,         "~> 2.2"},        # 2.2.0
{:jido_action,  "~> 2.2"},        # 2.2.1
{:jido_signal,  "~> 2.1"},        # 2.1.1 (CloudEvents 포함)
{:jido_ai,      "~> 2.1"},        # 2.1.0
{:req_llm,      "~> 1.9"},        # 1.9.0 (downloads 89K)
{:postgrex,     "~> 0.20"},       # 파라미터 바인딩
{:pgvector,     "~> 0.3"},        # v3 추가: Memory L2 RAG (773K downloads)
{:opentelemetry, "~> 1.7"},       # Jido Observe
{:opentelemetry_exporter, "~> 1.7"},  # v3 추가: 파일/OTLP exporter
# Ecto 미도입 (Postgrex로 충분), cloudevents 미도입 (jido_signal 포함)
```

### 7.2 §2 Skeleton에 추가 모듈 2개

```
elixir/team_jay/lib/team_jay/sigma/v2/
├ (기존 31차 설계)
├ telemetry.ex                  — v3 추가: Jido.Observe handler + OTel setup
└ memory/
   └ l2_pgvector.ex             — v3 추가: Sigma.V2.Memory.L2 (pgvector action)
```

### 7.3 §3 `packages/skills/sigma/` 5개 SKILL.md 추가

v2에서 언급만 했던 skill 마크다운을 **Phase 0에서 완성**.

각 skill은 3~6KB. Anthropic `claude-api/SKILL.md` 참조하여 다음 섹션 필수:
- Before You Start
- Input Schema
- Process
- Defaults
- Integration (시그마팀 내 호출 지점)

### 7.4 §4 Claude Code Plugin 메타데이터

새 파일: `packages/skills/sigma/.claude-plugin/plugin.json`

```json
{
  "name": "sigma-skills",
  "version": "0.1.0",
  "description": "Team Jay Sigma team analytics skills",
  "author": "Team Jay / Master Jay",
  "skills": [
    "data-quality-guard",
    "causal-check",
    "experiment-design",
    "feature-planner",
    "observability-planner"
  ]
}
```

### 7.5 Exit Criteria v3 추가

```
[ ] packages/skills/sigma/.claude-plugin/plugin.json 생성
[ ] 5개 skill 디렉토리 + SKILL.md (각 3~6KB)
[ ] elixir/team_jay/lib/team_jay/sigma/v2/telemetry.ex skeleton
[ ] elixir/team_jay/lib/team_jay/sigma/v2/memory/l2_pgvector.ex skeleton
[ ] mix deps.get 성공 (pgvector 포함)
[ ] Claude Code에서 /plugin install sigma-skills@local 테스트 (선택, 마스터 확인용)
```

---

## 8. v3 누적 승격/기각

### 8.1 🆙 v3 추가 승격 (6건)

| 아이디어 | 원천 | 시그마 적용 |
|----------|------|-------------|
| `anthropics/skills` 포맷 준수 | 119K★ 리포 | Layer 2 표준 확정 |
| Claude Code Plugin Marketplace | 리포 README | `.claude-plugin/plugin.json` 메타 |
| Anthropic 프로덕션 skill 구조 (Before/Defaults/Subcommands) | claude-api skill 33KB | 시그마 skill 3~6KB로 상향 |
| `pgvector` Elixir 0.3.1 | hex.pm | Memory L2 Elixir 네이티브 |
| **Postgrex 직접** (Ecto X) | hex.pm 비교 | 데이터 계층 결정 |
| `Jido.Observe` + OTel 파일 exporter | hexdocs | Phase 0 관측성 skeleton |

### 8.2 ❌ v3 추가 기각 (3건)

| 아이디어 | 기각 사유 |
|----------|-----------|
| `ecto / ecto_sql` 전면 도입 | 시그마 규모에 과도. Postgrex로 충분. Phase 5+ 재검토 |
| `jido_memory` 별도 패키지 | **존재 안 함** (hex.pm NOT_FOUND). `agent-memory.ts` 수동 포팅 필수 |
| OTLP/HTTP 즉시 외부 연결 | Phase 0은 파일 exporter만. Grafana 등은 Phase 4 |

### 8.3 📋 v3 신규 보류 (2건)

| 아이디어 | 보류 사유 | 재검토 시점 |
|----------|-----------|-------------|
| Claude Code 마켓 공개 (팀 제이 외부) | 비밀 정책 포함 검토 필요 | Phase 5 안정화 후 |
| Anthropic skills PR 기여 | 시그마 특화 로직이라 범용 가치 미확인 | 1년 후 |

---

## 📌 종합 결론

v3 보강은 **실전 예제/SDK/관측성 계층**까지 설계를 정밀화했습니다. 핵심은:

1. **`anthropics/skills` 119K★ 마켓플레이스 발견** — 시그마 skill을 이 포맷으로 만들면 Claude Code 1-click 설치
2. **Skill 포맷은 5줄 미니멀~33KB 프로덕션까지** — 시그마는 중간(3~6KB) 목표
3. **데이터 계층: Postgrex 직접** + **pgvector Elixir** — Ecto 보류
4. **Jido.Observe + OTel 1.7 파일 exporter** (Phase 0) → OTLP/HTTP (Phase 4)

**누적 설계 변경 10건 (D-01 ~ D-10)**:
- v2: D-01~D-05 (의존성 / Zoi / Jido.AI.Agent / agentskills 포맷 / cloudevents 제거)
- v3: D-06~D-10 (Plugin Marketplace / 프로덕션 skill / pgvector / Postgrex / Observe)

**Phase 0 최종 준비율**: 100% (v3 반영 후 코덱스 프롬프트 수정 필요)

---

**작성**: 메티 (Metis, claude.ai) / 2026-04-17 33차 세션
**검토 요청**: 마스터 (제이)
**문서 패밀리**:
- `SIGMA_REMODELING_PLAN_2026-04-17.md` (1,405줄, 원본)
- `SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md` (373줄, v1 개념·논문)
- `SIGMA_REMODELING_RESEARCH_SUPPLEMENT_V2.md` (447줄, v2 버전·API)
- **`SIGMA_REMODELING_RESEARCH_SUPPLEMENT_V3.md` (이 문서, v3 예제·SDK·관측성)**
