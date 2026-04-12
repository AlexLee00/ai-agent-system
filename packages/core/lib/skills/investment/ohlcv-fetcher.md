# OHLCV Fetcher

## 목적
루나팀의 시세 캔들 수집 규약을 정리한다.
대상은 Binance 기본 수집과 TradingView/Yahoo fallback, PostgreSQL 캐시 사용 방식이다.

## 입력/출력
- 입력:
  - `symbol`
  - `timeframe`
  - `from`
  - `to?`
  - `exchange?`
- 출력:
  - `getOHLCV`: `number[][]`
  - `fetchAndCacheOHLCV`: `number[][]`

## 핵심 함수 API
- `getOHLCV(symbol, timeframe, from, to = null, exchange = 'binance')`
- `fetchAndCacheOHLCV(symbol, timeframe, from, to = null, exchange = 'binance')`
- `ensureOHLCVCacheTable()`

## 사용 규칙
- 기본 공급자는 Binance `ccxt`다.
- Binance fetch 실패 시 TradingView MCP 기반 Yahoo fallback을 시도한다.
- 캐시 DB를 쓸 수 있으면 `ohlcv_cache`를 읽고 쓴다.
- DB가 막혀도 best-effort로 직접 fetch를 계속 시도한다.

## 사용 예시
```ts
import { getOHLCV } from '../../../../bots/investment/shared/ohlcv-fetcher.ts';

const rows = await getOHLCV('BTC/USDT', '1h', '2026-03-01', '2026-03-30');
```

## 주의사항
- `4h` fallback은 Yahoo 쪽에서 우선 `1h` 기준으로 대응한다.
- 캐시와 fallback은 환경 제약에 따라 결과가 달라질 수 있다.
- 실환경 검증 전에는 `dependency_missing`, 네트워크 오류를 정상적인 관찰 결과로 해석해야 한다.

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/ohlcv-fetcher.ts`
- `/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/tradingview-mcp-server.py`

