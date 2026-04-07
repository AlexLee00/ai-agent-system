# Elixir/OTP 오케스트레이션 설계 — 팀 제이 최적화!

> 작성: 메티 (Claude Opus 4.6) + 마스터 직접 검토!
> 작성일: 2026-04-07
> 목적: 팀 제이 122에이전트 시스템의 완전자율을 위한 Elixir/OTP 아키텍처 설계!
> 참조: Jido(⭐1.2K), ExAgent, Sagents, NexAgent, Synapse, Beamlens, SwarmEx

---

## 1. 왜 Elixir인가 — 연구/커뮤니티 근거!

### 1-1. 핵심 논문/아티클

```
① "Your Agent Framework Is Just a Bad Clone of Elixir"
   (George Guimarães, 2026.03 — HN 톱!)
   핵심: Python/JS 에이전트 프레임워크가 만드는 모든 패턴
   (격리된 상태, 메시지 패싱, 감독 계층, 장애 복구)
   = BEAM에 1986년부터 런타임 레벨에서 내장!

   "Langroid README: 에이전트는 '메시지 트랜스포머'로 직접 메시지 패싱"
   = 이건 거의 문자 그대로 Actor Model.
   LangGraph: 상태 그래프 + 리듀서 = BEAM Process + GenServer

② José Valim: "Why Elixir is the Best Language for AI" (2026)
   Tencent 연구: Claude Opus 4가 Elixir에서 80.3% 코드 정확도!
   (C# 74.9% 대비 +5.4%p — 전 언어 1위!)
   = Claude Code가 Elixir 코드를 가장 잘 짠다!

③ OpenMetal Reference Architecture (2026.03)
   "100+ AI agents, 5,000+ conversations on Elixir/BEAM"
   단일 클러스터에서 수백만 에이전트 오케스트레이션!

④ Medium: "I Built Millions of AI Agents in Elixir" (2026.01)
   "Python은 AI 모델 개발에 최고, 오케스트레이션에는 재앙"
   "에이전트 = 프로세스. DB 부활 없음, 직렬화 오버헤드 없음."
```

### 1-2. Elixir vs Node.js — 팀 제이 관점

```
                  현재 (Node.js + launchd)        Elixir/OTP
프로세스 격리      ❌ 공유 메모리                  ✅ 완전 격리
자동 복구         🟡 덱스터→독터 (수분)           ✅ Supervisor (밀리초!)
핫코드 리로드     ❌ 프로세스 재시작 필요          ✅ 무중단 코드 업데이트!
동시성            🟡 싱글스레드 이벤트루프         ✅ 수만 경량 프로세스!
프로세스 수       ~30 launchd (무거움)            수십만 BEAM 프로세스 (가벼움!)
에이전트 상태     PostgreSQL + 재로드             GenServer 메모리 상태!
분산              ❌ 수동 구현                     ✅ 내장 (노드 간 투명 통신!)
관측성            🟡 커스텀 (덱스터)              ✅ :observer + Telemetry!
```

---

## 2. Elixir 에이전트 프레임워크 분석 (7개!)

### 2-1. Jido (⭐1.2K!) — 가장 성숙!

```
핵심: 순수 함수형 에이전트 + OTP 런타임!
  에이전트 = 불변 데이터 구조 + cmd/2 함수!
  상태 변경 = 순수 데이터 변환!
  부수효과 = Directive로 분리!
  → 테스트 가능 + 결정적!

아키텍처:
  Agent (불변 상태) → cmd(agent, action) → {new_agent, directives}
  Runtime (OTP GenServer) → Directive 실행 (부수효과!)
  Pod (에이전트 그룹) → 계층적 토폴로지!

팀 제이 적합도: ★★★★★
  에이전트 = 불변 데이터 → 테스트 용이!
  Directive = 부수효과 분리 → 안전!
  Pod = 팀 단위 그룹핑!
  jido_ai 패키지 = LLM 연동!
```

### 2-2. ExAgent (5일 전!! 최신!)

```
핵심: OTP primitives + 4가지 멀티에이전트 패턴!
  Sequential: 순차 실행!
  Parallel: 병렬 실행!
  Router: 라우팅 기반 선택!
  Orchestrator: 동적 오케스트레이션!

LLM 프로바이더: OpenAI, Gemini, DeepSeek 지원!
  Protocol 기반 확장 가능!

팀 제이 적합도: ★★★★☆
  4가지 패턴이 우리 팀 구조와 매핑!
  너무 새로움 (5일!) → 안정성 미검증!
```

