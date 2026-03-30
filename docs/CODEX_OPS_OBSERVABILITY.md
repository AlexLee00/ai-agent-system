# CODEX_OPS_OBSERVABILITY — OPS 관측성 강화 (DB CLI + 에러 수집)

> 실행 대상: 코덱스 (코드 구현)
> 환경: 맥북 에어 (DEV) — 모든 코드 구현은 DEV에서 진행
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 배경

DEV에서 OPS 문제를 디버깅하려면 두 축이 필요:
1. **DB 접근** — Hub PG 쿼리 API는 있지만 편하게 쓸 수 없음
2. **에러 수집** — /tmp/*.err.log 16개 파일에 산재, 아무도 자동으로 읽지 않음

닥터(doctor.js)가 이미 있지만 **운영에서 한 번도 실행된 적 없음** (이력 5건 전부 테스트).
원인: 클로드(팀장)가 agent_tasks에 복구 지시를 넣지 않아서 pollDoctorTasks()가 항상 빈 루프.

---

## ⚠️ DEV / OPS 구분 (필독)

모든 코드 구현은 맥북 에어(DEV)에서 진행. OPS 반영은 git push → OPS pull → 서비스 재시작.

### 작업별 환경 구분

| # | 작업 | 코드 구현 | 실행 환경 | OPS 배포 후 조치 |
|---|------|----------|----------|-----------------|
| 1 | Hub 에러 엔드포인트 | DEV | **OPS** (Hub 서버) | `launchctl kickstart` Hub 재시작 |
| 2 | hub-client.js 확장 | DEV | DEV+OPS 공통 | 자동 반영 (다음 봇 실행 시) |
| 3 | 덱스터 [23] 에러 체크 | DEV | **OPS** (덱스터 봇) | 덱스터 자동 재시작 (launchd) |
| 4 | 닥터 능동화 | DEV | **OPS** (덱스터 내 호출) | 덱스터 재시작 시 함께 반영 |
| 5 | DEV CLI 스크립트 | DEV | **DEV 전용** | 없음 (DEV에서만 사용) |

### 배포 순서

```
1. DEV에서 전체 구현 + 문법 검사
2. git push origin main
3. OPS에서 git pull
4. Hub 재시작: launchctl kickstart -kp gui/$(id -u)/ai.hub.resource-api
5. 덱스터는 launchd가 자동 재시작 (주기 실행)
6. DEV에서 Hub API 호출로 검증
```

### DEV에서 테스트 가능 범위

- hub-client.js queryOpsDb() / fetchOpsErrors() → DEV에서 Tailscale 경유 OPS Hub 호출
- CLI 스크립트 → DEV에서 바로 실행
- Hub 엔드포인트 / 덱스터 / 닥터 → OPS 배포 후에만 검증 가능

---

## 작업 1: Hub 에러 엔드포인트 추가 (OPS Hub 서버에서 실행됨)

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
  const cutoff = Date.now() - minutes * 60 * 1000;

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
 * GET /hub/errors/summary
 * 전체 서비스 에러 현황 요약 (한눈에 보기)
 */
async function errorsSummaryRoute(req, res) {
  const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(ERR_SUFFIX));

  const summary = [];
  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      const service = file.replace(ERR_SUFFIX, '');
      summary.push({
        service,
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

```javascript
// 기존 라우트 아래에 추가
const { errorsRecentRoute, errorsSummaryRoute } = require('./lib/routes/errors');
app.get('/hub/errors/recent', generalLimiter, errorsRecentRoute);
app.get('/hub/errors/summary', generalLimiter, errorsSummaryRoute);
```

위치: `app.get('/hub/secrets/:category', ...)` 라인 이후에 추가.
인증: `/hub` 하위이므로 기존 `authMiddleware` 자동 적용됨.

---

## 작업 2: hub-client.js에 queryOpsDb() 추가 (DEV+OPS 공통 모듈)

### 수정 파일: `packages/core/lib/hub-client.js`

기존 `fetchHubSecrets()` 아래에 추가:

```javascript
/**
 * Hub PG 쿼리 (읽기 전용)
 * @param {string} schema - investment, claude, reservation, ska, worker, blog, public
 * @param {string} sql - SELECT/WITH/EXPLAIN만 허용
 * @param {Array} params - 쿼리 파라미터
 * @returns {Promise<Array|null>} rows 또는 null (Hub 미사용 시)
 */
async function queryOpsDb(schema, sql, params = []) {
  const baseUrl = _getHubBaseUrl();
  const token = _getHubAuthToken();
  if (!baseUrl || !token) return null;

  try {
    const res = await fetch(`${baseUrl}/hub/pg/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ schema, sql, params }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data.rows : null;
  } catch {
    return null;
  }
}
```

`_getHubBaseUrl()`와 `_getHubAuthToken()`은 기존 `fetchHubSecrets()`에서
사용하는 내부 함수와 동일한 패턴으로 env에서 읽으면 됨.
hub-client.js 코드를 읽고 기존 패턴을 따를 것.

exports에 `queryOpsDb` 추가.


hub-client.js에 에러 조회 함수도 추가:

```javascript
/**
 * Hub 에러 조회
 * @param {number} minutes - 최근 N분 (기본 60)
 * @param {string} service - 서비스 필터 (optional)
 * @returns {Promise<object|null>}
 */
