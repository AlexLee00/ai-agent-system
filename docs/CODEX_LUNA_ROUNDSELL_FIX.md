# CODEX_LUNA_ROUNDSELL_FIX — crypto 최소수량 SELL 에러 근본 수정

> 실행 대상: 코덱스 (코드 구현)
> 환경: **맥북 에어 (DEV)** → git push → OPS 자동 배포
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 배경

OPS에서 시간당 142~147건 반복되는 에러:

```
⚠️ FET/USDT DB 포지션(44.94)과 실잔고(0.0761)가 어긋남 — 실잔고 기준으로 SELL 진행
❌ 실행 오류: binance amount of FET/USDT must be greater than minimum amount precision of 0.1
```

### 근본 원인 (메티 분석)

기존 가드 코드(line 1178)가 동작하지 않는 이유:

```
실행 흐름:
  1. blo.js 호출 → hephaestos.js executeTrade()
  2. SELL 경로 → 실잔고(0.0761) < DB(44.94) → 실잔고 기준으로 SELL
  3. marketSell() 호출
  4. marketSell() 내부 → roundSellAmount(symbol, 0.0761) 호출
  5. roundSellAmount() → ex.amountToPrecision('FET/USDT', 0.0761) 호출
  6. ★ ccxt가 예외를 throw! (반환이 아님)
     "binance amount of FET/USDT must be greater than minimum amount precision of 0.1"
  7. roundSellAmount()에 try-catch 없음 → 예외 전파
  8. marketSell()의 가드 코드(if normalizedAmount <= 0)에 도달하지 못함
  9. executeTrade() catch에서 "실행 오류"로 로깅 → 다음 사이클 반복
```

검증:

```javascript
// OPS 맥 스튜디오에서 직접 확인 (메티)
const ccxt = require('ccxt');
const ex = new ccxt.binance({ enableRateLimit: true });
await ex.loadMarkets();
ex.amountToPrecision('FET/USDT', 0.0761);
// → throw: "binance amount of FET/USDT must be greater than minimum amount precision of 0.1"
```

**ccxt.amountToPrecision()은 최소수량 미달 시 값을 반환하지 않고 예외를 던진다.**

---

## 수정 내용

### 수정 파일: `bots/investment/team/hephaestos.js`

### 수정 1: `roundSellAmount()` — try-catch 추가

현재 코드 (line 144~147):

```javascript
function roundSellAmount(symbol, amount) {
  const ex = getExchange();
  const precise = Number(ex.amountToPrecision(symbol, amount));
  return Number.isFinite(precise) ? precise : 0;
}
```

수정 후:

```javascript
function roundSellAmount(symbol, amount) {
  try {
    const ex = getExchange();
    const precise = Number(ex.amountToPrecision(symbol, amount));
    return Number.isFinite(precise) ? precise : 0;
  } catch {
    // ccxt가 최소수량 미달 시 예외를 던짐
    // → 0 반환하면 호출자의 가드(normalizedAmount <= 0)에서 처리됨
    return 0;
  }
}
```

이 한 줄 수정으로:
- `roundSellAmount()` → 0 반환
- `marketSell()` 가드 → `normalizedAmount <= 0` → sell_amount_below_minimum 에러 throw
- `executeTrade()` SELL 경로 가드(line 1178) → `roundedAmount <= 0` → SELL 스킵 + DB 정리
- `cleanupDustLivePosition()` → DB 포지션 삭제
- 다음 사이클에서 해당 심볼 더 이상 에러 없음

---

## 영향 범위

```
수정 파일: 1개 (hephaestos.js)
수정 줄수: 5줄 (try-catch 추가)
영향 경로: roundSellAmount() → marketSell() → executeTrade() SELL

안전성:
  - 기존 정상 SELL(수량 충분)은 영향 없음 — amountToPrecision() 정상 반환
  - 최소수량 미달 SELL만 영향 — 0 반환 → 기존 가드에서 처리
  - 새로운 경로 추가 없음, 기존 가드 코드 활용
```

---

## 완료 기준

```bash
# 1. 문법 검사
node --check bots/investment/team/hephaestos.js

# 2. 로직 확인 — roundSellAmount 수정 확인
grep -A 8 "function roundSellAmount" bots/investment/team/hephaestos.js
# → try-catch 포함 확인

# 3. git push
git add bots/investment/team/hephaestos.js
git commit -m "fix(luna): roundSellAmount try-catch — ccxt 최소수량 예외 처리

ccxt.amountToPrecision()이 최소수량 미달 시 예외를 throw하는 문제:
- roundSellAmount()에 try-catch 추가 → 0 반환
- 기존 가드(normalizedAmount<=0)가 SELL 스킵 + DB 정리 처리
- 142건/시간 반복 에러 해소 기대"
git push origin main
```

### OPS 배포 후 검증 (자동 5분 cron)

```bash
# 배포 후 10분 대기 → 에러 확인
./scripts/ops-errors.sh 10 crypto
# 기대: "binance amount of ... must be greater than" 에러 0건
# 대신: "최소 매도 수량 미달 — SELL 스킵" 로그 확인
```
