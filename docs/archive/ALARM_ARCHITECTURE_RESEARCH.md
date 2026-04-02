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

| 항목 | A안: 전면 교체 | B안: 하이브리드 | C안: 단일 통합 (채택) |
|------|---------------|---------------------|-------------|
| 경로 A (큐) | webhook 교체 | webhook + 폴링 폴백 | OpenClaw 단일 |
| 경로 B (직접) | 유지 (긴급) | 유지 (긴급) | OpenClaw 통합 |
| 경로 C (스크립트) | cron 교체 | cron 점진 전환 | OpenClaw cron |
| mainbot.js | 제거 | 폴백 전환 | 제거 |
| 에이전트 인지 | ✅ | ❌ (직접 경로) | ✅ 전부 인지 |
| 알람 생략 방지 | 프롬프트만 | 해당 없음 | 라이트 모니터링 |
| 장애 대응 | launchd | 폴백 경로 | 닥터+덱스터 |
| 리스크 | 높음 | 낮음 | 중간 (점진적) |
| 지연 | ~100ms | ~100ms (주력) | ~400ms (LLM) |
| PG 부하 | 대폭 감소 | 감소 | 대폭 감소 |

### 3.2 C안 채택 — 단일 경로 통합 (마스터 결정)

**B안이 가진 치명적 문제 (마스터 지적):**
- 경로 B(직접 발송 19곳)를 유지하면 에이전트(제이)가 그 알람의 존재를 모른다
- "루나에서 SELL 났는데 스카 예약은?" 같은 크로스팀 판단 불가능
- 에이전트가 시스템 전체 상황을 파악할 수 없음 → AI 에이전트의 가치 반감

**C안이 해결하는 방법:**

**1. OpenAI OAuth 연동으로 모델 확장**
- OpenClaw이 이미 multi-provider 지원 (Google, Groq, Anthropic, OpenAI)
- OpenAI OAuth로 GPT-5.4 등 추가 모델 사용 가능
- 폴백 체인: OpenAI OAuth(GPT-5.4) → 로컬 MLX(qwen2.5-7b) → Groq → Anthropic

**2. "라이트" 에이전트의 알람 모니터링 임무**
- 봇이 보낸 알람(입력)과 에이전트가 전달한 알람(출력) 비교
- 생략 감지 시 에스컬레이션 (텔레그램 긴급 채널)
- 기록 축적 → RAG → 에이전트 학습 (자기 개선 루프)
- Standing Orders로 "알람 원문 반드시 전달" 규칙 강제

**3. OpenClaw 장애 = 시스템 장애**
- 닥터(scanAndRecover) + 덱스터(heartbeat) 이미 가동
- launchd로 Gateway 자동 재시작
- 별도 폴백 경로 불필요 → 아키텍처 단순화
- 3경로 → 1경로 = 유지보수 비용 1/3

### 3.3 C안 아키텍처 (단일 경로)

```
[최종 목표 아키텍처]

모든 봇 알람 → POST /hooks/agent
  → OpenClaw Gateway
    → 에이전트(제이) 실행
      → Standing Orders: "알람 원문 반드시 전달"
      → 필요시 분석/판단 추가
        → Telegram 발송 (deliver:true, channel:telegram)
    → 라이트: 입력/출력 비교 → 생략 감지 → 에스컬레이션

정기 리포트 → OpenClaw cron
  → 에이전트 실행 → Telegram 발송

제거 대상:
  ✗ mainbot.js (큐 폴링)
  ✗ mainbot_queue 테이블 (폴링 대상)
  ✗ filter.js (에이전트가 판단 대신)
  ✗ telegram-sender.js 직접 호출 19곳 → webhook으로 교체
  ✗ scripts/*.js 의 텔레그램 발송 → cron으로 교체

유지:
  ✓ telegram-sender.js 모듈 자체 (OpenClaw 내부에서 활용 가능)
  ✓ message-envelope.js (봇 간 메시지 포맷)
  ✓ reporting-hub.js (이벤트 정규화 + webhook 발행)
```

### 3.4 핵심 신규 모듈: openclaw-client.js

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

### 3.5 전환 계획 — 3경로 → 1경로

**Phase 1: hooks 활성화 + Standing Orders (즉시)**
```
Step 1: hooks.enabled=true + hooks.token 생성
Step 2: AGENTS.md에 Standing Orders 추가:
        "모든 webhook 알람은 원문 그대로 텔레그램에 전달.
         절대 생략 금지. 판단이 필요한 경우 원문 + 분석을 함께 전달."
Step 3: POST /hooks/agent 테스트 (deliver:true)
```

