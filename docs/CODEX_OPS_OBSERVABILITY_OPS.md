# CODEX_OPS_OBSERVABILITY_OPS — OPS 에러 수집 + 닥터 능동화

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥 스튜디오 (OPS)** — 운영 전용 코드, OPS에서 구현+검증
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)
> OPS 설정 절차: 마스터 승인 후 코덱스가 OPS에서 직접 구현

---

## 배경

OPS에서만 존재하는 리소스를 다루는 작업:
- `/tmp/*.err.log` — OPS에만 16개 에러 로그 파일 존재
- 덱스터 — OPS launchd로 실행 중
- 닥터 — OPS 서비스만 재시작 가능

이 작업들은 DEV에서 구현해도 테스트 불가 → OPS에서 직접 구현+검증.

닥터(doctor.js)는 현재 **운영에서 한 번도 실행된 적 없음** (이력 5건 전부 테스트).
원인: 클로드(팀장)가 agent_tasks에 복구 지시를 넣지 않아서 pollDoctorTasks()가 항상 빈 루프.
→ 닥터를 **수동적 → 능동적**으로 전환.

---

## 작업 1: Hub 에러 엔드포인트 추가

OPS Hub 서버에서 실행됨. `/tmp/*.err.log`를 읽어서 API로 제공.

### 새 파일: `bots/hub/lib/routes/errors.js`

```javascript
'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = '/tmp';
const ERR_SUFFIX = '.err.log';

/**
 * GET /hub/errors/recent?minutes=60&service=crypto
 * /tmp/*.err.log 파일을 읽어서 서비스별 에러 집계
 */
async function errorsRecentRoute(req, res) {
  const minutes = parseInt(req.query.minutes || '60', 10);
  const serviceFilter = req.query.service || null;

  const files = fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith(ERR_SUFFIX))
    .filter(f => !serviceFilter || f.includes(serviceFilter));

  const results = [];
  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;

      const service = file.replace(ERR_SUFFIX, '');
      results.push({
        service,
        file: filePath,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        error_count: lines.length,
        recent_errors: lines.slice(-5),  // 최근 5줄
      });
    } catch { /* 읽기 실패 무시 */ }
  }

  return res.json({
    ok: true,
    minutes,
    service_filter: serviceFilter,
    total_services: results.length,
    total_errors: results.reduce((sum, r) => sum + r.error_count, 0),
    services: results.sort((a, b) => b.error_count - a.error_count),
  });
}

/**
 * GET /hub/errors/summary — 전체 서비스 에러 현황 요약
 */
async function errorsSummaryRoute(req, res) {
  const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(ERR_SUFFIX));
  const summary = [];
  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      summary.push({
        service: file.replace(ERR_SUFFIX, ''),
        size_bytes: stat.size,
        has_errors: stat.size > 0,
        modified_at: stat.mtime.toISOString(),
      });
    } catch { /* 무시 */ }
  }
  return res.json({
    ok: true,
    total: summary.length,
    with_errors: summary.filter(s => s.has_errors).length,
    clean: summary.filter(s => !s.has_errors).length,
    services: summary.sort((a, b) => b.size_bytes - a.size_bytes),
  });
}

module.exports = { errorsRecentRoute, errorsSummaryRoute };
```

### hub.js 수정 — 에러 라우트 등록

`app.get('/hub/secrets/:category', ...)` 라인 이후에 추가:

```javascript
const { errorsRecentRoute, errorsSummaryRoute } = require('./lib/routes/errors');
app.get('/hub/errors/recent', generalLimiter, errorsRecentRoute);
app.get('/hub/errors/summary', generalLimiter, errorsSummaryRoute);
```

인증: `/hub` 하위이므로 기존 `authMiddleware` 자동 적용됨.
hub.js를 읽고 기존 라우트 등록 패턴을 따를 것.

---

## 작업 2: 덱스터 [23] 에러 로그 체크 모듈

OPS 덱스터 봇에서 실행됨. Hub 에러 엔드포인트를 경유하여 에러 현황 점검.

### 새 파일: `bots/claude/lib/checks/error-logs.js`

```javascript
'use strict';

const { fetchOpsErrors } = require('../../../../packages/core/lib/hub-client');

/**
 * 에러 로그 모니터링 — Hub 에러 엔드포인트 경유
 * ※ fetchOpsErrors()는 DEV 프롬프트에서 hub-client.js에 추가됨
 * ※ OPS Hub에 /hub/errors/recent 엔드포인트가 있어야 동작 (이 프롬프트 작업 1)
 */
async function checkErrorLogs() {
  const items = [];

  try {
    const data = await fetchOpsErrors(60);  // 최근 1시간
    if (!data || !data.ok) {
      items.push({ label: 'Hub 에러 조회', status: 'warn', detail: '응답 없음' });
      return [{ name: 'error-logs', items }];
    }

    if (data.total_errors === 0) {
      items.push({ label: '에러 로그', status: 'ok', detail: '최근 1시간 에러 없음' });
    } else {
      for (const svc of data.services) {
        const status = svc.error_count >= 10 ? 'error' : svc.error_count >= 3 ? 'warn' : 'ok';
        items.push({
          label: svc.service,
          status,
          detail: `${svc.error_count}건 — ${(svc.recent_errors[svc.recent_errors.length - 1] || '').slice(0, 200)}`,
        });
      }
    }
  } catch (e) {
    items.push({ label: 'Hub 에러 조회', status: 'warn', detail: e.message });
  }

  return [{ name: 'error-logs', items }];
}

module.exports = { checkErrorLogs };
```

