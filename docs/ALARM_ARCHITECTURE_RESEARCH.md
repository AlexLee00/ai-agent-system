# 팀 제이 알람 발송 구조 연구 보고서

> 작성일: 2026-04-01 | 분석자: 메티 (Claude Opus 4.6)
> 범위: 코드베이스 38곳 + OpenClaw 공식문서 6영역 + 커뮤니티 10건

---

## 1. 현재 아키텍처 분석

### 1.1 알람 발송 3경로

팀 제이 시스템은 현재 3가지 경로로 알람을 발송하고 있다.

**경로 A — 큐 경유 (주력, 3초 폴링)**
```
봇 → reporting-hub.publishToQueue()
  → INSERT INTO mainbot_queue (PostgreSQL claude 스키마)
    → mainbot.js 폴링 (3초 간격, LIMIT 20)
      → filter.js (무음/야간보류/배치/즉시 분류)
        → telegram-sender.sendBuffered() → Telegram API
```
특징: 중앙 집중식, 필터링+배치+야간보류 지원, 3초 지연

**경로 B — 직접 발송 (긴급/보안, 19곳)**
```
봇 → telegram-sender.send() 또는 sendCritical()
  → Telegram API 직접 호출
```
사용처 (19곳):
- send(): reviewer, builder, write.js, scripts 등 12곳
- sendCritical(): guardian, file-guard, quality-report, video팀 등 7곳

특징: 즉시 발송, 필터링 없음, Rate Limit만 적용

**경로 C — 스크립트 발송 (정기 리포트, 7곳 이상)**
```
launchd/cron → scripts/*.js → telegram-sender.send() → Telegram API
```
사용처:
- weekly-stability-report.js, stability-dashboard.js
- api-usage-report.js, collect-kpi.js, speed-test.js
- run-graduation-analysis.js, weekly-team-report.js

특징: 정기 실행(일/주간), 독립 프로세스, --telegram 플래그

### 1.2 핵심 모듈 계층

```
┌─────────────────────────────────────────┐
│          message-envelope.js            │  봇 간 구조화 메시지
│  11개 타입, 4단계 우선순위, trace_id     │  (122줄)
└─────────────┬───────────────────────────┘
              ↓
┌─────────────────────────────────────────┐
│          reporting-hub.js               │  멀티채널 발행 허브
│  publishToQueue + publishToTelegram     │  (956줄)
│  normalizeEvent + evaluateDeliveryPolicy│
└──────┬──────────────────┬───────────────┘
       ↓                  ↓
┌──────────────┐  ┌───────────────────────┐
│ mainbot_queue│  │   telegram-sender.js  │ 공용 발송
│  (PostgreSQL)│  │   Forum Topic 라우팅   │ (362줄)
└──────┬───────┘  │   배치/Rate Limit/분할 │
       ↓          └───────────────────────┘
┌──────────────┐           ↑
│  mainbot.js  │──filter──→│
│  폴링+발송    │           │
│  (248줄)     │           │
└──────────────┘
```

### 1.3 filter.js 필터링 로직

```
입력: mainbot_queue 행 (from_bot, team, event_type, alert_level, message)
  ↓
1. 무음 체크 — isAlertMuted(from_bot, team) + isEventMuted(from_bot, event_type)
  ↓ 무음이면 → 'muted' (skip)
2. 야간 보류 — shouldDefer(alert_level): MEDIUM 이하 + 야간시간
  ↓ 야간이면 → deferToMorning() → 'deferred'
3. 중복 배치 — alert_level ≤ 2이면 1분 윈도우 집약
  ↓ 중복이면 → 'batched'
4. 즉시 발송 — alert_level ≥ 3 (HIGH/CRITICAL)
  ↓ → onSend(message) → 'sent'
```

---

## 2. 커뮤니티 연구 — 폴링 vs Webhook 최신 패턴

### 2.1 업계 합의 (2025~2026)

커뮤니티 서칭 결과, DB 폴링 → Webhook 전환은 업계 표준 흐름이다.

**폴링의 문제점 (현재 팀 제이)**
- 3초 간격 폴링 = 1,200회/시간 빈 쿼리 발생
- 최대 3초 지연 (평균 1.5초)
- mainbot.js 프로세스 상시 가동 필요

**Webhook의 이점**
- 이벤트 발생 즉시 전달 (밀리초 단위)
- 빈 폴링 쿼리 0건 (PostgreSQL 부하 감소)
- 프로세스 상시 가동 불필요 (OpenClaw Gateway가 대신)

