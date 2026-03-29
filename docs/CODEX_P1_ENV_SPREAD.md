# Codex 프롬프트 P1: env.js 적용 확산 (ops/dev 분기 + 경로 통합 개선)

> 목적: 맥 스튜디오(운영)와 맥북 에어(개발)의 리소스 차이를 env.js 에서
>        체계적으로 관리하도록, process.env 직접 참조를 env.js 로 통합한다.
> 기준 커밋: a081fcb (env.js 생성 완료)
> 대상 머신: 맥 스튜디오 M4 Max (alexlee)

---

## 핵심 배경 — 두 머신의 차이

맥 스튜디오(OPS)와 맥북 에어(DEV)는 사용자명이 동일(alexlee)하지만
다음 리소스의 존재/접근 방식이 완전히 다르다:

| 리소스 | 맥 스튜디오 (OPS) | 맥북 에어 (DEV) |
|--------|-------------------|-----------------|
| n8n | localhost:5678 로컬 실행 | 없음 (SSH 터널 불필요) |
| PostgreSQL | localhost:5432 로컬 서버 | SSH 터널 → 맥 스튜디오 5432 |
| launchd 서비스 | ai.ska.commander 등 전체 가동 | 없음 |
| OpenClaw | 포트 18789 로컬 실행 | 없음 |
| ~/.openclaw | 실서비스 상태 파일 있음 | 로컬 개발용 (상태파일 없음) |
| PAPER_MODE | false (실투자) | true (페이퍼) |

→ env.js 에서 IS_OPS 와 함께 이 차이를 명시적으로 관리해야 한다.

---

## 작업 1: packages/core/lib/env.js 에 서비스 접근 설정 추가

기존 env.js 파일의 module.exports 직전에 다음 섹션을 추가한다.

```javascript
// ─── 서비스 접근 주소 ─────────────────────────────────────────────────────

/**
 * n8n 베이스 URL
 * OPS: localhost:5678 (맥 스튜디오 로컬)
 * DEV: 환경변수로 오버라이드 가능 (기본: localhost:5678 이지만 실제 없음)
 *      DEV에서 n8n이 필요하면 SSH 터널 후 N8N_BASE_URL 환경변수로 지정
 */
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://127.0.0.1:5678';

/**
 * n8n 사용 가능 여부
 * OPS: true (로컬 설치됨)
 * DEV: false (미설치) — N8N_ENABLED=true 로 강제 활성화 가능
 */
const N8N_ENABLED = IS_OPS
  ? (process.env.N8N_ENABLED !== 'false')
  : (process.env.N8N_ENABLED === 'true');

/**
 * PostgreSQL 호스트
 * OPS: localhost (직접 접근)
 * DEV: localhost (SSH 터널 후 포트포워딩: ssh -L 5432:localhost:5432 mac-studio)
 * 두 환경 모두 localhost:5432 로 동일하나,
 * DEV는 SSH 터널이 사전에 맺어져 있어야 한다.
 */
const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = parseInt(process.env.PG_PORT || '5432', 10);

/**
 * launchd 사용 가능 여부
 * OPS: true (맥 스튜디오에서 서비스 등록됨)
 * DEV: false (맥북 에어에서 서비스 미등록)
 */
const LAUNCHD_AVAILABLE = IS_OPS
  ? (process.env.LAUNCHD_AVAILABLE !== 'false')
  : (process.env.LAUNCHD_AVAILABLE === 'true');

/**
 * OpenClaw 포트
 * OPS: 18789 (로컬 실행)
 * DEV: -1 (미실행, 체크 스킵)
 */
const OPENCLAW_PORT = IS_OPS
  ? parseInt(process.env.OPENCLAW_PORT || '18789', 10)
  : -1;

/**
 * OpenClaw 워크스페이스 디렉토리
 * 두 머신 모두 ~/.openclaw/workspace 로 동일
 * (계정명 alexlee 통일 전제)
 */
const OPENCLAW_WORKSPACE = process.env.OPENCLAW_WORKSPACE ||
  path.join(os.homedir(), '.openclaw', 'workspace');

/**
 * OpenClaw 로그 디렉토리
 */
const OPENCLAW_LOGS = process.env.OPENCLAW_LOGS ||
  path.join(os.homedir(), '.openclaw', 'logs');
```

그리고 module.exports 에 추가:
```javascript
  // 서비스 접근
  N8N_BASE_URL,
  N8N_ENABLED,
  PG_HOST,
  PG_PORT,
  LAUNCHD_AVAILABLE,
  OPENCLAW_PORT,
  OPENCLAW_WORKSPACE,
  OPENCLAW_LOGS,
```

---

## 작업 2: process.env.MODE / process.env.PAPER_MODE 직접 참조 교체

대상 파일 13개 (process.env.MODE / process.env.PAPER_MODE 직접 읽는 파일):