async function fetchOpsErrors(minutes = 60, service = null) {
  const baseUrl = _getHubBaseUrl();
  const token = _getHubAuthToken();
  if (!baseUrl || !token) return null;

  try {
    let url = `${baseUrl}/hub/errors/recent?minutes=${minutes}`;
    if (service) url += `&service=${service}`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
```

exports에 `fetchOpsErrors` 추가.

---

## 작업 3: 덱스터 에러 로그 체크 모듈 추가 (OPS 덱스터 봇에서 실행됨)

### 새 파일: `bots/claude/lib/checks/error-logs.js`

덱스터의 23번째 점검 카테고리.

```javascript
'use strict';

const { fetchOpsErrors } = require('../../../../packages/core/lib/hub-client');

/**
 * 에러 로그 모니터링 — Hub 에러 엔드포인트 경유
 * @returns {{ name, items }[]}
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
          detail: `${svc.error_count}건 — ${svc.recent_errors[svc.recent_errors.length - 1] || ''}`.slice(0, 200),
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

덱스터의 체크 모듈 배열에 추가:

```javascript
const { checkErrorLogs } = require('../lib/checks/error-logs');

// checks 배열에 추가 (기존 체크 뒤에)
checks.push(checkErrorLogs);
```

기존 체크 모듈 import/배열 패턴을 따를 것.
dexter.js를 읽고 기존 checks 등록 패턴을 확인한 후 동일하게 추가.


---

## 작업 4: 닥터 능동화 — 에러 기반 자동 스캔 (OPS 덱스터 내에서 호출됨)

### 수정 파일: `bots/claude/lib/doctor.js`

기존 `pollDoctorTasks()` 이후에 새 함수 추가:

```javascript
/**
 * 에러 로그 기반 능동 스캔 — 10분 주기로 덱스터가 호출
 * pollDoctorTasks()와 별개로, 에러 패턴을 보고 자동 복구 시도
 */
async function scanAndRecover() {
  const { fetchOpsErrors } = require('../../../packages/core/lib/hub-client');
  
  try {
    const data = await fetchOpsErrors(10);  // 최근 10분
    if (!data?.ok || data.total_errors === 0) return [];
    
    const recoveries = [];
    
    for (const svc of data.services) {
      // 10건 이상 에러 → 서비스 재시작 시도
      if (svc.error_count < 10) continue;
      
      const label = _serviceToLaunchd(svc.service);
      if (!label) continue;
      
      // 화이트리스트에 있는 서비스만 재시작
      if (!canRecover('restart_launchd_service')) continue;
      
      const task = WHITELIST.restart_launchd_service;
      if (!task.allowed_services.includes(label)) continue;
      
      console.log(`  🔧 [닥터] ${svc.service} 에러 ${svc.error_count}건 → ${label} 재시작 시도`);
      const result = await execute('restart_launchd_service', { label }, 'doctor-autoscan');
      recoveries.push({
        service: svc.service,
        label,
        error_count: svc.error_count,
        success: result.success,
        message: result.message,
      });
    }
    
    return recoveries;
  } catch (e) {
    console.warn('[doctor] scanAndRecover 실패:', e.message);
    return [];
  }
}

/**
 * 서비스명 → launchd label 매핑
 */
function _serviceToLaunchd(service) {
  const MAP = {
    'investment-crypto':    'ai.investment.crypto',
    'investment-domestic':  null,  // 스케줄 기반이라 재시작 불가
    'investment-overseas':  null,
    'dexter':               'ai.claude.dexter',
  };
  return MAP[service] || null;
}
```

exports에 `scanAndRecover` 추가.

### dexter.js 수정 — scanAndRecover 호출

기존 `pollDoctorTasks()` 호출 이후에 추가:

```javascript
// 닥터 능동 스캔 (에러 기반 자동 복구)
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

## 작업 5: DEV CLI 래퍼 스크립트 (DEV 전용 — OPS 배포 불필요)

### 새 파일: `scripts/ops-query.sh`

```bash
#!/bin/bash
# OPS DB 쿼리 래퍼 — Hub PG 엔드포인트 경유
# 사용: ./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"

SCHEMA="${1:-investment}"
SQL="${2}"

if [ -z "$SQL" ]; then
  echo "사용법: ops-query.sh <schema> <sql>"
  echo "스키마: investment | claude | reservation | ska | worker | blog | public"
  exit 1
fi

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN:-$(grep HUB_AUTH_TOKEN ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/"//')}"

if [ -z "$TOKEN" ]; then
  echo "❌ HUB_AUTH_TOKEN 없음 (.zprofile 또는 환경변수 설정 필요)"
  exit 1
fi

curl -s -X POST "$HUB_URL/hub/pg/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"schema\":\"$SCHEMA\",\"sql\":\"$SQL\"}" | python3 -m json.tool
```

### 수정 파일: `scripts/ops-errors.sh` (기존 파일이 있으면 수정, 없으면 생성)

```bash
#!/bin/bash
# OPS 에러 현황 조회 — Hub 에러 엔드포인트 경유
# 사용: ./scripts/ops-errors.sh [minutes] [service]

MINUTES="${1:-60}"
SERVICE="${2}"

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN:-$(grep HUB_AUTH_TOKEN ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/"//')}"

if [ -z "$TOKEN" ]; then
  echo "❌ HUB_AUTH_TOKEN 없음"
  exit 1
fi

URL="$HUB_URL/hub/errors/recent?minutes=$MINUTES"
[ -n "$SERVICE" ] && URL="${URL}&service=$SERVICE"

curl -s "$URL" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

두 파일 모두 `chmod +x` 실행 권한 부여.

---

## 완료 기준

### DEV 단계 (코덱스가 맥북 에어에서 실행)

```bash
# 1. 문법 검사 (전 파일)
node --check bots/hub/src/hub.js
node --check bots/hub/lib/routes/errors.js
node --check packages/core/lib/hub-client.js
node --check bots/claude/lib/checks/error-logs.js
node --check bots/claude/lib/doctor.js
node --check bots/claude/src/dexter.js

# 2. hub-client.js 함수 존재 확인
node -e "
const hc = require('./packages/core/lib/hub-client');
console.log('queryOpsDb:', typeof hc.queryOpsDb);
console.log('fetchOpsErrors:', typeof hc.fetchOpsErrors);
"

# 3. CLI 스크립트 권한
chmod +x scripts/ops-query.sh scripts/ops-errors.sh
```

### OPS 배포 후 (메티가 점검 — git push → OPS pull → 재시작)

```bash
# 4. Hub 에러 엔드포인트 (OPS Hub 재시작 후)
curl -s http://REDACTED_TAILSCALE_IP:7788/hub/errors/summary \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" | python3 -m json.tool

# 5. DEV에서 Hub PG 쿼리 (Tailscale 경유)
node -e "
const { queryOpsDb } = require('./packages/core/lib/hub-client');
queryOpsDb('investment', 'SELECT count(*) as cnt FROM positions WHERE amount > 0')
  .then(rows => console.log('positions:', rows));
"

# 6. DEV CLI 래퍼
./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
./scripts/ops-errors.sh 60

# 7. 덱스터 에러 체크 동작 확인 (OPS 덱스터 로그)
ssh alexlee@REDACTED_TAILSCALE_IP "tail -20 /tmp/dexter.log | grep error-logs"
```

## 커밋 메시지

```
feat(ops): OPS 관측성 강화 — 에러 수집 + DB CLI + 닥터 능동화

Hub 에러 엔드포인트:
- GET /hub/errors/recent — /tmp/*.err.log 서비스별 집계
- GET /hub/errors/summary — 전체 에러 현황 요약

hub-client.js 확장:
- queryOpsDb() — Hub PG 쿼리 래퍼 (읽기 전용)
- fetchOpsErrors() — Hub 에러 조회

덱스터 [23] 에러 로그 모니터링:
- checks/error-logs.js — Hub 에러 엔드포인트 경유 점검

닥터 능동화:
- scanAndRecover() — 에러 패턴 기반 자동 복구 시도
- 10건 이상 에러 서비스 → 화이트리스트 내 자동 재시작

DEV CLI:
- scripts/ops-query.sh — OPS DB 쿼리 래퍼
- scripts/ops-errors.sh — OPS 에러 현황 조회
```
