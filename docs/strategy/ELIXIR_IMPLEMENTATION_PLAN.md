# Elixir/OTP 구현 계획!

> 작성: 메티 (Claude Opus 4.6) + 마스터 직접 검토!
> 작성일: 2026-04-07
> 전제: ELIXIR_OTP_DESIGN.md 설계 완료!
> 현재 상태: Elixir 미설치 / launchd 76개 / TS Phase 0 진행 중!

---

## 현재 인프라 현황

```
OPS (Mac Studio M4 Max):
  Elixir: ❌ 미설치!
  launchd plist: 76개! (에이전트 프로세스!)
  PostgreSQL: 동작 중 (jay DB!)
  Node.js: v25 (모노레포!)

TS Phase 0: 진행 중 (JSDoc + tsconfig!)
```

---

## 구현 로드맵 — 4 Phase!

```
Phase 0: TS JSDoc + tsconfig ← 지금! (1주!)
Phase 1: Elixir 환경 + 프로토타입 (2주!)
Phase 2: 핵심 인프라 전환 (2주!)
Phase 3: 팀별 순차 전환 (4주!)
Phase 4: 완전자율 (장기!)
```

---

## Phase 1: Elixir 환경 + 프로토타입 (2주!)

### Week 1: 환경 구축 + Hello World!

```
Day 1-2: Elixir 설치 + 프로젝트 생성!
  [ ] brew install elixir (OPS!)
  [ ] elixir --version 확인!
  [ ] mix new team_jay --sup (Supervisor 포함!)
  [ ] mix deps.get
  [ ] 디렉토리: /Users/alexlee/projects/team-jay-elixir/

Day 3-4: PostgreSQL 연결!
  [ ] mix.exs에 {:ecto_sql, "~> 3.0"} + {:postgrex, ">= 0.0.0"} 추가!
  [ ] config/config.exs에 jay DB 연결!
  [ ] TeamJay.Repo 생성!
  [ ] mix ecto.create (기존 jay DB 사용!)
  [ ] agent_events 테이블 Ecto 스키마!
  [ ] SELECT * FROM agent_events LIMIT 5 확인!

Day 5: pg LISTEN/NOTIFY 수신!
  [ ] Postgrex.Notifications 모듈!
  [ ] agent_events INSERT 트리거 생성!
  [ ] Elixir에서 실시간 이벤트 수신 확인!
  [ ] 수신 시 콘솔 로그!
```

### Week 2: 스카팀 Supervisor 프로토타입!

```
Day 6-7: TeamSupervisor 구현!
  [ ] TeamJay.Application (최상위!)
  [ ] TeamJay.TeamSupervisor.Ska (스카팀!)
  [ ] strategy: :one_for_one!
  [ ] max_restarts: 5, max_seconds: 60!

Day 8-9: 에이전트 GenServer 구현!
  [ ] TeamJay.Agent.Andy GenServer!
    상태: %{name, team, status, last_check, pid}
    handle_info(:health_check) → Hub HTTP 호출!
    크래시 시뮬레이션 → Supervisor 자동 재시작!
  [ ] TeamJay.Agent.Jimmy GenServer!
    동일 패턴!

Day 10: Hub HTTP 브릿지!
  [ ] {:req, "~> 0.5"} HTTP 클라이언트!
  [ ] TeamJay.HubClient 모듈!
    hub_url = "http://REDACTED_TAILSCALE_IP:7788"
    headers = [{"Authorization", "Bearer #{token}"}]
  [ ] GET /hub/health 호출!
  [ ] POST /hub/pg/query 호출!
  [ ] 텔레그램 알림 (Hub 경유!)

Phase 1 검증:
  [ ] Supervisor가 에이전트 GenServer 관리!
  [ ] 에이전트 크래시 → 밀리초 자동 재시작!
  [ ] pg LISTEN/NOTIFY 이벤트 실시간 수신!
  [ ] Hub API HTTP 호출 성공!
  [ ] 기존 Node.js 시스템 영향 없음! (병렬!)
```

---

## Phase 2: 핵심 인프라 전환 (2주!)

### Week 3: 이벤트 + 체제 감지!

```
Day 11-12: TeamJay.EventLake GenServer!
  [ ] pg LISTEN/NOTIFY → 실시간 이벤트 수신!
  [ ] 이벤트 메모리 캐시 (최근 1000건!)
  [ ] 이벤트 통계 (팀별/타입별 카운트!)
  [ ] Ecto로 event_lake 테이블 직접 조회!
  [ ] Node.js event-lake.js와 동일 테이블 공유!

Day 13-14: TeamJay.MarketRegime GenServer!
  [ ] market-regime.js 로직 Elixir 포팅!
  [ ] detectRegime/1 → 4가지 체제!
  [ ] 시장 체제 상태 메모리 관리!
  [ ] 체제 변경 시 이벤트 발행!
```