### 2-3. Sagents — Human-in-the-Loop!

```
핵심: OTP Supervision + 미들웨어 + 마스터 승인!
  Human-in-the-loop: 사람 승인 후 실행!
  Sub-agent delegation: 하위 에이전트 위임!
  Phoenix LiveView: 실시간 디버거!

팀 제이 적합도: ★★★★★
  Human-in-the-loop = 마스터 승인 체계!
  Sub-agent = 팀장→팀원 위임!
  LiveView 디버거 = 실시간 모니터링!
```

### 2-4. NexAgent — 자기진화!

```
핵심: 장기 실행 + 자기진화 AI 에이전트!
  "대부분 에이전트 = 1회성 실행. NexAgent = 24/7 상주!"
  영속 세션 + 메모리!
  백그라운드 잡!

팀 제이 적합도: ★★★★★
  팀 제이 = 24/7 상주 시스템!
  자기진화 = 피드백 루프!
```

### 2-5. Synapse — PostgreSQL 영속성!

```
핵심: Postgres 기반 멀티에이전트 오케스트레이션!
  상태 영속 = PostgreSQL!

팀 제이 적합도: ★★★★☆
  우리 이미 PostgreSQL 단일화 완료!
  Synapse 패턴 참조 가능!
```

### 2-6. Beamlens — LLM 진단!

```
핵심: Supervision Tree 안에서 LLM이 메트릭 분석!
  이상 감지 + 장애 진단 + 메시지큐 병목 추적!

팀 제이 적합도: ★★★★★
  = 덱스터+닥터의 Elixir 버전!
  Supervision Tree에 내장 → 밀리초 진단!
```

### 2-7. SwarmEx — OpenAI Swarm 영감!

```
핵심: 경량 에이전트 오케스트레이션!
  OpenAI Swarm의 Elixir 포트!
  텔레메트리 내장!

팀 제이 적합도: ★★★☆☆
  너무 단순 → 122에이전트 규모에 부족!
```

---

## 3. 팀 제이 Elixir 아키텍처 설계!

### 3-1. 전체 아키텍처

```
┌──────────────────────────────────────────────────────┐
│ Elixir Application (OTP!)                            │
│                                                      │
│  TeamJay.Application (최상위 Supervisor!)             │
│    ├─ TeamJay.TeamSupervisor.Ska                     │
│    │    ├─ TeamJay.Agent.Andy (GenServer!)            │
│    │    ├─ TeamJay.Agent.Jimmy                        │
│    │    └─ TeamJay.Agent.Ska (팀장!)                  │
│    │                                                  │
│    ├─ TeamJay.TeamSupervisor.Luna                    │
│    │    ├─ TeamJay.Agent.Aria (기술분석!)             │
│    │    ├─ TeamJay.Agent.Sophia (감성!)               │
│    │    ├─ TeamJay.Agent.Oracle (온체인!)             │
│    │    ├─ TeamJay.Agent.Scout (토스증권!)            │
│    │    ├─ TeamJay.Agent.Zeus (강세!)                 │
│    │    ├─ TeamJay.Agent.Athena (약세!)               │
│    │    ├─ TeamJay.Agent.Nemesis (리스크!)            │
│    │    ├─ TeamJay.Agent.Hephaestos (실행!)          │
│    │    └─ TeamJay.Agent.Luna (팀장!)                │
│    │                                                  │
│    ├─ TeamJay.TeamSupervisor.Claude                  │
│    │    ├─ TeamJay.Agent.Dexter (감시!)              │
│    │    ├─ TeamJay.Agent.Doctor (복구!)              │
│    │    ├─ TeamJay.Agent.Archer (인텔!)              │
│    │    └─ TeamJay.Agent.Claude (팀장!)              │
│    │                                                  │
│    ├─ TeamJay.TeamSupervisor.Blog                    │
│    ├─ TeamJay.TeamSupervisor.Worker                  │
│    ├─ TeamJay.TeamSupervisor.Video                   │
│    ├─ TeamJay.TeamSupervisor.Darwin                  │
│    ├─ TeamJay.TeamSupervisor.Sigma                   │
│    │                                                  │
│    ├─ TeamJay.EventLake (이벤트 버스!)               │
│    ├─ TeamJay.MarketRegime (시장 체제!)              │
│    ├─ TeamJay.HiringManager (자율고용!)              │
│    └─ TeamJay.Diagnostics (Beamlens!)                │
│                                                      │
│  PostgreSQL (:5432) ← Ecto!                          │
│  Telegram ← Telegraf 또는 Nadia!                     │
│  MLX (:11434) ← HTTP!                                │
└──────────────────────────────────────────────────────┘
```