### dexter.js 수정 — 에러 로그 체크 연결

dexter.js를 읽고 기존 checks 배열/import 패턴을 확인한 후 동일하게 추가:

```javascript
const { checkErrorLogs } = require('../lib/checks/error-logs');
// checks 배열에 추가
```

---

## 작업 3: 닥터 능동화 — 에러 기반 자동 스캔

OPS 덱스터 내에서 호출됨. 에러 패턴을 보고 자동 복구 시도.

### 수정 파일: `bots/claude/lib/doctor.js`

기존 exports 위에 새 함수 추가:

```javascript
/**
 * 에러 로그 기반 능동 스캔 — 덱스터가 주기적으로 호출
 * pollDoctorTasks()와 별개로, 에러 패턴을 보고 자동 복구 시도
 */
async function scanAndRecover() {
  const { fetchOpsErrors } = require('../../../packages/core/lib/hub-client');
  
  try {
    const data = await fetchOpsErrors(10);  // 최근 10분
    if (!data?.ok || data.total_errors === 0) return [];
    
    const recoveries = [];
    for (const svc of data.services) {
      if (svc.error_count < 10) continue;
      
      const label = _serviceToLaunchd(svc.service);
      if (!label) continue;
      if (!canRecover('restart_launchd_service')) continue;
      const task = WHITELIST.restart_launchd_service;
      if (!task.allowed_services.includes(label)) continue;
      
      console.log(`  🔧 [닥터] ${svc.service} 에러 ${svc.error_count}건 → ${label} 재시작`);
      const result = await execute('restart_launchd_service', { label }, 'doctor-autoscan');
      recoveries.push({ service: svc.service, label, error_count: svc.error_count, success: result.success, message: result.message });
    }
    return recoveries;
  } catch (e) {
    console.warn('[doctor] scanAndRecover 실패:', e.message);
    return [];
  }
}

function _serviceToLaunchd(service) {
  const MAP = {
    'investment-crypto':    'ai.investment.crypto',
    'investment-domestic':  null,
    'investment-overseas':  null,
    'dexter':               'ai.claude.dexter',
    'ska-commander':        'ai.ska.commander',
  };
  return MAP[service] || null;
}
```

exports에 `scanAndRecover` 추가.

### dexter.js 수정 — scanAndRecover 호출

기존 `pollDoctorTasks()` 호출 이후에 추가:

```javascript
try {
  const doctor = require('../lib/doctor');
  const recoveries = await doctor.scanAndRecover();
  if (recoveries.length > 0) {
    const ok = recoveries.filter(r => r.success).length;
    console.log(`  🔧 [닥터 능동] ${ok}/${recoveries.length}건 자동 복구`);
  }
} catch (e) {
  console.warn('⚠️ 닥터 능동 스캔 실패 (무시):', e.message);
}
```

---

## 사전 조건

이 프롬프트 실행 전에 DEV 프롬프트(`CODEX_OPS_OBSERVABILITY_DEV.md`)가 완료되어야 함.
`fetchOpsErrors()`가 `hub-client.js`에 있어야 덱스터 체크 + 닥터 스캔이 동작.

실행 순서:
1. DEV 프롬프트 먼저 구현 (hub-client.js + CLI) → DEV에서 commit + push
2. OPS에서 git pull (DEV 코드 반영)
3. 이 OPS 프롬프트 구현 (Hub 엔드포인트 + 덱스터 + 닥터) → OPS에서 직접 구현

---

## 완료 기준 (전부 OPS 맥 스튜디오에서 검증)

```bash
# 1. 문법 검사
node --check bots/hub/src/hub.js
node --check bots/hub/lib/routes/errors.js
node --check bots/claude/lib/checks/error-logs.js
node --check bots/claude/lib/doctor.js
node --check bots/claude/src/dexter.js

# 2. Hub 재시작
launchctl kickstart -kp gui/$(id -u)/ai.hub.resource-api

# 3. Hub 에러 엔드포인트 동작 확인 (OPS 로컬)
curl -s http://localhost:7788/hub/errors/summary \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" | python3 -m json.tool
# → 기대: { "ok": true, "total": N, "with_errors": M }

curl -s "http://localhost:7788/hub/errors/recent?minutes=60" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" | python3 -m json.tool
# → 기대: 서비스별 에러 집계 + recent_errors 배열

# 4. 덱스터 다음 주기 실행 대기 후
tail -30 /tmp/dexter.log | grep error-logs

# 5. 닥터 scanAndRecover 확인
tail -30 /tmp/dexter.log | grep 닥터
```

## 커밋 메시지

```
feat(ops): OPS 에러 수집 + 닥터 능동화

Hub 에러 엔드포인트:
- GET /hub/errors/recent — /tmp/*.err.log 서비스별 집계
- GET /hub/errors/summary — 전체 에러 현황 요약

덱스터 [23] 에러 로그 모니터링:
- checks/error-logs.js — Hub 에러 엔드포인트 경유 점검

닥터 능동화:
- scanAndRecover() — 에러 10건+ 서비스 자동 재시작
- _serviceToLaunchd() 매핑 추가
```
