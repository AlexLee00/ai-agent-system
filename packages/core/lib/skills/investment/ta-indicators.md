# TA Indicators

## 목적
루나팀에서 공통으로 쓰는 기술지표 계산 규약을 정리한다.
대상은 RSI, MACD, Bollinger Bands, ATR, EMA, SMA다.

## 입력/출력
- 입력:
  - `closes: number[]`
  - `highs: number[]`
  - `lows: number[]`
  - `period`, `stdDev`, `fastPeriod`, `slowPeriod`, `signalPeriod`
- 출력:
  - `calcRSI`: `number | null`
  - `calcMACD`: `{ macd, signal, histogram } | null`
  - `calcBollingerBands`: `{ upper, middle, lower, bandwidth } | null`
  - `calcATR`: `number | null`
  - `calcEMA`: `number | null`
  - `calcSMA`: `number | null`

## 핵심 함수 API
- `calcRSI(closes, period = 14)`
- `calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9)`
- `calcBollingerBands(closes, period = 20, stdDev = 2)`
- `calcATR(highs, lows, closes, period = 14)`
- `calcEMA(closes, period = 20)`
- `calcSMA(closes, period = 20)`

## 사용 규칙
- 입력 길이가 부족하면 `null`을 반환한다.
- 루나팀 상위 파이프라인은 `null`을 “지표 없음”으로 처리해야 한다.
- MACD는 마지막 값 하나만 쓴다.
- Bollinger Bands는 `bandwidth`를 함께 계산한다.
- ATR은 고가/저가/종가 배열 길이가 모두 같아야 한다.

## 사용 예시
```ts
import {
  calcATR,
  calcBollingerBands,
  calcMACD,
  calcRSI,
} from '../../../../bots/investment/shared/ta-indicators.ts';

const rsi = calcRSI(closes, 14);
const macd = calcMACD(closes, 12, 26, 9);
const bb = calcBollingerBands(closes, 20, 2);
const atr = calcATR(highs, lows, closes, 14);
```

## 주의사항
- 지표 계산은 `technicalindicators` 패키지에 의존한다.
- 이 스킬은 “계산 규약” 문서다. 매수/매도 판단 규칙은 별도 전략 문서에서 관리한다.

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/ta-indicators.ts`