### 3-2. Supervision 전략 (핵심!)

```
TeamJay.Application
  strategy: :one_for_one (팀 독립! 한 팀 죽어도 다른 팀 안 죽음!)

TeamJay.TeamSupervisor.Luna
  strategy: :one_for_one (에이전트 독립!)
  max_restarts: 5, max_seconds: 60

  에이전트 크래시 시:
    Supervisor가 밀리초 내 자동 재시작!
    → 이전 상태는 PostgreSQL에서 복구!
    → 텔레그램 알림 (정보용!)
    → event_lake 기록!

  전체 팀 크래시 시:
    Application Supervisor가 팀 Supervisor 재시작!
    → 팀 내 모든 에이전트 순차 부팅!
    → 마스터 알림!

현재 launchd 대비:
  launchd: 프로세스 죽으면 재시작 (수초~수분!)
  OTP: 프로세스 죽으면 재시작 (밀리초!)
  + 격리: 다른 팀 영향 없음!
  + 핫코드 리로드: 코드 수정 후 재시작 없이 반영!
```

### 3-3. 에이전트 GenServer 패턴!

```elixir
# Jido 패턴 참조 — 팀 제이 에이전트!
defmodule TeamJay.Agent.Scout do
  use GenServer

  # 상태: 에이전트 설정 + 마지막 수집 결과!
  defstruct [:name, :team, :schedule, :last_result, :status]

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def init(opts) do
    # 스케줄 등록 (06:30, 18:30!)
    schedule_collection()
    {:ok, %__MODULE__{
      name: "scout",
      team: "investment",
      schedule: [~T[06:30:00], ~T[18:30:00]],
      status: :idle
    }}
  end

  # 스케줄된 수집!
  def handle_info(:collect, state) do
    new_state = do_collect(state)
    schedule_collection()
    {:noreply, new_state}
  end

  # 수집 로직!
  defp do_collect(state) do
    result = TeamJay.Scraper.Toss.scrape_all()
    # RAG 저장!
    TeamJay.EventLake.record(%{
      event_type: "scout_collect",
      team: "investment",
      agent: "scout",
      details: result
    })
    %{state | last_result: result, status: :idle}
  end

  defp schedule_collection do
    # 다음 스케줄 시간까지 타이머!
    Process.send_after(self(), :collect, next_interval())
  end
end
```

### 3-4. Node.js ↔ Elixir 브릿지!

```
핵심 결정: Elixir가 "오케스트레이터", Node.js가 "워커"!

방식 A: Erlang Port (추천!)
  Elixir → Port → Node.js 프로세스 stdin/stdout!
  에이전트 실행 로직은 기존 .js 그대로!
  Elixir는 프로세스 생명주기만 관리!

  장점: 기존 코드 수만 줄 수정 불필요!
  단점: stdin/stdout 직렬화 오버헤드!

방식 B: HTTP API (안전!)
  Elixir → HTTP → Node.js Hub(:7788)!
  기존 Hub API 그대로 활용!

  장점: 가장 안전, 기존 인프라 활용!
  단점: 네트워크 오버헤드!

방식 C: PostgreSQL 공유 (현실적!)
  Elixir ← PostgreSQL → Node.js!
  agent_events, agent_tasks 테이블 공유!
  Elixir: pg LISTEN/NOTIFY로 이벤트 수신!

  장점: 기존 아키텍처 변경 최소!
  단점: DB 의존성!

★ 추천: 방식 C (PostgreSQL) + 방식 B (HTTP) 하이브리드!
  Phase 1: PostgreSQL LISTEN/NOTIFY (기존 State Bus!)
  Phase 2: Hub API HTTP 호출 (긴급 작업!)
  Phase 3: 점진적으로 핵심 에이전트 Elixir 네이티브 전환!
```

### 3-5. TS 연결 지점!

