# TypeScript + Elixir 통합 구현 계획!

> 작성: 메티 (Claude Opus 4.6) + 마스터 직접 검토!
> 작성일: 2026-04-07
> 목적: TS 타입 안전 + Elixir 프로세스 관리 = 완전자율!
> 참조: CODEX_TS_PHASE0_JSDOC.md, ELIXIR_OTP_DESIGN.md, ELIXIR_IMPLEMENTATION_PLAN.md

---

## 전체 타임라인 (한눈에!)

```
4월 1주 (4/07~4/13)  TS Phase 0-A: tsconfig + 핵심 10파일 JSDoc!
4월 2주 (4/14~4/20)  TS Phase 0-B: bots/ JSDoc + CI typecheck!
4월 3주 (4/21~4/27)  TS Phase 1-A: 핵심 5파일 .ts 전환 + Zod!
4월 4주 (4/28~5/04)  TS Phase 1-B: 빌드 파이프라인 + Elixir 설치!
5월 1주 (5/05~5/11)  Elixir Phase 1-A: 프로토타입 + Ecto!
5월 2주 (5/12~5/18)  Elixir Phase 1-B: 스카팀 Supervisor!
5월 3주 (5/19~5/25)  Elixir Phase 2-A: EventLake + MarketRegime!
5월 4주 (5/26~6/01)  Elixir Phase 2-B: Diagnostics + 텔레그램!
6월 1주 (6/02~6/08)  Elixir Phase 3-A: 스카+클로드팀 전환!
6월 2주 (6/09~6/15)  Elixir Phase 3-B: 루나팀 Shadow!
6월 3주 (6/16~6/22)  Elixir Phase 3-C: 루나 본격 + 나머지!
6월 4주 (6/23~6/29)  TS Phase 2: 팀별 .ts 전환 시작!
7월+                  TS Phase 3 + Elixir Phase 4: strict + 핫코드!
```

---

## TS Phase 0-A: tsconfig + 핵심 JSDoc (4/07~4/13!) ← 지금!

```
코덱스 프롬프트: CODEX_TS_PHASE0_JSDOC.md (327줄!) ✅ 전달!

[ ] tsconfig.json 생성! (checkJs:true, strict:false!)
[ ] packages/core/lib/ 핵심 10파일 JSDoc!
    ① event-lake.js (0→전체!) — @typedef EventRecord!
    ② hiring-contract.js (0→전체!) — @typedef AgentCandidate, RegimeGuide!
    ③ central-logger.js (0→전체!)
    ④ openclaw-client.js (0→전체!)
    ⑤ llm-model-selector.js (0→핵심!)
    ⑥ llm-fallback.js (6→보강!) — @typedef FallbackResult!
    ⑦ market-regime.js (0→전체!) — @typedef RegimeResult, RegimeSignals!
    ⑧ trade-journal-db.js (0→핵심 export!)
    ⑨ rag.js (41→@typedef 추가!)
    ⑩ message-envelope.js (13→@typedef 추가!)
[ ] package.json "typecheck" 스크립트!
[ ] npx tsc --noEmit 실행!

검증: npx tsc --noEmit 에러 < 50개!
```

---

## TS Phase 0-B: bots/ JSDoc + CI (4/14~4/20!)

```
[ ] bots/investment 핵심 파일 JSDoc!
    nemesis.js — detectRegime, hireAnalyst 타입!
    luna.js — 시그널 타입!
    hephaestos.js — 매매 실행 타입!
    scout.js — 수집 결과 타입!
[ ] bots/claude 핵심 파일 JSDoc!
    dexter.js — 체크 결과 타입!
    doctor.js — 복구 결과 타입!
[ ] bots/orchestrator 핵심 파일 JSDoc!
    research-tasks.js — 과제 타입!
    research-task-runner.js — 실행 타입!
[ ] GitHub Actions CI에 tsc --noEmit 추가!
    .github/workflows/typecheck.yml!
[ ] experience why 2단계 (4/21 예정!)

검증: CI green! + npx tsc --noEmit 에러 < 20개!
```

