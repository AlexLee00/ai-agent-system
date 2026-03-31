# CODEX_OPS_OBSERVABILITY_OPS_PATCH — hub-client.js 확장 보완

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥 스튜디오 (OPS)**
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)
> 관련: CODEX_OPS_OBSERVABILITY_OPS.md의 누락 작업 보완

---

## 배경

`CODEX_OPS_OBSERVABILITY_OPS.md`의 작업 2(error-logs.js)와 작업 3(doctor.js)에서
`hub-client.js`의 `fetchOpsErrors()`와 `queryOpsDb()`를 import하지만,
해당 함수의 구현 코드가 프롬프트에 누락됨.

**이 보완 프롬프트를 기존 OPS 프롬프트의 작업 1 이후, 작업 2 이전에 실행할 것.**

---

## 실행 순서 (전체)

```
기존 작업 1: Hub 에러 엔드포인트 (errors.js + hub.js)
  ↓
★ 이 보완: hub-client.js 확장 (queryOpsDb + fetchOpsErrors)
  ↓
기존 작업 2: 덱스터 [23] 에러 로그 체크 (error-logs.js)
  ↓
기존 작업 3: 닥터 능동화 (scanAndRecover)
```

---

## 작업: hub-client.js에 2개 함수 추가

### 수정 파일: `packages/core/lib/hub-client.js`

현재 exports: `{ fetchHubSecrets }` — 1개만 존재.
아래 2개 함수를 추가하고 exports에 포함.

### 함수 1: `queryOpsDb(sql, schema, timeoutMs)`

```javascript
/**
 * OPS DB 읽기 전용 쿼리 — Hub pg/query 엔드포인트 경유
 * DEV에서 OPS DB를 안전하게 조회할 때 사용.
 * OPS에서도 Hub 경유로 일관된 접근 경로 제공.
 *
 * @param {string} sql - SELECT 쿼리 (쓰기 차단됨)
 * @param {string} schema - DB 스키마 (investment, claude, reservation 등)
 * @param {number} timeoutMs - 타임아웃 (기본 5000ms, DB 쿼리는 시크릿보다 느릴 수 있음)
 * @returns {Promise<{ok,rows,rowCount}|null>} 결과 또는 null (실패 시)
 */
async function queryOpsDb(sql, schema = 'investment', timeoutMs = 5000) {
  if (!env.HUB_BASE_URL) return null;

  const url = `${env.HUB_BASE_URL}/hub/pg/query`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, schema }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[hub-client] queryOpsDb: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] queryOpsDb: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

### 함수 2: `fetchOpsErrors(minutes, service, timeoutMs)`

```javascript
/**
 * OPS 에러 로그 조회 — Hub errors/recent 엔드포인트 경유
 * /tmp/*.err.log 파일의 서비스별 에러 집계를 가져옴.
 *
 * @param {number} minutes - 조회 범위 (기본 60분)
 * @param {string|null} service - 특정 서비스 필터 (null이면 전체)
 * @param {number} timeoutMs - 타임아웃 (기본 3000ms)
 * @returns {Promise<{ok,total_errors,services}|null>} 결과 또는 null
 */
async function fetchOpsErrors(minutes = 60, service = null, timeoutMs = 3000) {
  if (!env.HUB_BASE_URL) return null;

  let url = `${env.HUB_BASE_URL}/hub/errors/recent?minutes=${minutes}`;
  if (service) url += `&service=${encodeURIComponent(service)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.HUB_AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[hub-client] fetchOpsErrors: HTTP ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    const message = err.name === 'AbortError' ? '타임아웃' : err.message;
    console.warn(`[hub-client] fetchOpsErrors: ${message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
```

### exports 수정

```javascript
// 기존
module.exports = { fetchHubSecrets };

// 변경
module.exports = { fetchHubSecrets, queryOpsDb, fetchOpsErrors };
```

---

## 설계 원칙

1. **기존 패턴 준수**: `fetchHubSecrets()`와 동일한 패턴 (AbortController + 타임아웃 + warn 로그 + null 반환)
2. **인증 일관성**: 모든 Hub 호출에 동일한 Bearer Token 사용
3. **실패 안전**: Hub 불가 시 null 반환, 호출자가 판단
4. **USE_HUB_SECRETS 독립**: 이 함수들은 `USE_HUB_SECRETS` 플래그와 무관하게 `HUB_BASE_URL`만 확인. 시크릿이 아닌 운영 데이터 조회용이므로.

---

## 완료 기준

```bash
# 1. 문법 검사
node --check packages/core/lib/hub-client.js

# 2. exports 확인
node -e "
const hc = require('./packages/core/lib/hub-client');
console.log('fetchHubSecrets:', typeof hc.fetchHubSecrets);
console.log('queryOpsDb:', typeof hc.queryOpsDb);
console.log('fetchOpsErrors:', typeof hc.fetchOpsErrors);
"
# 기대: 전부 'function'

# 3. 실제 호출 테스트 (OPS)
source ~/.zprofile
node -e "
const { queryOpsDb } = require('./packages/core/lib/hub-client');
queryOpsDb('SELECT count(*) as cnt FROM positions WHERE amount > 0', 'investment')
  .then(r => console.log('DB:', r));
"

# 4. 에러 조회 테스트 (Hub 에러 엔드포인트가 구현된 후)
node -e "
const { fetchOpsErrors } = require('./packages/core/lib/hub-client');
fetchOpsErrors(60).then(r => console.log('Errors:', r));
"
```

---

## 이 프롬프트 실행 후 다음 단계

이 보완 작업 완료 후, 기존 OPS 프롬프트의 **작업 2 (error-logs.js)**부터 이어서 진행.