```
TypeScript Phase 0~1과의 연결:
  1. message-envelope.ts → Elixir 메시지 구조체!
     TS @typedef → Elixir defstruct 매핑!
     JSON 직렬화/역직렬화 공유!

  2. event-lake.js JSDoc → Elixir EventLake GenServer!
     동일한 PostgreSQL 테이블 공유!
     Ecto 스키마 = TS @typedef와 동일 구조!

  3. hiring-contract.js → Elixir HiringManager!
     regimeGuide 타입 = TS + Elixir 공유!

  4. Zod 스키마 (Phase 1) → Elixir Ecto.Changeset!
     런타임 검증 양쪽에서 동일하게!
```

---

## 4. 마이그레이션 로드맵!

### Phase 0: TS JSDoc + tsconfig (지금! ✅)
```
기존 Node.js 코드 타입 안전 강화!
→ Elixir 전환 시 인터페이스가 명확!
→ 위험 0!
```

### Phase 1: Elixir 환경 + 프로토타입 (2주!)
```
[ ] OPS에 Elixir 설치! (brew install elixir!)
[ ] mix new team_jay 프로젝트 생성!
[ ] PostgreSQL 연결 (Ecto!)
[ ] TeamJay.Application + TeamSupervisor 1개!
[ ] 스카팀 Supervisor 프로토타입!
    andy GenServer + jimmy GenServer!
    크래시 시 자동 재시작 확인!
[ ] Node.js Hub HTTP 호출 테스트!
[ ] pg LISTEN/NOTIFY 이벤트 수신!
```

### Phase 2: 핵심 인프라 (2주!)
```
[ ] TeamJay.EventLake GenServer!
    pg LISTEN/NOTIFY → 이벤트 실시간 수신!
[ ] TeamJay.MarketRegime GenServer!
    시장 체제 상태 메모리 관리!
[ ] TeamJay.HiringManager!
    자율고용 Elixir 네이티브!
[ ] Beamlens 패턴 진단 모듈!
[ ] 텔레그램 연동 (Nadia 또는 Telegraf!)
```

### Phase 3: 팀별 전환 (4주!)
```
순서: 스카 → 클로드 → 루나 → 블로 → 워커 → 에디 → 다윈 → 시그마

각 팀 전환 프로세스:
  1. Elixir TeamSupervisor 생성!
  2. 에이전트별 GenServer 생성!
  3. 기존 launchd plist 비활성화!
  4. 1주 병렬 운영 (Elixir + launchd!)
  5. 안정 확인 → launchd 제거!
```

### Phase 4: 완전자율 (장기!)
```
[ ] 핫코드 리로드!
    Claude Code → 코드 수정 → TS 컴파일 → Elixir 핫리로드!
    = 프로세스 재시작 없이 에이전트 업데이트!
[ ] Beamlens 자동 진단!
    LLM이 BEAM 메트릭 분석 → 이상 감지 → 자동 조치!
[ ] 분산 (선택!)
    DEV ↔ OPS 노드 간 투명 통신!
```

---

## 5. 핵심 참조 프레임워크 활용 전략!

```
Jido (⭐1.2K):
  → 에이전트 패턴 참조! (불변 상태 + Directive!)
  → Pod 토폴로지 = 팀 단위!
  → 직접 의존하지 않고 패턴만 차용!

Sagents:
  → Human-in-the-loop 패턴!
  → 마스터 승인 텔레그램 버튼 = Sagents 승인 미들웨어!

Beamlens:
  → 진단 패턴 차용!
  → 덱스터+닥터 → Elixir Diagnostics GenServer!

Synapse:
  → PostgreSQL 영속성 패턴!
  → Ecto 스키마 = 기존 pg-pool.js 테이블!

NexAgent:
  → 장기 실행 + 자기진화 패턴!
  → 피드백 루프 + experience why!

ExAgent:
  → 4가지 멀티에이전트 패턴!
  → Sequential/Parallel/Router/Orchestrator!
  → 루나팀: Orchestrator 패턴!
  → 블로팀: Sequential 패턴!
```

---

## 6. 결론 — TS와의 관계!

```
TS Phase 0~1: 에이전트 코드의 타입 안전! (근육!)
Elixir Phase 1~4: 에이전트 프로세스의 생명주기! (두뇌!)

= 같은 목표(완전자율)의 다른 레이어!
= 전략은 연결, 설계 문서는 분리!
= 구현 시기: TS 먼저 → Elixir 나중!

"Actor Model(1986) = Agent Model(2026)
 Erlang이 전화교환기에서 해결한 문제를
 AI 에이전트 시스템이 지금 다시 풀고 있다.
 팀 제이는 이 역사적 교훈을 활용해야 한다."
```
