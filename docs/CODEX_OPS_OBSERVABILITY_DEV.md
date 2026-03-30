# CODEX_OPS_OBSERVABILITY_DEV — DEV CLI 래퍼 (DB 조회 + 에러 조회)

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥북 에어 (DEV)** — DEV에서만 사용하는 CLI 도구
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 사전 조건

⚠️ **OPS 프롬프트(`CODEX_OPS_OBSERVABILITY_OPS.md`)가 먼저 완료되어야 함.**

OPS에서 구현된 항목:
- Hub 에러 엔드포인트 (`/hub/errors/recent`, `/hub/errors/summary`)
- `hub-client.js`에 `queryOpsDb()` + `fetchOpsErrors()` 추가
- 덱스터 [23] 에러 로그 체크 + 닥터 `scanAndRecover()`

이 DEV 프롬프트는 OPS 완료 후 `git pull`로 코드를 받은 뒤,
DEV 전용 CLI 래퍼 스크립트만 추가합니다.

```
실행 순서:
1. git pull origin main  (OPS에서 push한 코드 반영)
2. CLI 래퍼 스크립트 작성
3. Tailscale 경유 OPS Hub 호출 테스트
```

---

## 목표

DEV에서 터미널로 OPS 상태를 빠르게 조회하는 CLI 스크립트 2개 추가.

---

## 작업 1: `scripts/ops-query.sh`

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

---

## 작업 2: `scripts/ops-errors.sh`

```bash
#!/bin/bash
# OPS 에러 현황 조회 — Hub 에러 엔드포인트 경유 (Tailscale)
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
# 1. git pull (OPS 코드 반영)
git pull origin main

# 2. CLI 스크립트 권한
chmod +x scripts/ops-query.sh scripts/ops-errors.sh

# 3. DB 조회 테스트 (Tailscale 경유)
./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
# → 기대: { "ok": true, "rows": [...] }

# 4. 에러 조회 테스트 (Tailscale 경유)
./scripts/ops-errors.sh 60
# → 기대: { "ok": true, "services": [...] }

# 5. hub-client.js 함수 존재 확인 (OPS에서 추가된 것)
node -e "
const hc = require('./packages/core/lib/hub-client');
console.log('queryOpsDb:', typeof hc.queryOpsDb);
console.log('fetchOpsErrors:', typeof hc.fetchOpsErrors);
"
```

## 커밋 메시지

```
feat(dev): DEV CLI 래퍼 — ops-query.sh + ops-errors.sh

- scripts/ops-query.sh: Tailscale 경유 OPS DB 쿼리
- scripts/ops-errors.sh: Tailscale 경유 OPS 에러 조회
- OPS 프롬프트(CODEX_OPS_OBSERVABILITY_OPS.md)에서 구현된 Hub API 활용
```