---

## TS Phase 1-A: 핵심 .ts 전환 + Zod (4/21~4/27!)

```
[ ] npm install typescript zod esbuild @types/node!
[ ] 핵심 5파일 .js → .ts 전환!
    ① packages/core/lib/message-envelope.ts!
       → MessageEnvelope 인터페이스!
       → Zod schema (런타임 검증!)
    ② packages/core/lib/event-lake.ts!
       → EventRecord 인터페이스!
       → record/search/addFeedback 타입!
    ③ packages/core/lib/hiring-contract.ts!
       → AgentCandidate, RegimeGuide 인터페이스!
    ④ packages/core/lib/market-regime.ts!
       → RegimeType, RegimeResult 인터페이스!
    ⑤ packages/core/lib/pg-pool.ts!
       → query<T> 제네릭 타입!

[ ] Zod 스키마 도입!
    LLM 응답 런타임 검증!
    agent_events payload 검증!
    config.yaml 스키마 검증!

[ ] .ts → .js 컴파일 확인!
    esbuild로 빌드!
    기존 require() 호환!

검증: tsc --noEmit 0 에러 (핵심 5파일!)
     기존 Node.js 동작 변경 없음!
```

---

## TS Phase 1-B: 빌드 + Elixir 환경 (4/28~5/04!)

```
TS:
  [ ] esbuild 빌드 파이프라인!
      packages/core/lib/*.ts → dist/*.js!
      소스맵 생성!
  [ ] tsconfig strict: false 유지!
      paths alias (@core/*)!
  [ ] package.json build 스크립트!
  [ ] CI: build + typecheck!

Elixir (병행!):
  [ ] brew install elixir (OPS!)
  [ ] elixir --version 확인!
  [ ] mix new team_jay --sup!
  [ ] 디렉토리: /Users/alexlee/projects/team-jay-elixir/
  [ ] Ecto + Postgrex 의존성!
  [ ] jay DB 연결 확인!

검증: npm run build 성공!
     elixir --version 정상!
     mix compile 성공!
```

---

## Elixir Phase 1-A: 프로토타입 + Ecto (5/05~5/11!)

```
[ ] TeamJay.Repo — PostgreSQL 연결!
[ ] agent_events Ecto 스키마!
[ ] pg LISTEN/NOTIFY 수신!
    INSERT 트리거 → 실시간 이벤트!
[ ] TeamJay.HubClient!
    Hub HTTP 호출! (GET /hub/health!)
    POST /hub/pg/query!
[ ] event_lake 테이블 Ecto 조회!

TS 연결 포인트:
  event-lake.ts @typedef → Ecto Schema 동일 구조!
  message-envelope.ts → Elixir defstruct!
  JSON 직렬화 공유!

검증: Ecto → agent_events 조회 성공!
     pg LISTEN/NOTIFY 수신 성공!
     Hub API HTTP 호출 성공!
```

---

## Elixir Phase 1-B: 스카팀 Supervisor (5/12~5/18!)

```
[ ] TeamJay.Application (최상위 Supervisor!)
[ ] TeamJay.TeamSupervisor.Ska!
    strategy: :one_for_one!
[ ] TeamJay.Agent.Andy GenServer!
    handle_info(:health_check!) → Hub HTTP!
[ ] TeamJay.Agent.Jimmy GenServer!
[ ] 크래시 시뮬레이션!
    프로세스 kill → 밀리초 자동 재시작!
[ ] 텔레그램 알림 (Hub 경유!)

검증: 크래시 → 복구 < 100ms!
     기존 launchd 영향 없음! (병렬!)
```

---

## Elixir Phase 2-A: EventLake + MarketRegime (5/19~5/25!)