**하이브리드 패턴 (Best Practice)**
업계 권장: "Webhook을 주력으로, 폴링을 안전망으로"
- Webhook 실패 시 DB에 남아있는 이벤트를 폴링으로 보완
- 이중 발송 방지: idempotency key (message_id)
- 최종 일관성 보장

### 2.2 OpenClaw 커뮤니티 적용 사례

OpenClaw 생태계에서 발견된 패턴:

1. **Hookdeck 연동** — webhook 릴레이 서비스로 재시도+중복제거+관측성 추가
2. **Fast.io 연동** — 파일 이벤트 → /hooks/agent → 에이전트 자동 실행
3. **LumaDock 가이드** — skill(API 호출) + plugin(런타임) + webhook(외부 트리거) 3중 구조
4. **내부 hooks vs HTTP webhooks 구분** — 로컬 이벤트는 hooks, 외부 연동은 webhooks

### 2.3 핵심 설계 원칙

커뮤니티에서 반복 강조되는 원칙:

```
1. 즉시 응답 (200 OK) → 비동기 처리 (큐잉)
2. 멱등성 (idempotency) — 같은 이벤트 재처리해도 안전
3. 재시도 + 지수 백오프 — 실패 시 1s → 2s → 4s → ...
4. 서명 검증 — hooks.token으로 인증
5. 관측성 — 발송 로그, 실패 추적, 대시보드
```

---

## 3. 통합/병행 전략 설계

### 3.1 안 비교

| 항목 | A안: 전면 교체 | B안: 하이브리드 (권장) | C안: 현행 유지 |
|------|---------------|---------------------|-------------|
| 경로 A (큐) | webhook으로 교체 | webhook 주력 + 폴링 폴백 | 유지 |
| 경로 B (직접) | 유지 (긴급 경로) | 유지 (긴급 경로) | 유지 |
| 경로 C (스크립트) | cron으로 교체 | cron 점진 전환 | 유지 |
| mainbot.js | 제거 | 폴백 모드 전환 | 유지 |
| 리스크 | 높음 (빅뱅) | 낮음 (점진적) | 없음 |
| 지연 | ~100ms | ~100ms (주력) | ~1.5s (평균) |
| PG 부하 | 대폭 감소 | 감소 | 현행 |

**B안 (하이브리드) 권장 이유:**
1. 점진적 전환 — 한 팀씩 webhook으로 이동
2. 폴백 안전망 — webhook 실패 시 기존 큐 폴링 유지
3. 기존 filter.js 로직 보존 — 무음/야간보류/배치 계속 동작
4. 경로 B(긴급) 무변경 — 보안/긴급 알람은 현행 유지

### 3.2 B안 아키텍처 (하이브리드)

```
[Phase 1: webhook 추가 — 기존과 병행]

봇 → openclaw-client.postHook()
  → POST /hooks/agent (deliver:true, channel:telegram)
    → OpenClaw Gateway → 에이전트 실행 → Telegram 발송
  
  실패 시 폴백:
  → reporting-hub.publishToQueue() → mainbot_queue
    → mainbot.js 폴링 → filter.js → Telegram 발송

[Phase 2: 폴링 빈도 감소]
  mainbot.js 폴링 간격: 3초 → 30초 (안전망 전용)

[Phase 3: 폴링 제거 (선택)]
  webhook 안정 확인 후 mainbot.js 큐 폴링 비활성화
  ※ filter.js 로직은 hooks transform으로 이전
```

### 3.3 핵심 신규 모듈: openclaw-client.js

```javascript
// packages/core/lib/openclaw-client.js — OpenClaw webhook 클라이언트
const HOOK_URL = 'http://127.0.0.1:18789/hooks/agent';
const HOOK_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN; // secrets-store 경유

async function postHook({ message, name, channel = 'telegram', to, agentId }) {
  try {
    const res = await fetch(HOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HOOK_TOKEN}`,
      },
      body: JSON.stringify({
        message,
        name,
        agentId: agentId || 'main',
        deliver: true,
        channel,
        to,                    // 텔레그램 topic_id
        wakeMode: 'now',
        timeoutSeconds: 30,
      }),
    });
    return res.ok;
  } catch (e) {
    console.warn('[openclaw-client] webhook 실패, 폴백 필요:', e.message);
    return false;
  }
}
```

### 3.4 경로별 전환 계획

**경로 A (큐 → webhook) — 단계적 전환**
```
Step 1: openclaw-client.js 작성 (packages/core/lib/)
Step 2: reporting-hub.js에 webhook 채널 추가
        publishToWebhook() → openclaw-client.postHook()
        실패 시 publishToQueue() 폴백