### Week 4: 진단 + 텔레그램!

```
Day 15-16: TeamJay.Diagnostics!
  [ ] :observer 연동!
  [ ] 프로세스 메모리/메시지큐 모니터링!
  [ ] 이상 감지 규칙 (메시지큐 > 100 = 경고!)
  [ ] Beamlens 패턴: 진단 결과 → 텔레그램!

Day 17-18: 텔레그램 연동!
  [ ] {:nadia, "~> 0.7"} 또는 {:telegraf, "~> 0.1"}!
  [ ] 기존 봇 토큰 사용!
  [ ] 팀별 토픽 메시지 발송!
  [ ] 인라인 키보드 (마스터 승인 버튼!)

Day 19-20: Phase 2 통합 테스트!
  [ ] Elixir Supervisor → Hub HTTP → Node.js 에이전트!
  [ ] pg LISTEN/NOTIFY → EventLake → 실시간 이벤트!
  [ ] MarketRegime → 체제 감지 → 텔레그램 알림!
  [ ] Diagnostics → 프로세스 모니터링!

Phase 2 검증:
  [ ] Elixir가 Node.js 에이전트를 "감시"!
  [ ] 이벤트 실시간 수신 + 통계!
  [ ] 시장 체제 감지 동작!
  [ ] 텔레그램 알림 정상!
  [ ] 기존 시스템 무중단!
```

---

## Phase 3: 팀별 순차 전환 (4주!)

### 전환 순서 (리스크 순!)

```
Week 5: 스카팀 (가장 단순!)
  [ ] TeamSupervisor.Ska 본격 운영!
  [ ] 앤디/지미/스카 GenServer → launchd 대체!
  [ ] 기존 launchd plist 비활성화!
  [ ] 1주 병렬 운영 (Elixir + launchd 동시!)
  [ ] 안정 확인 → launchd 제거!

Week 6: 클로드팀 (감시/복구!)
  [ ] TeamSupervisor.Claude!
  [ ] 덱스터/독터/아처/클로드 GenServer!
  [ ] Beamlens 진단 → 덱스터 대체 시작!
  [ ] Supervisor 자동 복구 → 독터 보완!

Week 7: 루나팀 (매매! 신중!)
  [ ] TeamSupervisor.Luna!
  [ ] 14개 에이전트 GenServer!
  [ ] MarketRegime GenServer 본격 운영!
  [ ] HiringManager GenServer!
  [ ] ⚠️ 실투자 → 2주 Shadow 운영!

Week 8: 나머지 팀!
  [ ] 블로/워커/에디/다윈/시그마!
  [ ] 각 팀 1~2일 전환!
  [ ] 전체 launchd → Elixir Supervisor!

Phase 3 검증:
  [ ] 전체 76 launchd → Elixir Supervisor!
  [ ] 프로세스 크래시 → 밀리초 복구!
  [ ] 기존 기능 100% 동작!
  [ ] 텔레그램 알림 정상!
  [ ] 실투자 안전!
```

---

## Phase 4: 완전자율 (장기!)

```
[ ] 핫코드 리로드!
    Claude Code → 코드 수정 → Elixir 핫리로드!
    프로세스 재시작 없이 에이전트 업데이트!

[ ] 자율 코드 진화!
    TS 컴파일 검증 → Elixir 핫리로드 → 자동 배포!
    Claude Code가 코드 수정 시:
      1. TypeScript tsc --noEmit 통과!
      2. Elixir 핫코드 리로드!
      3. 마스터 승인 후 프로덕션!

[ ] 분산 노드!
    DEV ↔ OPS 노드 간 투명 통신!
    DEV에서 개발 → OPS에 핫코드 리로드!
```

---

## 의존성 관계!

```
TS Phase 0 (JSDoc!) ─────────────────┐
  ↓                                   │
TS Phase 1 (핵심 TS + Zod!) ────────┐│
  ↓                                  ││
Elixir Phase 1 (환경 + 프로토타입!) ←┘│
  ↓                                   │
Elixir Phase 2 (핵심 인프라!) ←───────┘
  ↓                    TS 타입 정의 공유!
Elixir Phase 3 (팀별 전환!)
  ↓
Elixir Phase 4 (완전자율!)
  ↓
TS Phase 3 (strict!) ← Elixir 안정화 후!
```

---

## 리스크 관리!

