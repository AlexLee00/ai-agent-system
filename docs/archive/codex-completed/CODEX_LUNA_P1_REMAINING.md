# CODEX_LUNA_P1_REMAINING — 루나팀 P1 미완료 2건

> 실행 대상: 코덱스 (코드 구현)
> 환경: 맥북 에어 (DEV)
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 작업 1: max_daily_trades 상향

### 배경

EXIT 경로(P1-10) 도입 후 일간 거래량이 안정화됨 (3/25~ 최대 8건).
하지만 paper 모드 테스트 시 binance에서 25건까지 발생 이력 있음.
현재 한도가 너무 타이트해서 정상 SELL까지 차단될 위험.

### 수정 파일

`bots/investment/config.yaml` — capital_management 섹션

### 변경 내용

```yaml
# 기본값
max_daily_trades: 10 → 12

# by_exchange.binance
max_daily_trades: 16 → 20
  validation: max_daily_trades: 10 → 12

# by_exchange.kis
max_daily_trades: 12 → 16
  validation: max_daily_trades: 20 (유지)

# by_exchange.kis_overseas
max_daily_trades: 12 → 16
  validation: max_daily_trades: 20 (유지)
```

### 확인

```bash
grep "max_daily_trades" bots/investment/config.yaml
```

---

## 작업 2: unrealized_pnl 갱신 — KIS 국내/해외 연동

### 배경

`bots/investment/scripts/update-unrealized-pnl.js`가 10분 주기로 실행 중.
현재 Binance(ccxt)만 갱신하고, KIS 국내/해외는 `// 향후 KIS API 연동` 주석만 있음.
OPS 로그에서 12건이 `⏸️ 시세 미조회`로 나옴.

### 기존 코드 (77줄, ESM)

- Binance: `ccxt.binance()` → `fetchTickers()` → 현재가 → PnL 계산
- KIS: 미구현

### 사용할 API (이미 존재)

```javascript
// bots/investment/shared/kis-client.js (ESM)
import { getDomesticPrice } from '../shared/kis-client.js';
import { getOverseasPrice } from '../shared/kis-client.js';
// 또는 한줄로:
import { getDomesticPrice, getOverseasPrice } from '../shared/kis-client.js';

// 국내: getDomesticPrice(symbol, paper) → number (원)
// 해외: getOverseasPrice(symbol) → { price: number, excd: string }
```

### 수정 방법

`update-unrealized-pnl.js`의 main() 함수에서 KIS 포지션 처리 추가:

```javascript
// 기존 바이낸스 처리 이후에 추가

// KIS 국내 현재가 조회
const kisPositions = positions.filter(p => p.exchange === 'kis');
for (const pos of kisPositions) {
  try {
    const price = await getDomesticPrice(pos.symbol, false);
    // 국내주식은 원화 기준
    const unrealizedPnl = (price - pos.avg_price) * pos.amount;
    const pnlPct = ((price - pos.avg_price) / pos.avg_price * 100).toFixed(2);
    
    await pool.query(`
      UPDATE investment.positions
      SET unrealized_pnl = $1, updated_at = now()
      WHERE symbol = $2 AND exchange = $3 AND paper = false AND trade_mode = $4
    `, [unrealizedPnl, pos.symbol, pos.exchange, pos.trade_mode]);
    
    console.log(`✅ ${pos.symbol} (KIS): ${price}원 (${pnlPct > 0 ? '+' : ''}${pnlPct}%) unrealized=${unrealizedPnl.toFixed(0)}`);
    updated++;
  } catch (e) {
    console.log(`⚠️ ${pos.symbol} (KIS): ${e.message}`);
  }
}

// KIS 해외 현재가 조회
const kisOverseasPositions = positions.filter(p => p.exchange === 'kis_overseas');
for (const pos of kisOverseasPositions) {
  try {
    const { price } = await getOverseasPrice(pos.symbol);
    const unrealizedPnl = (price - pos.avg_price) * pos.amount;
    const pnlPct = ((price - pos.avg_price) / pos.avg_price * 100).toFixed(2);
    
    await pool.query(`
      UPDATE investment.positions
      SET unrealized_pnl = $1, updated_at = now()
      WHERE symbol = $2 AND exchange = $3 AND paper = false AND trade_mode = $4
    `, [unrealizedPnl, pos.symbol, pos.exchange, pos.trade_mode]);
    
    console.log(`✅ ${pos.symbol} (KIS해외): $${price} (${pnlPct > 0 ? '+' : ''}${pnlPct}%) unrealized=${unrealizedPnl.toFixed(4)}`);
    updated++;
  } catch (e) {
    console.log(`⚠️ ${pos.symbol} (KIS해외): ${e.message}`);
  }
}
```

### 주의사항

1. `kis-client.js`는 ESM export — import 구문 사용
2. `kis-client.js`는 `initHubSecrets()`로 시크릿 로드 필요
   → main() 시작 시 `await initHubSecrets();` 추가 (Phase D 패턴)
3. KIS API는 장 마감 시간에도 시세 조회 가능 (마지막 종가 반환)
4. `getOverseasPrice()`는 PRICE_EXCD 맵에 없는 종목도 NAS→NYS→AMX 자동 탐색
5. 에러 시 해당 종목 skip하고 다음 진행 (기존 바이낸스 패턴과 동일)

### 완료 기준

```bash
# 1. 문법 검사
node --check bots/investment/scripts/update-unrealized-pnl.js

# 2. 수동 실행 (DEV에서는 paper=false 포지션이 없어도 OK)
node bots/investment/scripts/update-unrealized-pnl.js

# 3. config.yaml max_daily_trades 확인
grep "max_daily_trades" bots/investment/config.yaml
```

### 커밋 메시지

```
fix(luna): P1 잔여 — max_daily_trades 상향 + unrealized_pnl KIS 연동

- config.yaml: binance 16→20, kis/overseas 12→16, 기본값 10→12
- update-unrealized-pnl.js: KIS 국내(getDomesticPrice) + 해외(getOverseasPrice) 연동
- 18건 중 6건만 갱신 → 18건 전체 갱신 가능
```