**Phase 2: 경로 A(큐) → webhook 전환 (1일차)**
```
Step 1: openclaw-client.js 작성
Step 2: reporting-hub.publishToWebhook() 추가
Step 3: investment 팀 먼저 전환
Step 4: 라이트 모니터링 시작 (입력/출력 비교)
```

**Phase 3: 경로 B(직접 발송 19곳) → webhook 전환 (1주차)**
```
Step 1: file-guard sendCritical → postHook 교체
Step 2: guardian, reviewer, builder → postHook 교체
Step 3: video팀 → postHook 교체
Step 4: 라이트 생략 감지 확인 (1주간 0건 목표)
```

**Phase 4: 경로 C(스크립트) → OpenClaw cron (2주차)**
```
Step 1: stability-dashboard → cron 등록
Step 2: weekly-stability-report → cron 등록
Step 3: 나머지 스크립트 순차 전환
Step 4: launchd plist 비활성화
```

**Phase 5: 정리 (1개월차)**
```
Step 1: mainbot.js 비활성화 → mainbot_queue 테이블 아카이브
Step 2: filter.js → Standing Orders로 로직 이전 확인
Step 3: telegram-sender.js 직접 호출 0건 확인
Step 4: 보고서 최종 갱신
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
| OpenClaw Gateway 장애 | 전체 알람 중단 | 닥터+덱스터+launchd 자동 복구 |
| 에이전트 알람 생략 | 마스터가 알람 못 받음 | 라이트 모니터링 + 에스컬레이션 |
| hooks.token 유출 | 외부 알람 주입 | bind:loopback (localhost만) |
| LLM 추론 지연 | ~400ms 추가 | 로컬 MLX(326ms), 수용 가능 |
| Standing Orders 무시 | LLM 특성상 가끔 발생 | 라이트가 감지 → 재발송 |
| OpenAI OAuth 장애 | 외부 모델 사용 불가 | 로컬 MLX + Groq 폴백 |

---

## 6. 실행 로드맵

```
즉시 (10분)
  └→ hooks.enabled=true + hooks.token 생성
  └→ AGENTS.md Standing Orders 추가
  └→ POST /hooks/agent 엔드포인트 테스트

1일차 (2~3시간)
  └→ openclaw-client.js 작성
  └→ reporting-hub.publishToWebhook() 추가
  └→ 라이트 모니터링 로직 설계
  └→ investment 팀 webhook 전환 + 테스트

1주차
  └→ 직접 발송 19곳 → webhook 전환
  └→ 라이트 생략 감지 테스트 (0건 목표)
  └→ 문제 없으면 전체 팀 전환

2주차
  └→ 스크립트 → OpenClaw cron 전환
  └→ launchd plist 비활성화

1개월차
  └→ mainbot.js 비활성화 + mainbot_queue 아카이브
  └→ 3경로 → 1경로 전환 완료 확인
```

---

## 7. 결론

### 채택안: C안 (단일 경로 통합 — 마스터 결정)

**핵심 근거 (마스터 3가지 통찰):**

1. **에이전트가 모든 알람을 인지해야 한다**
   → 직접 발송 경로를 유지하면 에이전트가 시스템 상황을 파악할 수 없음
   → 크로스팀 판단, 연관 분석, 패턴 감지 불가능
   → AI 에이전트의 핵심 가치 반감

2. **라이트 에이전트가 생략을 모니터링한다**
   → 입력(봇 알람) vs 출력(텔레그램 발송) 비교
   → 생략 감지 시 에스컬레이션
   → Standing Orders + 라이트 = 이중 안전장치

3. **OpenClaw 장애 = 시스템 장애다**
   → 닥터, 덱스터, launchd가 이미 복구 체계 구축
   → 별도 폴백 경로 = 불필요한 복잡도
   → 단일 경로 = 유지보수 비용 1/3

**최종 아키텍처:**
```
모든 봇 알람 → POST /hooks/agent
  → OpenClaw Gateway
    → 에이전트(제이) 실행 (Standing Orders 강제)
      → Telegram 발송 (deliver:true)
    → 라이트: 입력/출력 비교 → 생략 감지
  
정기 리포트 → OpenClaw cron → 에이전트 → Telegram

모델 폴백: OpenAI OAuth → 로컬 MLX → Groq → Anthropic
장애 복구: 닥터 + 덱스터 + launchd 자동 재시작
```

**제거 대상:** mainbot.js, mainbot_queue, filter.js, 직접 발송 19곳, 스크립트 발송 7곳
**유지 대상:** telegram-sender.js(모듈), message-envelope.js, reporting-hub.js

---

*끝. 메티 작성, 마스터 승인 완료. C안 채택.*
