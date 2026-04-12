# Market Regime

## 목적
루나팀에서 공통으로 쓰는 시장 체제 분류 규약을 정리한다.
대상은 `trending_bull`, `trending_bear`, `ranging`, `volatile` 네 가지다.

## 입력/출력
- 입력:
  - `market: 'binance' | 'kis' | 'kis_overseas'`
  - `signals?: { scout?: object }`
- 출력:
  - `getMarketRegime`: `{ regime, confidence, guide, reason, snapshots, bias }`
  - `formatMarketRegime`: `string`

## 핵심 함수 API
- `getMarketRegime(market, signals = {})`
- `formatMarketRegime(regimeResult)`
- `REGIMES`
- `REGIME_GUIDES`

## 사용 규칙
- 시장별 벤치마크를 조회해 bias와 변동성을 함께 본다.
- 해외장은 `VIX`를 추가로 참고한다.
- scout 신호가 있으면 sentiment shift로 보정한다.
- 결과는 체제 이름뿐 아니라 `positionSizeMultiplier`, `tpMultiplier`, `slMultiplier` 같은 운영 가이드까지 포함한다.

## 사용 예시
```ts
import { formatMarketRegime, getMarketRegime } from '../../../../bots/investment/shared/market-regime.ts';

const regime = await getMarketRegime('binance', { scout });
const summary = formatMarketRegime(regime);
```

## 주의사항
- 외부 데이터 소스에 의존하므로 네트워크 제한 환경에선 실패할 수 있다.
- 이 스킬은 체제 해석 규약 문서다. 실제 포지션 sizing은 별도 자본관리 규칙을 따른다.

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/market-regime.ts`

