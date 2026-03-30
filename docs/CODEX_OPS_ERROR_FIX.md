# CODEX_OPS_ERROR_FIX — 운영 에러 수정 + DEV CLI

> 실행 대상: 코덱스 (코드 구현)
> 환경: 맥북 에어 (DEV) → git push → OPS 배포
> 작성일: 2026-03-30 (업데이트)
> 작성자: 메티 (전략+설계)

---

## 배경

OPS 에러 수집(닥터 능동화)으로 발견된 운영 에러 분석 결과:

```
investment-crypto:             142건 ← 수정 대상 (A)
investment-domestic:            12건 ← ✅ 이미 수정됨 (579b3b2 — tradeMode→signalTradeMode)
investment-overseas:             8건 ← 경고, 외부 문제
investment-argos:                4건 ← Reddit 403, 외부 문제
investment-prescreen-domestic:   2건 ← KIS/네이버 404, 외부 문제
```

수정 대상: A(crypto 최소수량) + C(DEV CLI 래퍼) 2건.

---

## 작업 A: crypto 최소수량 SELL 실패 수정

### 에러 현상 (OPS에서 매 사이클 반복)

```
⚠️ STO/USDT DB 포지션(1179.7)과 실잔고(0.0203)가 어긋남 — 실잔고 기준으로 SELL 진행
❌ 실행 오류: binance amount of STO/USDT must be greater than minimum amount precision of 0.1
⚠️ PROVE/USDT DB 포지션(258.4)과 실잔고(0.0416)가 어긋남 — 실잔고 기준으로 SELL 진행
❌ 실행 오류: binance amount of PROVE/USDT must be greater than minimum amount precision of 0.1
⚠️ FET/USDT DB 포지션(44.94)과 실잔고(0.0761)가 어긋남 — 실잔고 기준으로 SELL 진행
❌ 실행 오류: binance amount of FET/USDT must be greater than minimum amount precision of 0.1
```

### 근본 원인

DB positions에 큰 수량이 남아있지만, 실잔고는 거의 0 (OCO 청산 등으로 이미 매도됨).
실잔고 기준 SELL 시도 → 바이낸스 최소수량 미달 → 에러 → 다음 사이클에서 반복.

현재 DB 상태 (참고):
```
STO/USDT:   DB 1179.7  → 실잔고 ~0.02 (최소 0.1 필요)
PROVE/USDT: DB 258.4   → 실잔고 ~0.04 (최소 0.1 필요)
FET/USDT:   DB 44.94   → 실잔고 ~0.08 (최소 0.1 필요)
ENA/USDT:   DB 1264.71 → 실잔고 ~0.01 (최소 0.01 필요)
```

### 수정 방향

`bots/investment/team/hephaestos.js`에서 실잔고 기준 SELL 경로를 찾아서:

```
현재 흐름:
  1. DB 포지션 확인 → 수량 있음
  2. 실잔고 조회 → DB보다 훨씬 적음
  3. "실잔고 기준으로 SELL 진행" 로그 출력
  4. 바이낸스 SELL 시도 → 최소수량 미달 → 에러
  5. 다음 사이클에서 1~4 반복 (142건/시간)

수정 후:
  1. DB 포지션 확인 → 수량 있음
  2. 실잔고 조회 → DB보다 훨씬 적음
  3. 실잔고가 바이낸스 최소수량 미달인지 체크
  4-a. 미달이면 → SELL skip + DB 포지션 amount=0으로 정리 + 로그
  4-b. 충분하면 → 기존대로 실잔고 기준 SELL 진행
```

### 구현 가이드

1. hephaestos.js를 읽고 `실잔고 기준으로 SELL 진행` 로그 출력 부분을 찾기
2. 그 직후에 실잔고 vs 바이낸스 최소수량 비교 로직 추가
3. 최소수량 확인 방법:
   - ccxt 바이낸스에서 `markets[symbol].limits.amount.min` 조회
   - 또는 하드코딩 폴백 (대부분 0.01 ~ 0.1 사이)
4. 미달 시 DB 정리:
   ```javascript
   // DB 포지션 amount=0으로 업데이트
   await db.updatePosition(symbol, 'binance', { amount: 0, unrealized_pnl: 0 }, tradeMode);
   console.log(`  ⚠️ ${symbol} 실잔고 최소수량 미달 → DB 포지션 정리 (amount=0)`);
   ```
5. 정리된 포지션은 다음 사이클에서 자연스럽게 무시됨

### 주의사항

- **live(실투자) 포지션만 해당** — paper 포지션은 실잔고 조회 불필요
- DB 정리 시 `trade_journal`에 exit 기록도 남기면 좋음 (선택사항)
- 에러 카운트가 시간당 142건 → 수정 후 0건이어야 함

---

## 작업 C: DEV CLI 래퍼 스크립트

### 환경: DEV 전용 (OPS 배포 불필요)

### 새 파일: `scripts/ops-query.sh`

```bash
#!/bin/bash
# OPS DB 쿼리 — Hub PG 엔드포인트 경유 (Tailscale)
# 사용: ./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
# ※ Hub queryOpsDb(sql, schema) 인자 순서 — sql이 첫 번째

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

### 새 파일: `scripts/ops-errors.sh`

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

두 파일 모두 `chmod +x` 실행 권한 부여.

---

## 완료 기준

### DEV 단계

```bash
# 1. 문법 검사
node --check bots/investment/team/hephaestos.js

# 2. CLI 래퍼 권한 + 테스트
chmod +x scripts/ops-query.sh scripts/ops-errors.sh
./scripts/ops-query.sh investment "SELECT count(*) FROM positions WHERE amount > 0"
./scripts/ops-errors.sh 60
```

### OPS 배포 후

```bash
# 3. git push → OPS에서 자동 배포 (deploy.sh 5분 cron)
# 4. 1시간 후 에러 확인 — crypto 142건 → 대폭 감소 기대
./scripts/ops-errors.sh 60 crypto
```

## 커밋 메시지

```
fix(luna): crypto 최소수량 SELL skip + DB 포지션 정리 + DEV CLI

A. hephaestos.js: 실잔고 최소수량 미달 시 SELL skip + DB amount=0 정리
   (142건/시간 반복 에러 해소)
C. scripts/ops-query.sh + ops-errors.sh: DEV CLI 래퍼 추가
```