```
리스크 1: 전환 중 운영 중단!
  대응: 병렬 운영! Elixir + launchd 동시 실행!
  → Elixir 안정 확인 후에만 launchd 비활성화!
  → 롤백: launchctl load로 즉시 복원!

리스크 2: 루나팀 실투자 안전!
  대응: 2주 Shadow 운영!
  → Elixir는 감시만, 실행은 기존 Node.js!
  → 불일치 발견 시 즉시 중단!
  → TP/SL은 거래소에 설정 → 프로세스 무관!

리스크 3: Elixir 학습 곡선!
  대응: Claude Code가 Elixir 80.3% 정확도!
  → 코드 대부분 Claude Code로 생성!
  → Jido/Sagents 패턴 참조!
  → 마스터 학습 부담 최소!

리스크 4: Node.js ↔ Elixir 통신 장애!
  대응: PostgreSQL 공유 + Hub HTTP 이중 경로!
  → pg LISTEN/NOTIFY 실패 → Hub HTTP 폴백!
  → 양쪽 모두 실패 → 기존 launchd 유지!

리스크 5: 76개 launchd 한번에 전환 불가!
  대응: 팀 단위 순차 전환! (4주!)
  → 스카(가장 단순) → 클로드 → 루나(가장 신중!)
  → 각 팀 1주 관찰 후 다음 팀!
```

---

## 성공 기준!

```
Phase 1 (프로토타입):
  ✅ Elixir Supervisor가 GenServer 자동 재시작!
  ✅ 크래시 → 복구 시간 < 100ms!
  ✅ pg LISTEN/NOTIFY 이벤트 수신!
  ✅ Hub API HTTP 호출 성공!

Phase 2 (핵심 인프라):
  ✅ EventLake 실시간 이벤트 수신!
  ✅ MarketRegime 체제 감지 동작!
  ✅ 텔레그램 알림 정상!
  ✅ 기존 Node.js 무중단!

Phase 3 (팀별 전환):
  ✅ 전체 76 launchd → Elixir Supervisor!
  ✅ 프로세스 크래시 복구 < 100ms!
  ✅ 기존 기능 100% 동작!
  ✅ 실투자 안전! (TP/SL 정상!)
  ✅ 텔레그램 알림 정상!

Phase 4 (완전자율):
  ✅ 핫코드 리로드 동작!
  ✅ Claude Code 자율 수정 + 배포!
  ✅ 마스터 개입 → 보고만!
```

---

## 비용 분석!

```
Elixir/OTP 도입 비용: $0!
  Elixir: 무료 오픈소스!
  Erlang/OTP: 무료!
  Hex 패키지: 무료!
  추가 하드웨어: 불필요! (기존 Mac Studio!)
  추가 LLM 비용: 불필요! (Elixir = 규칙 기반!)

개발 비용:
  Claude Code: 기존 구독 내!
  마스터 시간: Phase별 검토/승인!

절감 효과:
  launchd 관리 복잡도 감소!
  덱스터+독터 복구 시간: 수분 → 밀리초!
  운영 모니터링 부담 감소!
  자율 복구 → 야간/주말 개입 감소!
```

---

## TS Phase 0과의 구체적 연결!

```
1. message-envelope.ts @typedef → Elixir defstruct!
   TS:
     @typedef {Object} MessageEnvelope
     @property {string} message_type
     @property {string} from
     @property {string} to
     @property {Object} payload

   Elixir:
     defmodule TeamJay.MessageEnvelope do
       defstruct [:message_type, :from, :to, :payload]
     end

   → JSON 직렬화/역직렬화로 양방향 호환!

2. event-lake.js @typedef → Ecto Schema!
   TS:
     @typedef {Object} EventRecord
     @property {string} eventType
     @property {string} team
     @property {string} agent

   Elixir:
     defmodule TeamJay.EventRecord do
       use Ecto.Schema
       schema "event_lake" do
         field :event_type, :string
         field :team, :string
         field :agent, :string
       end
     end

   → 동일 PostgreSQL 테이블 공유!

3. Zod (Phase 1) → Ecto.Changeset!
   TS (Zod):
     const EventSchema = z.object({
       eventType: z.string(),
       team: z.string().optional(),
     });

   Elixir (Changeset):
     def changeset(event, attrs) do
       event
       |> cast(attrs, [:event_type, :team])
       |> validate_required([:event_type])
     end

   → 양쪽 런타임 검증 동일 규칙!
```

---

## 타임라인 요약!

```
2026-04-07: TS Phase 0 코덱스 전달! ← 오늘!
2026-04-14: TS Phase 0 완료 (예상!)
2026-04-14: Elixir Phase 1 시작!
2026-04-28: Elixir Phase 1 완료! (프로토타입!)
2026-04-28: Elixir Phase 2 시작!
2026-05-12: Elixir Phase 2 완료! (핵심 인프라!)
2026-05-12: Elixir Phase 3 시작!
2026-06-09: Elixir Phase 3 완료! (전체 전환!)
2026-06+:   Elixir Phase 4! (완전자율!)
```
