# CODEX_OPS_ERROR_FIX — 운영 에러 수정 2건 + DEV CLI 래퍼

> 실행 대상: 코덱스 (코드 구현)
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 배경

OPS 에러 수집(닥터 능동화)으로 발견된 운영 에러 168건 분석 결과:

```
investment-crypto:             142건 ← 수정 대상 (A)
investment-domestic:            12건 ← 수정 대상 (B)
investment-overseas:             8건 ← 경고, 무시
investment-argos:                4건 ← Reddit 403, 외부 문제
investment-prescreen-domestic:   2건 ← KIS/네이버 404, 외부 문제
```

수정 대상은 A, B 2건 + DEV CLI 래퍼 (C).

---

## 작업 A: crypto 최소수량 SELL 실패 수정

### 환경: DEV에서 구현 → OPS 배포

### 에러 현상

```
❌ 실행 오류: binance amount of ENA/USDT must be greater than minimum amount precision of 0.01
⚠️ STO/USDT DB 포지션(1179.7)과 실잔고(0.0203)가 어긋남 — 실잔고 기준으로 SELL 진행
❌ 실행 오류: binance amount of STO/USDT must be greater than minimum amount precision of 0.1
```

### 근본 원인

DB positions 테이블에 큰 수량이 남아있지만, 실잔고는 거의 0:
- STO/USDT: DB 1179.7 vs 실잔고 0.0203
- PROVE/USDT: DB 258.4 vs 실잔고 0.0416

이미 SELL되었거나 OCO로 청산된 포지션의 DB가 업데이트되지 않은 상태.
→ 실잔고 기준 SELL 시 최소수량 미달 → 반복 에러 142건.

### 수정 방향 (2가지)

#### A-1: 최소수량 미달 시 SELL skip + DB 정리

`bots/investment/team/hephaestos.js`의 SELL 경로에서:

```
현재: 실잔고가 DB보다 작으면 실잔고 기준 SELL 시도 → 바이낸스 거부 → 에러 반복
수정: 실잔고가 바이낸스 최소수량 미달이면 → SELL skip + DB positions amount=0으로 정리
```

핵심: hephaestos.js에서 `실잔고 기준으로 SELL 진행` 하는 코드 부분을 찾아서,
실잔고가 거래소 최소수량보다 작을 때 SELL을 시도하지 않고
DB를 실잔고로 동기화(0으로 정리)하도록 수정.

관련 코드 위치:
- hephaestos.js에서 `실잔고 기준으로 SELL 진행` 로그를 출력하는 부분
- hephaestos.js에서 `실행 오류` catch 블록 (line 1275 부근)

#### A-2: DB/실잔고 동기화 스크립트 (선택)

실잔고와 DB가 크게 어긋난 포지션을 주기적으로 정리:

```sql
-- 현재 불일치 포지션 (참고)
-- STO/USDT: DB 1179.7 vs 실 0.02 → amount=0 으로 업데이트 필요
-- PROVE/USDT: DB 258.4 vs 실 0.04 → amount=0 으로 업데이트 필요
```

이건 hephaestos.js 수정으로 자연스럽게 해결될 수 있으므로 선택사항.


---

## 작업 B: domestic tradeMode is not defined 수정

### 환경: DEV에서 구현 → OPS 배포

### 에러 현상

```
❌ 실행 오류: tradeMode is not defined
```

investment-domestic.err.log에 12건 반복. ReferenceError — 변수 선언 없이 참조.

### 진단 단서

- 에러는 `console.error('❌ 실행 오류: ' + e.message)` 패턴 (hephaestos.js:1275 또는 hanul.js:553)
- domestic 파이프라인: `domestic.js → runDomesticCycle() → hanul.js`
- `hanul.js`에서 `signalTradeMode = signal.trade_mode || getInvestmentTradeMode()` 패턴 사용
- `domestic.js`의 특정 경로에서 tradeMode 변수가 선언 없이 참조될 가능성

### 수정 방법

1. `bots/investment/markets/domestic.js`를 읽고 `tradeMode`를 사용하는 모든 곳을 확인
2. `bots/investment/team/hanul.js`에서도 확인
3. 변수 선언 없이 `tradeMode`를 직접 참조하는 라인을 찾아서 수정
4. 가능한 수정: `getInvestmentTradeMode()` 호출로 대체하거나 함수 파라미터에서 받도록

