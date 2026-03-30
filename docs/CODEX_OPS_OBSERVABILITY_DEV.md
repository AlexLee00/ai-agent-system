# CODEX_OPS_OBSERVABILITY_DEV — DEV 관측성 도구 (DB CLI + 에러 조회)

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥북 에어 (DEV)** — DEV에서만 사용하는 도구
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 목표

DEV에서 OPS 문제를 디버깅하기 위한 클라이언트 도구 2가지:
1. `hub-client.js`에 `queryOpsDb()` + `fetchOpsErrors()` 함수 추가
2. CLI 래퍼 스크립트 (`ops-query.sh`, `ops-errors.sh`)

※ 이 프롬프트는 DEV 전용. OPS Hub/덱스터/닥터 수정은 별도 OPS 프롬프트 참조.

---

## 작업 1: hub-client.js 확장

### 수정 파일: `packages/core/lib/hub-client.js`

기존 `fetchHubSecrets()` 아래에 2개 함수 추가.
hub-client.js를 먼저 읽고 기존 패턴(_getHubBaseUrl, _getHubAuthToken 등)을 따를 것.

#### queryOpsDb()

```javascript
/**
 * Hub PG 쿼리 (읽기 전용)
 * @param {string} schema - investment, claude, reservation, ska, worker, blog, public
 * @param {string} sql - SELECT/WITH/EXPLAIN만 허용 (Hub sql-guard가 차단)
 * @param {Array} params - 쿼리 파라미터
 * @returns {Promise<Array|null>} rows 또는 null (Hub 미사용 시)
 */
async function queryOpsDb(schema, sql, params = []) {
  // 기존 fetchHubSecrets()의 baseUrl/token 획득 패턴과 동일하게 구현
  // POST ${baseUrl}/hub/pg/query
  // body: { schema, sql, params }
  // 응답: { ok: true, rows: [...] } → rows 반환
  // 실패 시 null 반환
}
```

#### fetchOpsErrors()

```javascript
/**
 * Hub 에러 조회 — OPS /tmp/*.err.log 집계
 * ※ OPS Hub에 /hub/errors/recent 엔드포인트가 있어야 동작 (OPS 프롬프트에서 구현)
 * @param {number} minutes - 최근 N분 (기본 60)
 * @param {string} service - 서비스 필터 (optional)
 * @returns {Promise<object|null>}
 */
async function fetchOpsErrors(minutes = 60, service = null) {
  // GET ${baseUrl}/hub/errors/recent?minutes=${minutes}&service=${service}
  // 실패 시 null 반환 (OPS에 엔드포인트가 없으면 404 → null)
}
```

exports에 `queryOpsDb`, `fetchOpsErrors` 추가.

---

## 작업 2: DEV CLI 래퍼 스크립트

### 새 파일: `scripts/ops-query.sh`

```bash
#!/bin/bash
# OPS DB 쿼리 래퍼 — Hub PG 엔드포인트 경유 (Tailscale)
# 사용: ./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"

SCHEMA="${1:-investment}"
SQL="${2}"

if [ -z "$SQL" ]; then
  echo "사용법: ops-query.sh <schema> <sql>"
  echo "스키마: investment | claude | reservation | ska | worker | blog | public"
  exit 1
fi

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN}"

# .zprofile에서 토큰 읽기 (환경변수 없을 때)
if [ -z "$TOKEN" ]; then
  TOKEN=$(grep 'HUB_AUTH_TOKEN' ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/".*//')
fi

if [ -z "$TOKEN" ]; then
  echo "❌ HUB_AUTH_TOKEN 없음 (.zprofile 또는 환경변수 설정 필요)"
  exit 1
fi

curl -s -X POST "$HUB_URL/hub/pg/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"schema\":\"$SCHEMA\",\"sql\":\"$SQL\"}" | python3 -m json.tool
```

### 새 파일: `scripts/ops-errors.sh`

```bash
#!/bin/bash
# OPS 에러 현황 조회 — Hub 에러 엔드포인트 경유 (Tailscale)
# ※ OPS Hub에 /hub/errors/recent 엔드포인트가 구현된 후 동작
# 사용: ./scripts/ops-errors.sh [minutes] [service]

MINUTES="${1:-60}"
SERVICE="${2}"

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN}"

if [ -z "$TOKEN" ]; then
  TOKEN=$(grep 'HUB_AUTH_TOKEN' ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/".*//')
fi

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

```bash
# 1. 문법 검사
node --check packages/core/lib/hub-client.js

# 2. 함수 존재 확인
node -e "
const hc = require('./packages/core/lib/hub-client');
console.log('queryOpsDb:', typeof hc.queryOpsDb);
console.log('fetchOpsErrors:', typeof hc.fetchOpsErrors);
"

# 3. CLI 스크립트 권한
chmod +x scripts/ops-query.sh scripts/ops-errors.sh

# 4. queryOpsDb 동작 테스트 (Tailscale 경유)
node -e "
const { queryOpsDb } = require('./packages/core/lib/hub-client');
queryOpsDb('investment', 'SELECT count(*) as cnt FROM positions WHERE amount > 0')
  .then(rows => console.log('positions:', rows));
"

# 5. CLI 래퍼 테스트
./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
# ops-errors.sh는 OPS에 엔드포인트 구현 후 동작
```

## 커밋 메시지

```
feat(dev): DEV 관측성 도구 — queryOpsDb + fetchOpsErrors + CLI 래퍼

- hub-client.js: queryOpsDb() Hub PG 쿼리 래퍼 (읽기 전용)
- hub-client.js: fetchOpsErrors() Hub 에러 조회 (OPS 엔드포인트 필요)
- scripts/ops-query.sh: DEV에서 OPS DB 조회 CLI
- scripts/ops-errors.sh: DEV에서 OPS 에러 조회 CLI
```