```
bots/investment/shared/secrets.js
bots/reservation/auto/monitors/naver-monitor.js
bots/reservation/auto/scheduled/pickko-daily-audit.js
bots/reservation/lib/manual-cancellation.js
bots/reservation/lib/manual-reservation.js
bots/reservation/manual/admin/pickko-ticket.js
bots/reservation/manual/admin/pickko-verify.js
bots/reservation/manual/reports/pickko-pay-pending.js
bots/reservation/manual/reservation/pickko-accurate.js
bots/reservation/manual/reservation/pickko-cancel-cmd.js
bots/reservation/manual/reservation/pickko-cancel.js
bots/reservation/manual/reservation/pickko-register.js
bots/reservation/scripts/e2e-test.js
```

수정 패턴:
```javascript
// 변경 전
if (process.env.MODE === 'ops') { ... }
if (process.env.PAPER_MODE === 'true') { ... }

// 변경 후 (파일 상단 임포트 추가)
const { IS_OPS, IS_DEV, PAPER_MODE } = require('../../../packages/core/lib/env');
if (IS_OPS) { ... }
if (PAPER_MODE) { ... }
```

상대 경로 기준:
- bots/investment/shared/      → ../../../packages/core/lib/env
- bots/reservation/auto/monitors/ → ../../../../packages/core/lib/env
- bots/reservation/auto/scheduled/ → ../../../../packages/core/lib/env
- bots/reservation/lib/        → ../../../packages/core/lib/env
- bots/reservation/manual/admin/ → ../../../../packages/core/lib/env
- bots/reservation/manual/reports/ → ../../../../packages/core/lib/env
- bots/reservation/manual/reservation/ → ../../../../packages/core/lib/env
- bots/reservation/scripts/    → ../../../packages/core/lib/env

---

## 작업 3: n8n 접근 코드에 N8N_ENABLED 가드 추가

n8n 을 직접 호출하는 핵심 모듈에만 적용 (전체 파일 수정 불필요):

### packages/core/lib/n8n-webhook-registry.js

resolveProductionWebhookUrl 함수 맨 앞에 가드 추가:
```javascript
const { N8N_ENABLED, N8N_BASE_URL: DEFAULT_N8N_BASE } = require('./env');

async function resolveProductionWebhookUrl({ ... } = {}) {
  // DEV 환경에서 n8n 미설치 시 null 반환 → 호출부가 fallback 처리
  if (!N8N_ENABLED) return null;
  // ... 기존 코드
}
```

### packages/core/lib/n8n-runner.js (있는 경우)

runWebhook / triggerWebhook 함수 맨 앞에:
```javascript
const { N8N_ENABLED } = require('./env');
// ...
if (!N8N_ENABLED) {
  console.log('[n8n-runner] DEV 환경 — n8n 미설치, 스킵');
  return { ok: false, skipped: true, reason: 'n8n_not_available_in_dev' };
}
```

---

## 작업 4: launchd 체크 코드에 LAUNCHD_AVAILABLE 가드 추가

bots/claude/lib/checks/bots.js, team-leads.js 등 launchctl 호출부에:

```javascript
const { LAUNCHD_AVAILABLE } = require('../../../../packages/core/lib/env');

// launchctl 호출 전
if (!LAUNCHD_AVAILABLE) {
  return { ok: true, items: [], note: 'DEV 환경 — launchd 서비스 미등록' };
}
// ... 기존 launchctl 코드
```

---

## 완료 기준

```bash
# 1. process.env.MODE / PAPER_MODE 직접 참조 0건
grep -rn "process\.env\.MODE\b\|process\.env\.PAPER_MODE\b" bots/ \
  --include="*.js" | grep -v node_modules | grep -v mode\.js

# 2. env.js 로드 및 기본값 확인
node -e "
const env = require('./packages/core/lib/env');
console.log('IS_OPS:', env.IS_OPS);
console.log('N8N_ENABLED:', env.N8N_ENABLED);
console.log('LAUNCHD_AVAILABLE:', env.LAUNCHD_AVAILABLE);
console.log('OPENCLAW_PORT:', env.OPENCLAW_PORT);
console.log('N8N_BASE_URL:', env.N8N_BASE_URL);
"

# 3. 문법 검사
find bots/investment/shared bots/reservation -name "*.js" \
  -not -path "*/node_modules/*" | xargs -I{} node --check {}
```

---

## 커밋 메시지

```
refactor(env): 맥 스튜디오↔맥북 에어 리소스 차이 env.js 통합 관리

- env.js: N8N_ENABLED / LAUNCHD_AVAILABLE / OPENCLAW_PORT /
          PG_HOST / OPENCLAW_WORKSPACE / OPENCLAW_LOGS 추가
  OPS(맥 스튜디오): n8n·launchd·openclaw 활성
  DEV(맥북 에어):   n8n·launchd·openclaw 비활성, SSH 터널로 DB 접근

- process.env.MODE/PAPER_MODE 직접 참조 13개 파일 → env.js 교체
- n8n-webhook-registry, n8n-runner: N8N_ENABLED 가드 추가
- claude/checks/bots, team-leads: LAUNCHD_AVAILABLE 가드 추가
```