### 완료 기준

```bash
# 에러 검색 (수정 후 0건이어야 함)
grep "tradeMode is not defined" bots/investment/markets/domestic.js
grep "tradeMode is not defined" bots/investment/team/hanul.js
# 문법 검사
node --check bots/investment/markets/domestic.js
node --check bots/investment/team/hanul.js
```


---

## 작업 C: DEV CLI 래퍼 (맥북 에어 DEV 전용)

### 환경: DEV에서만 구현+사용 (OPS 배포 불필요)

### 사전 조건

OPS에서 Hub 에러 엔드포인트 + hub-client.js 확장이 이미 완료됨 (3206c13).
git pull로 OPS 코드를 DEV에 반영한 후 CLI만 추가.

### 새 파일 2개

#### `scripts/ops-query.sh`

```bash
#!/bin/bash
# OPS DB 쿼리 — Hub PG 엔드포인트 경유 (Tailscale)
# 사용: ./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
# ※ queryOpsDb(sql, schema) 순서 — sql이 첫 번째 인자

SCHEMA="${1:-investment}"
SQL="${2}"

if [ -z "$SQL" ]; then
  echo "사용법: ops-query.sh <schema> <sql>"
  echo "스키마: investment | claude | reservation | ska | worker | blog | public"
  exit 1
fi

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN}"
[ -z "$TOKEN" ] && TOKEN=$(grep 'HUB_AUTH_TOKEN' ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/".*//')
[ -z "$TOKEN" ] && { echo "❌ HUB_AUTH_TOKEN 없음"; exit 1; }

curl -s -X POST "$HUB_URL/hub/pg/query" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"schema\":\"$SCHEMA\",\"sql\":\"$SQL\"}" | python3 -m json.tool
```

#### `scripts/ops-errors.sh`

```bash
#!/bin/bash
# OPS 에러 현황 — Hub 에러 엔드포인트 경유 (Tailscale)
# 사용: ./scripts/ops-errors.sh [minutes] [service]

MINUTES="${1:-60}"
SERVICE="${2}"

HUB_URL="${HUB_BASE_URL:-http://REDACTED_TAILSCALE_IP:7788}"
TOKEN="${HUB_AUTH_TOKEN}"
[ -z "$TOKEN" ] && TOKEN=$(grep 'HUB_AUTH_TOKEN' ~/.zprofile 2>/dev/null | sed 's/.*="//' | sed 's/".*//')
[ -z "$TOKEN" ] && { echo "❌ HUB_AUTH_TOKEN 없음"; exit 1; }

URL="$HUB_URL/hub/errors/recent?minutes=$MINUTES"
[ -n "$SERVICE" ] && URL="${URL}&service=$SERVICE"

curl -s "$URL" -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

두 파일 `chmod +x` 실행 권한 부여.


---

## 완료 기준

### DEV 단계

```bash
# 1. 문법 검사
node --check bots/investment/team/hephaestos.js
node --check bots/investment/team/hanul.js
node --check bots/investment/markets/domestic.js

# 2. CLI 래퍼 권한
chmod +x scripts/ops-query.sh scripts/ops-errors.sh

# 3. CLI 테스트 (Tailscale 경유)
./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
./scripts/ops-errors.sh 60
```

### OPS 배포 후

```bash
# 4. git push → OPS pull → 서비스 자동 재시작 대기
# 5. 1시간 후 에러 확인
curl -s "http://localhost:7788/hub/errors/recent?minutes=60" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" | python3 -m json.tool
# → 기대: crypto 142건 → 대폭 감소, domestic 12건 → 0건
```

## 커밋 메시지

```
fix(luna): crypto 최소수량 SELL skip + domestic tradeMode 수정 + DEV CLI

A. crypto: 실잔고가 최소수량 미달 시 SELL skip + DB 포지션 정리
B. domestic: tradeMode is not defined ReferenceError 수정
C. DEV CLI: ops-query.sh + ops-errors.sh 래퍼 스크립트 추가
```