```
[ ] TeamJay.EventLake GenServer!
    pg LISTEN/NOTIFY → 실시간!
    최근 1000건 메모리 캐시!
    팀별/타입별 통계!

[ ] TeamJay.MarketRegime GenServer!
    market-regime.ts 로직 포팅!
    4가지 체제 감지!
    체제 변경 시 이벤트 발행!

TS 연결:
  market-regime.ts RegimeType → Elixir atom!
  event-lake.ts EventRecord → Ecto Schema!

검증: 이벤트 실시간 수신!
     체제 감지 동작!
```

---

## Elixir Phase 2-B: Diagnostics + 텔레그램 (5/26~6/01!)

```
[ ] TeamJay.Diagnostics!
    :observer 연동!
    프로세스 메모리/메시지큐 모니터링!
    Beamlens 패턴 진단!

[ ] 텔레그램 연동!
    {:nadia 또는 :telegraf}!
    팀별 토픽 알림!
    마스터 승인 인라인 키보드!

[ ] Phase 2 통합 테스트!

검증: Elixir Supervisor → Hub → Node.js!
     텔레그램 알림 정상!
```

---

## Elixir Phase 3: 팀별 전환 (6/02~6/22!)

```
Week 1 (6/02~6/08): 스카+클로드팀!
  [ ] 스카팀 launchd → Elixir Supervisor!
  [ ] 클로드팀 launchd → Elixir Supervisor!
  [ ] 1주 병렬 운영!

Week 2 (6/09~6/15): 루나팀 Shadow!
  [ ] 루나팀 Elixir Supervisor (감시만!)
  [ ] 기존 launchd는 유지!
  [ ] 불일치 모니터링!

Week 3 (6/16~6/22): 루나 본격 + 나머지!
  [ ] 루나팀 launchd → Elixir!
  [ ] 블로/워커/에디/다윈/시그마!
  [ ] 76 launchd → Elixir Supervisor!
```

---

## TS Phase 2: 팀별 .ts 전환 (6/23~!)

```
Elixir 안정화 후 TS 전환 재개!
순서: core → claude → luna → worker → ska → blog!

[ ] packages/core/lib/ 나머지 .ts 전환!
    reporting-hub.ts, llm-router.ts...
[ ] bots/claude/*.ts!
[ ] bots/investment/*.ts!
[ ] 각 팀 전환 후 1주 관찰!
```

---

## TS Phase 3 + Elixir Phase 4: 완전자율 (7월+!)

```
TS:
  [ ] tsconfig "strict": true!
  [ ] CI: tsc --noEmit 0 에러 필수!
  [ ] Claude Code 수정 시 컴파일 검증!

Elixir:
  [ ] 핫코드 리로드!
  [ ] Claude Code → 코드 수정 → TS 컴파일 → Elixir 핫리로드!
  [ ] 분산 노드 (DEV ↔ OPS!)

= 완전자율: 시스템이 스스로 진화!
```

---

## 의존성 그래프!

```
TS Phase 0-A (JSDoc!) ──────────── 4/07~4/13  ← 지금!
  │
  ├── TS Phase 0-B (bots JSDoc!) ── 4/14~4/20
  │     │
  │     ├── TS Phase 1-A (.ts+Zod!) ── 4/21~4/27
  │     │     │
  │     │     └── TS Phase 1-B (빌드!) ── 4/28~5/04
  │     │           │                        │
  │     │           │  ┌─────────────────────┘
  │     │           │  │ Elixir 설치 (병행!)
  │     │           │  │
  │     │           └──┤
  │     │              │
  │     │     Elixir Phase 1-A (Ecto!) ── 5/05~5/11
  │     │              │
  │     │     Elixir Phase 1-B (Supervisor!) ── 5/12~5/18
  │     │              │
  │     │     Elixir Phase 2-A (Event+Regime!) ── 5/19~5/25
  │     │              │
  │     │     Elixir Phase 2-B (Diagnostics!) ── 5/26~6/01
  │     │              │
  │     │     Elixir Phase 3 (팀별 전환!) ── 6/02~6/22
  │     │              │
  │     └───── TS Phase 2 (팀별 .ts!) ── 6/23~
  │                    │
  │     TS Phase 3 + Elixir Phase 4 ── 7월+
  │                    │
  └──── 완전자율!
```