Step 3: investment 팀 먼저 전환 (mainbot-client.js 수정)
Step 4: 1주일 모니터링 → 나머지 팀 전환
Step 5: mainbot.js 폴링 간격 3초 → 30초
Step 6: 안정 확인 후 폴링 비활성화 (선택)
```

**경로 B (직접 발송) — 변경 없음**
```
현행 유지: sender.send() / sendCritical() 19곳
이유: 보안 알람(file-guard), 긴급 알람은 최단 경로 필수
     OpenClaw 장애 시에도 독립 동작해야 함
```

**경로 C (스크립트 → OpenClaw cron) — 점진적 전환**
```
Step 1: OpenClaw cron으로 일일 리포트 1건 등록
        openclaw cron add --name "Daily stability"
          --cron "0 8 * * *" --tz Asia/Seoul
          --session isolated --announce --channel telegram
Step 2: 2주 모니터링 → 나머지 스크립트 전환
Step 3: launchd plist 비활성화 (삭제 아님)
```

---

## 4. 전제 조건 — hooks 활성화

현재 OpenClaw에서 hooks가 비활성 상태이므로 먼저 활성화 필요:

```json
// ~/.openclaw/openclaw.json에 추가
{
  "hooks": {
    "enabled": true,
    "token": "별도_생성_필요_64자_hex",
    "path": "/hooks",
    "defaultSessionKey": "hook:ingress",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:"],
    "allowedAgentIds": ["main"]
  }
}
```

⚠️ **hooks.token ≠ gateway.auth.token** — 반드시 별도 토큰 생성!

---

## 5. 리스크 분석

| 리스크 | 영향 | 대응 |
|--------|------|------|
| OpenClaw Gateway 장애 | webhook 전달 불가 | 폴백: publishToQueue() 유지 |
| hooks.token 유출 | 외부에서 알람 주입 가능 | bind:loopback (localhost만) |
| 텔레그램 Rate Limit | 대량 알람 시 429 | 기존 배치+throttle 유지 |
| filter.js 로직 미적용 | 무음/야간보류 미동작 | Phase 1에서는 큐 폴백으로 보존 |
| 이중 발송 | 동일 알람 2회 수신 | message_id 기반 중복제거 |

---

## 6. 실행 로드맵

```
즉시 (10분)
  └→ hooks.enabled=true + hooks.token 생성 + secrets-store 저장
  └→ POST /hooks/wake + /hooks/agent 엔드포인트 테스트

1일차 (2~3시간)
  └→ openclaw-client.js 작성 (packages/core/lib/)
  └→ reporting-hub.js에 publishToWebhook() 추가 (폴백 포함)
  └→ investment 팀 webhook 전환 + 테스트

1주차 모니터링
  └→ webhook 성공률, 지연시간, 폴백 발동 횟수 추적
  └→ 문제 없으면 claude/reservation/worker 팀 전환

2주차
  └→ mainbot.js 폴링 간격 3초 → 30초
  └→ OpenClaw cron으로 일일 리포트 1건 등록

1개월차
  └→ 전체 팀 webhook 전환 완료
  └→ 스크립트 → cron 전환 (점진적)
  └→ mainbot.js 폴링 비활성화 여부 결정
```

---

## 7. 결론

### 권장안: B안 (하이브리드 — Webhook 주력 + 폴링 안전망)

**이유:**
1. **업계 표준** — 폴링→Webhook은 검증된 마이그레이션 경로
2. **점진적 전환** — 한 팀씩 이동하여 리스크 최소화
3. **기존 자산 보존** — filter.js, 야간보류, 배치 로직 계속 활용
4. **OpenClaw 시너지** — hooks/cron/multi-agent 자연스럽게 확장
5. **PG 부하 감소** — 1,200회/시간 빈 쿼리 제거
6. **지연 개선** — 평균 1.5초 → ~100ms

**변경하지 않는 것:**
- 경로 B (직접 발송 19곳) — 보안/긴급 경로 보존
- telegram-sender.js — 최종 발송 모듈 공용 유지
- message-envelope.js — 봇 간 메시지 포맷 유지

**최종 목표 아키텍처:**
```
봇 → reporting-hub → openclaw-client → POST /hooks/agent
                                          ↓
                                    OpenClaw Gateway
                                     ↓          ↓
                              에이전트 실행   Telegram 발송
                              (filter 로직)   (deliver:true)

긴급 경로 (변경 없음):
봇 → telegram-sender.sendCritical() → Telegram API 직접

정기 리포트:
OpenClaw cron → 에이전트 실행 → Telegram 발송
```

---

*끝. 메티 작성, 마스터 승인 대기.*
