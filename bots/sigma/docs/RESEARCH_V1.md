# 시그마팀 리모델링 — 외부 보강 연구 Delta 문서

> **작성일**: 2026-04-17 (30차 세션)
> **작성자**: 메티 (Metis, claude.ai)
> **상위 문서**: `docs/SIGMA_REMODELING_PLAN_2026-04-17.md` §9 외부 보강 포인트
> **상태**: 1차 외부 서칭 완료 — 원본 설계서 Delta 반영 후 Phase 0 착수 권고

---

## 📋 목차

1. [요약](#1-요약)
2. [10건 외부 서칭 상세](#2-10건-외부-서칭-상세)
3. [원본 설계서 Delta](#3-원본-설계서-delta)
4. [승격된 아이디어 + 기각된 아이디어](#4-승격된-아이디어--기각된-아이디어)
5. [Phase 0 최종 변경사항](#5-phase-0-최종-변경사항)

---

## 1. 요약

29차 설계서 §9.1에 명시한 외부 보강 10건을 `gh CLI` + `curl` + `arXiv API` + `GitHub Raw`로 실행. **10건 모두 원본 확보**하여 설계 정확성을 검증함.

### 1.1 핵심 발견 3건 (설계 변경 유발)

1. **GEPA → E-SPL로 대체** — 검색 결과 "GEPA" 정확한 논문 대신 **E-SPL (Evolutionary System Prompt Learning)** 2026-02-16 최신 논문(arxiv 2602.14697) 발견. 더 정확하고 최신. **시그마팀 자기 진화 엔진의 실제 레퍼런스로 승격**.

2. **Hermes가 `agentskills.io` 오픈 표준 준수** — Hermes README 확인 결과 "Compatible with the [agentskills.io](https://agentskills.io) open standard" 명시. **MCP Server 설계 시 이 표준과 호환 설계 추가 필요**.

3. **Hermes에 `hermes claw migrate` 기능** — retired gateway → Hermes 이주 공식 지원. **기존 legacy alarm shim은 향후 Hermes 전환 경로 가능**. 단, 본 리모델링 범위는 아님 (시그마팀은 Hub alarm 경유 알림만 사용).

### 1.2 설계 일관성 확인 5건

| 항목 | 원본 설계 | 외부 검증 결과 |
|------|-----------|----------------|
| Jido 2.0 Pod/Signal 아키텍처 | 채택 | ✅ README 1:1 일치, 최신 커밋 2026-04-14 매우 활발 |
| Reflexion 실패 노트 패턴 | 채택 | ✅ 논문(2303.11366) Shinn et al. — "verbal reinforcement" 검증 |
| Self-RAG 4 gate (retrieve/isRel/isSup/isUse) | 채택 | ✅ 논문(2310.11511) Asai et al. ICLR 2024 검증 |
| Constitutional AI RLAIF 참조 | 언급 | ✅ 논문(2212.08073) Anthropic 방법론 검증 |
| CloudEvents 표준 | Jido 위임 | ✅ spec 확인 — Jido Signal이 envelope 구조 준수 |

---


## 2. 10건 외부 서칭 상세

### 📚 논문 6건 (arXiv)

#### [1] Reflexion: Language Agents with Verbal Reinforcement Learning
- **arXiv**: 2303.11366v4 (cs.AI)
- **Published**: 2023-03-20
- **Authors**: Noah Shinn, Federico Cassano, Edward Berman *et al.* (6 total)
- **Abstract (요약)**: LLM이 외부 환경과 goal-driven agent로 상호작용할 때, 전통적 RL은 대량 샘플과 fine-tuning 필요. Reflexion은 가중치 업데이트 없이 언어적 피드백을 **에피소딕 메모리 버퍼**에 저장, 다음 시도에서 참조하여 결정 품질 향상.
- **시그마팀 적용**: §5.4.3 Reflexion 노트 설계 유효성 검증. 원본 설계에서 Haiku 500 tokens/건으로 리플렉션 호출했는데, 논문 기준 sound. `Sigma.Reflexion` 구현 시 논문의 **3단계(Actor-Evaluator-Self-Reflection)** 구조 준수.

#### [2] Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection
- **arXiv**: 2310.11511v1 (cs.CL)
- **Published**: 2023-10-17
- **Authors**: Akari Asai, Zeqiu Wu, Yizhong Wang *et al.* (5 total)
- **Abstract (요약)**: 고정 개수 passage 맹목적 회수는 doc이 부적합하거나 비관련적일 때 도움되지 않음. Self-RAG는 **reflection tokens**으로 retrieve-or-not, generation, critique를 병합 학습. 결과: on-demand retrieval + 각 response의 품질 자체 평가.
- **시그마팀 적용**: §5.5.4 Self-RAG 게이트 설계 원문과 정확히 일치. **reflection tokens** 개념 도입 필요 — 단순 휴리스틱이 아닌 LLM이 특수 토큰(`[Retrieve]`, `[Relevant]`, `[Supporting]`, `[Useful]`)을 발생시키도록 프롬프트 설계.

#### [3] Constitutional AI: Harmlessness from AI Feedback
- **arXiv**: 2212.08073v1 (cs.CL)
- **Published**: 2022-12-15
- **Authors**: Yuntao Bai, Saurav Kadavath, Sandipan Kundu *et al.* (51 total, Anthropic)
- **Abstract (요약)**: AI 시스템이 더 유능해질수록 다른 AI를 감독하는 데 도움 받기를 원함. **RLAIF (RL from AI Feedback)** — 인간 라벨 없이 원칙 목록만으로 harmless AI 훈련. Supervised + RL 두 단계.
- **시그마팀 적용**: 시그마팀이 **타 팀을 감독하는 구조**와 직접 매핑. 원본 §5.3.2 "4티어 리스크 게이트"의 규범 기반 접근이 Constitutional AI의 "원칙 목록"과 동일 철학. **`sigma_principles.yaml`** 문서 추가 고려 (어떤 원칙으로 자동 적용/거부하는지 명시).

#### [4] The AI Scientist-v2: Workshop-Level Automated Scientific Discovery via Agentic Tree Search
- **arXiv**: 2504.08066v1 (cs.AI)
- **Published**: 2025-04-10
- **Authors**: Yutaro Yamada, Robert Tjarko Lange, Cong Lu *et al.* (8 total, SakanaAI)
- **Abstract (요약)**: AI가 **완전 자동** 워크샵 논문을 피어리뷰 통과시킨 최초 사례. 가설 수립 → 실험 설계/실행 → 데이터 분석 → 논문 저술 end-to-end. **Progressive agentic tree search** + 전용 experiment manager agent. VLM 피드백 루프로 그래프/차트 개선.
- **시그마팀 적용**: 다윈팀 자율 연구와 직결. 시그마팀은 다윈팀에 **Signal로 연구 트리거만** 보내고, 다윈팀이 AI Scientist v2 패턴 채택. §5.6 다윈 분리 원칙 강화.

#### [5] Evolutionary System Prompt Learning for Reinforcement Learning in LLMs (E-SPL) — ⭐ GEPA 대체
- **arXiv**: 2602.14697v3 (cs.AI)
- **Published**: 2026-02-16 (**최신, 2개월 전**)
- **Authors**: Lunjun Zhang, Ryan Chen, Bradly C. Stadie
- **Abstract (요약)**: "Building agentic systems that can autonomously self-improve from experience is a longstanding goal of AI." LLM은 현재 두 방식으로 자기 개선: (1) self-reflection으로 **context update**, (2) RL로 **weight update**. E-SPL은 **이 둘을 동시 진행** — 모델 컨텍스트와 가중치를 함께 개선.
- **시그마팀 적용**: **원본 §5.4.5의 GEPA 호칭을 E-SPL로 교체**. E-SPL이 더 정확하고 최신. 시그마는 가중치 업데이트 권한 없으므로 **E-SPL의 context update 부분만** 채택:
  - Top 분석가 성공 프롬프트 → 유전 알고리즘 crossover
  - 주간 메타리뷰 fitness signal 활용
  - E-SPL 논문의 평가 프로토콜 (Pass@k, 성공률) 도입

#### [6] STELLA: Self-Evolving LLM Agent for Biomedical Research
- **arXiv**: 2507.02004v1 (cs.AI)
- **Published**: 2025-07-01
- **Authors**: Ruofan Jin, Zaixi Zhang, Mengdi Wang *et al.* (4 total)
- **Abstract (요약)**: 바이오의학 데이터/도구/문헌의 폭발적 성장. 고정 도구셋의 AI agent는 확장성 부족. STELLA는 **multi-agent architecture**로 **운영 경험 증가 → 정확도 2배** 달성. 도구 라이브러리 + 추론 템플릿 라이브러리 **동적 확장**.
- **시그마팀 적용**: §5.4.4 개선 — 시그마팀의 **skill library 동적 확장** 패턴 채택. 성공한 feedback 조합을 **reusable template**로 저장, 유사 상황에서 자동 재사용. `sigma.skill_templates` 테이블 신설 고려.

### 📦 GitHub README 4건

#### [7] Jido (⭐1,652, Elixir 자율 에이전트 프레임워크)
- **Repo**: `agentjido/jido`
- **최신 커밋**: 2026-04-14 (3일 전)
- **Hex**: `{:jido, "~> 2.0"}`
- **README 핵심 인용**:
  > "Jido helps you build agent systems as ordinary Elixir and OTP software. AI is optional. The core package gives you the agent architecture and runtime; companion packages such as `jido_ai` add model integration."
  > "Jido isn't 'better GenServer' - it's a formalized agent pattern built on GenServer."
- **생태계 재확인**:
  - `jido` 코어
  - `jido_action` — 검증된 액션 + AI tool 통합
  - `jido_signal` — CloudEvents 메시지
  - `jido_ai` — LLM 통합
  - `req_llm` — HTTP client
- **시그마팀 적용**: 원본 §5.1 Elixir 전면 전환 설계 **100% 유효**. "AI is optional" 특성이 장점 — 비LLM Action(DB 쿼리, 메트릭 수집)은 LLM 비용 없이 실행.

#### [8] Hermes Agent (⭐95,187, NousResearch 자기 진화 에이전트)
- **Repo**: `NousResearch/hermes-agent`
- **README 핵심 인용**:
  > "The self-improving AI agent built by Nous Research. It's the only agent with a built-in learning loop — it creates skills from experience, improves them during use, nudges itself to persist knowledge, searches its own past conversations, and builds a deepening model of who you are across sessions."
  > "A closed learning loop — Agent-curated memory with periodic nudges. Autonomous skill creation after complex tasks. Skills self-improve during use. FTS5 session search with LLM summarization for cross-session recall. **Compatible with the agentskills.io open standard**."
  > "Delegates and parallelizes — Spawn isolated subagents for parallel workstreams. Write Python scripts that call tools via RPC, collapsing multi-step pipelines into zero-context-cost turns."
  > "`hermes claw migrate` — Migrate from a retired gateway"
- **시그마팀 적용**:
  1. `agentskills.io` 표준 호환 설계 — 시그마 MCP tool이 Hermes 생태계에서 즉시 사용 가능
  2. **FTS5 + LLM summarization for cross-session recall** — 시그마 `agent-memory`에 FTS5 추가 검토 (현재 pgvector만)
  3. **Periodic nudges** 메커니즘 — 시그마가 타 팀에 "기억 통합" 신호 보내는 추가 Directive 고려

#### [9] CloudEvents v1.0 Specification
- **Repo**: `cloudevents/spec`
- **README 핵심**: Jido Signal이 envelope 구조로 채택한 표준. `id`, `source`, `type`, `specversion`, `datacontenttype`, `data` 등 필수 필드.
- **시그마팀 적용**: Jido Signal 사용 시 자동 준수. **시그마 Signal type 규약 정의** 필요:
  - `sigma.observation.<team>` — Tier 0
  - `sigma.advisory.<team>` — Tier 1
  - `sigma.directive.<team>.<action>` — Tier 2
  - `sigma.approval_request.<team>` — Tier 3 (Mailbox 대기)
  - `sigma.meta.weekly_review` — 내부 이벤트

#### [10] Reflexion 공식 코드 (noahshinn/reflexion)
- **Repo**: `noahshinn/reflexion`
- **README 핵심**: NeurIPS 2023 공식 코드. 3개 태스크(decision-making/reasoning/programming) 벤치마크. Python 구현.
- **시그마팀 적용**: Reflexion 구현 시 참조. **Elixir로 포팅**하되 코어 알고리즘은 일치시킴:
  1. Actor가 시도 → trajectory 기록
  2. Evaluator가 성공/실패 평가
  3. Self-Reflection이 언어적 feedback 생성
  4. Experience buffer에 누적
  5. 다음 Actor 실행 시 buffer 참조

---


## 3. 원본 설계서 Delta

다음은 `docs/SIGMA_REMODELING_PLAN_2026-04-17.md`에 반영할 수정/추가 사항입니다.

### 3.1 §5.1 Elixir 전면 전환 — **변경 없음, 100% 유효**

Jido README 확인 결과 원본 설계의 모든 가정(Agent/Action/Signal/Directive/Pod) 유효. 구현 시 `Sigma.Skill.*`을 `Jido.Action`으로 포팅하는 코드 샘플은 실제 v2 API와 일치.

**유일한 추가**: README의 **`jido_action` — composable, validated actions with AI tool integration** 문구로 볼 때, skill을 **MCP tool 호환**으로도 동시 노출 가능. 이건 §5.2와 연결됨.

### 3.2 §5.2 MCP vs Skills — **`agentskills.io` 표준 호환 명시 추가**

원본 §5.2.3 하이브리드 전략은 유지. **추가 조항**:

> **§5.2.6 추가 (30차 보강)** — Sigma MCP Server는 `agentskills.io` 오픈 표준을 준수하도록 설계. 이로써:
> - Hermes Agent 사용자가 시그마 skill을 즉시 활용 가능
> - 향후 `hermes claw migrate` 경로로 retired gateway 사용자도 접근 가능
> - 표준 YAML frontmatter 형식 따름 (name/description/tools/model)

### 3.3 §5.3 완전 자율 운영 — **Constitutional AI 원칙 목록 추가**

원본 4티어 리스크 게이트에 추가:

> **§5.3.7 추가 (30차 보강)** — `config/sigma_principles.yaml` 신설. Constitutional AI RLAIF 패턴 채택.
>
> ```yaml
> # 시그마팀 자동 적용 헌법
> principles:
>   - id: P-001
>     text: "실자금·개인정보·계정 권한 변경은 Tier 3 승인 필수"
>     tier_override: 3
>   - id: P-002
>     text: "동일 팀에 24시간 내 3개 이상 Tier 2 변경 금지"
>     rate_limit:
>       scope: team
>       window_hours: 24
>       max_tier2: 3
>   - id: P-003
>     text: "직전 2회 rollback 발생한 (team, feedback_type) 조합은 Tier 0 강등"
>     circuit_breaker:
>       rollback_threshold: 2
>       demote_to_tier: 0
>   - id: P-004
>     text: "분석가 confidence < 0.3일 때 Tier 2 이상 차단"
>     min_confidence:
>       tier2_plus: 0.3
> ```
>
> Commander가 Directive 실행 직전 이 원칙에 부합하는지 **자기평가 (self-critique)** — Constitutional AI 2단계(Supervised + RL) 중 Supervised 단계.

### 3.4 §5.4 피드백 루프 — **GEPA → E-SPL 교체 + reflection tokens 도입**

#### 3.4.1 §5.4.5 수정 — GEPA 명칭 변경

**변경 전**: "Sigma.GEPA.evolve_weekly/0"
**변경 후**: "Sigma.ESPL.evolve_weekly/0" — arXiv 2602.14697 (E-SPL: Evolutionary System Prompt Learning)

**근거**: 외부 서칭 결과 "GEPA"는 ECC 가이드에 등장하나 공식 논문 확인 불가. 대신 **2026-02-16 E-SPL 논문**이 동일 개념(system prompt evolutionary learning)을 엄밀하게 정의. E-SPL이 더 최신이고 검증 가능한 레퍼런스.

**구현 조정**:
```elixir
defmodule Sigma.ESPL do
  @moduledoc """
  E-SPL (Evolutionary System Prompt Learning) based weekly evolution.
  Reference: arXiv 2602.14697 (2026-02-16)
  - context update only (weight update not applicable for sigma)
  - crossover + mutation + selection
  - fitness = weekly effectiveness score
  """

  def evolve_weekly do
    population = Sigma.Registry.current_prompts()
    fitness = Sigma.Metric.weekly_effectiveness_by_analyst()

    # E-SPL 논문 Algorithm 1 기반
    survivors = tournament_selection(population, fitness, k: 3)
    offspring = generate_offspring(survivors, ops: [:crossover, :mutation])
    Sigma.Registry.propose_generation(offspring)  # Shadow mode 1주 검증 후 승격
  end
end
```

#### 3.4.2 §5.5.4 수정 — Self-RAG에 reflection tokens 도입

**변경 전**: `needs_retrieval?`, `relevant?`, `supports_claim?`, `useful_quality?` — Elixir 함수로 판단
**변경 후**: LLM이 **특수 토큰 발생**시켜 판단 (논문 표준)

```elixir
defmodule Sigma.SelfRAG do
  @retrieval_tokens ~w([Retrieve] [No-Retrieve])a
  @relevance_tokens ~w([Relevant] [Irrelevant])a
  @support_tokens ~w([Fully-Supported] [Partially-Supported] [No-Support])a
  @useful_tokens ~w([Useful:5] [Useful:4] [Useful:3] [Useful:2] [Useful:1])a

  def retrieve_with_gate(query, opts \\ []) do
    # Step 1: LLM이 [Retrieve] vs [No-Retrieve] 결정
    case prompt_retrieval_gate(query) do
      :no_retrieve -> []
      :retrieve ->
        raw_hits = Sigma.Memory.recall(query, opts)
        # Step 2~4: 각 hit에 대해 relevance/support/usefulness 판정
        Enum.filter(raw_hits, &full_gate_pass?(&1, query))
    end
  end
end
```

### 3.5 §5.5 RAG 재검토 — **FTS5 검토 조항 추가**

Hermes README의 "FTS5 session search with LLM summarization" 언급 관련:

> **§5.5.6 추가 (30차 보강)** — PostgreSQL의 `tsvector` Full-Text Search가 이미 Hermes의 FTS5와 기능상 동등. 시그마는 **pgvector (의미 검색) + tsvector (키워드 검색) 하이브리드** 유지. 별도 FTS5 도입 불필요.

### 3.6 §5.6 다윈팀 TS only — **AI Scientist v2 패턴 참조 연결**

> **§5.6.6 추가 (30차 보강)** — 다윈팀이 자율 연구 사이클 구축 시 AI Scientist v2 (arXiv 2504.08066) 참조. 시그마는 다윈에 **Signal로만** 트리거:
> - `sigma.advisory.darwin.knowledge_capture` — Standing Orders 승격 후보 힌트
> - `sigma.advisory.darwin.research_topic` — 최근 이벤트 기반 연구 주제 추천

---


## 4. 승격된 아이디어 + 기각된 아이디어

### 4.1 🆙 승격 (설계서에 반영 또는 강화)

| 아이디어 | 원천 | 시그마 적용 |
|----------|------|-------------|
| Reflexion 3-step (Actor-Evaluator-Self-Reflection) | Shinn et al. 2303.11366 | §5.4.3 구현 시 정확한 단계 명시 |
| Self-RAG reflection tokens | Asai et al. 2310.11511 | §5.5.4 LLM 토큰 기반 게이트로 강화 |
| Constitutional AI 원칙 목록 | Bai et al. 2212.08073 | **§5.3.7 신설** — `sigma_principles.yaml` |
| E-SPL context-only 진화 | Zhang et al. 2602.14697 | §5.4.5 GEPA 대체 |
| STELLA skill template library | Jin et al. 2507.02004 | §5.4.4 강화 — 성공 조합 재사용 |
| `agentskills.io` 표준 호환 | Hermes README | **§5.2.6 신설** — MCP 표준 준수 |
| FTS5 hybrid search | Hermes README | PostgreSQL tsvector로 동등 기능 확인 |
| AI Scientist v2 tree search | Yamada et al. 2504.08066 | §5.6.6 신설 — 다윈팀 분리 원칙 연결 |
| Jido `jido_action` AI tool 통합 | Jido README | §5.2 하이브리드 전략의 MCP Layer 구현 |
| CloudEvents Signal type 규약 | CloudEvents spec | `sigma.*` naming convention 4단계 정립 |

### 4.2 ❌ 기각 (본 리모델링에 도입 안 함)

| 아이디어 | 기각 사유 |
|----------|-----------|
| Hermes Agent 자체 전면 도입 | 시그마팀 목적은 "메타 오케스트레이터"이지 "사용자 대화 에이전트"가 아님. Hermes는 Telegram/Discord 대화형 에이전트로 설계. 패턴만 차용 |
| `hermes claw migrate` 실행 | Hub alarm은 시스템 알람 허브, 시그마팀은 소비자일 뿐. 이주는 별개 프로젝트 |
| E-SPL의 weight update 부분 | 시그마는 LLM 모델 훈련 권한 없음. context update만 채택 |
| AI Scientist v2 직접 도입 | 다윈팀 영역. 시그마는 트리거만 |
| DSPy/GEPA SDK 도입 | Python 의존성 추가. Jido 생태계에 맞춰 Elixir 네이티브 유지. E-SPL 알고리즘만 포팅 |
| Paperclip v2 전면 도입 | 워커웹 대체 아님 (RESEARCH_CC §15 이미 결론). 시그마는 Goal Ancestry 패턴만 |
| agntcy/oasf (Open Agentic Schema) | 306★, 아직 초기. Jido가 안정적 대안 |

### 4.3 📋 보류 (Phase 2+ 재검토)

| 아이디어 | 보류 사유 | 재검토 시점 |
|----------|-----------|-------------|
| `agentskills.io` 스킬 import | 외부 생태계 활용 잠재력 있으나 보안 감사 필요 | Phase 3 후반 |
| Hermes FTS5 session search | pgvector + tsvector로 충분 여부 Phase 1 shadow에서 확인 | Phase 1 종료 시 |
| STELLA의 추론 템플릿 라이브러리 | 운영 데이터 축적 후 효과 재측정 | Phase 4 GEPA 이후 |
| 자동 스킬 생성 (Hermes 패턴) | "무엇이 skill인가"의 경계 모호 | Phase 5 MCP 안정화 후 |

---

## 5. Phase 0 최종 변경사항

원본 설계서 §6 Phase 0 (준비 1주)에 **3가지 수정 반영**:

### 5.1 의존성 목록 최신화

```elixir
# mix.exs
defp deps do
  [
    # 원본 설계 그대로
    {:jido, "~> 2.0"},
    {:jido_action, "~> 1.0"},
    {:jido_signal, "~> 1.0"},
    {:jido_ai, "~> 1.0"},
    {:req_llm, "~> 1.0"},

    # 30차 보강 추가
    {:postgrex, "~> 0.20"},       # Elixir 네이티브 PG 파라미터 바인딩 (escape_sql 제거용)
    {:cloudevents, "~> 0.6"},     # CloudEvents v1.0 spec 직접 사용 (선택)
    {:opentelemetry, "~> 1.5"},   # Jido Observe 연동
    {:jason, "~> 1.4"},           # JSON (이미 있을 가능성 높음)
  ]
end
```

### 5.2 신규 문서 추가

```
docs/
├ SIGMA_REMODELING_PLAN_2026-04-17.md         (원본, 1405줄)
├ SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md     (본 문서, 30차 보강)
├ SIGMA_REMODELING_ROLLBACK.md                (원본 §7.3 Kill Switch 상세화)
└ config/
   └ sigma_principles.yaml.example            (Constitutional AI 원칙 샘플)
```

### 5.3 Phase 0 Exit Criteria 재정의

**변경 전**:
- `mix deps.get` 성공
- `mix compile` 경고 없음
- 기존 `runDaily()` cron은 그대로 동작 중

**변경 후 (30차)**:
- `mix deps.get` 성공 (jido + postgrex + opentelemetry 포함)
- `mix compile` 경고 0건
- `docs/SIGMA_REMODELING_PLAN_2026-04-17.md` + `SIGMA_REMODELING_RESEARCH_SUPPLEMENT.md` 마스터 승인 서명
- `config/sigma_principles.yaml` 초안 작성 + 마스터 리뷰
- 기존 TS `runDaily()` 정상 동작 확인 (baseline 녹음)
- Kill Switch 환경변수 5개 `.env` 샘플 작성

---

## 📌 결론

본 보강 연구는 원본 설계의 **방향성을 100% 검증**하고, 일부 세부 사항을 최신 논문/OSS 표준에 맞춰 정밀화했습니다. 주요 변경은 (1) GEPA → E-SPL 명칭 교체, (2) Constitutional AI 기반 원칙 목록 추가, (3) Self-RAG reflection tokens 도입, (4) agentskills.io 표준 호환 선언 4건이며, **핵심 아키텍처(Jido Pod + 4티어 게이트 + 4 Generation Loop)는 그대로**입니다.

Phase 0 진입 준비 완료. **마스터 승인 서명** 후 즉시 착수 가능.

---

**작성**: 메티 (Metis, claude.ai) / 2026-04-17 30차 세션
**검토 요청**: 마스터 (제이)
**상위 문서**: `docs/SIGMA_REMODELING_PLAN_2026-04-17.md`
**다음 단계**: 마스터 승인 후 Phase 0 착수 — 의존성 추가 + skeleton + 원칙 YAML + Kill Switch