핵심 의존성:
  TS Phase 0 → Phase 1: JSDoc 완료 후 .ts 전환!
  TS Phase 1-B ↔ Elixir 설치: 병행! (같은 주!)
  TS Phase 1 → Elixir Phase 1: 타입 정의 공유!
  Elixir Phase 3 → TS Phase 2: Elixir 안정화 후!

---

## 병렬 작업 가능 구간!

```
TS Phase 1-B + Elixir 설치: 같은 주 병행!
  오전: esbuild 빌드 파이프라인!
  오후: brew install elixir + mix new!

Elixir Phase 2 + 피드백 루프:
  Elixir 인프라 구축 중에도 Phase B/C 병행!
  event_lake 데이터 축적은 계속!

Elixir Phase 3 + TS Phase 2:
  팀별 Elixir 전환 완료된 팀부터 .ts 전환!
  스카팀 Elixir 완료 → 스카팀 .ts 시작!
```

---

## 기존 작업과의 충돌 관리!

```
피드백 루프 Phase B (4월 3주!):
  → TS Phase 1-A와 같은 주!
  → event-lake.ts 전환이 Phase B에 도움!
  → 충돌 없음! (보완적!)

experience why 2단계 (4/21!):
  → TS Phase 1-A 시작 주!
  → why 필드 타입 정의가 TS에 포함!
  → 충돌 없음!

다윈 Sprint 5+ (계속!):
  → Elixir Phase 1~2와 병행 가능!
  → 다윈은 독립 프로세스!

비디오팀 Phase 3 (미정!):
  → Elixir Phase 3 이후 권장!
  → 전환 중 추가 팀 작업 최소화!
```

---

## 성공 지표!

```
4월 말 (TS Phase 0+1):
  ✅ tsconfig.json 존재!
  ✅ 핵심 10파일 JSDoc 완료!
  ✅ 핵심 5파일 .ts 전환!
  ✅ Zod 스키마 3개+!
  ✅ CI typecheck green!
  ✅ npx tsc --noEmit 에러 0 (핵심 파일!)

5월 말 (Elixir Phase 1+2):
  ✅ Elixir 동작 중!
  ✅ 스카팀 Supervisor 프로토타입!
  ✅ 크래시 → 복구 < 100ms!
  ✅ EventLake 실시간 수신!
  ✅ MarketRegime 체제 감지!
  ✅ 텔레그램 알림 정상!

6월 말 (Elixir Phase 3):
  ✅ 76 launchd → Elixir Supervisor!
  ✅ 전체 시스템 무중단!
  ✅ 실투자 안전!

7월+ (완전자율):
  ✅ TS strict: true!
  ✅ Elixir 핫코드 리로드!
  ✅ Claude Code 자율 수정 + 배포!
```

---

## 한 페이지 요약!

```
┌─────────────────────────────────────────────────┐
│         팀 제이 완전자율 로드맵!                │
│                                                 │
│  4월: TS 타입 안전 기반! (근육!)               │
│    Phase 0: JSDoc + tsconfig (위험 0!)          │
│    Phase 1: .ts 전환 + Zod (핵심 5파일!)       │
│                                                 │
│  5월: Elixir 프로세스 관리! (두뇌!)            │
│    Phase 1: 프로토타입 + Supervisor!            │
│    Phase 2: EventLake + Diagnostics!            │
│                                                 │
│  6월: 전체 전환!                                │
│    Elixir Phase 3: 76 launchd → Supervisor!    │
│    TS Phase 2: 팀별 .ts 전환!                  │
│                                                 │
│  7월+: 완전자율!                                │
│    TS strict + Elixir 핫코드 + 자율 배포!      │
│                                                 │
│  "Actor Model(1986) = Agent Model(2026)"        │
│  "TypeScript = 코드 안전, Elixir = 프로세스 안전" │
│  "둘이 합쳐져야 완전자율!"                      │
└─────────────────────────────────────────────────┘
```
