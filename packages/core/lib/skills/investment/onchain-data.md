# Onchain Data

## 목적
루나팀에서 공통으로 쓰는 바이낸스 선물 공개 데이터 수집 규약을 정리한다.
대상은 펀딩레이트, 미결제약정, 글로벌 롱숏비율, 그리고 이들을 묶은 요약 함수다.

## 입력/출력
- 입력:
  - `symbol` 예: `BTCUSDT`
  - `period?` 예: `1h`
  - `limit?`
- 출력:
  - `getFundingRate`: `{ symbol, fundingRate, fundingRatePct, nextFundingTime, markPrice } | null`
  - `getOpenInterest`: `{ symbol, openInterest } | null`
  - `getLongShortRatio`: `{ longShortRatio, longAccount, shortAccount } | null`
  - `getOnchainSummary`: 종합 요약 객체

## 핵심 함수 API
- `getFundingRate(symbol)`
- `getOpenInterest(symbol)`
- `getLongShortRatio(symbol, period = '1h', limit = 1)`
- `getOnchainSummary(symbol)`

## 사용 규칙
- 모두 Binance Futures 공개 API를 사용한다.
- API 키 없이 조회 가능해야 한다.
- 조회 실패 시 예외보다 `null` 또는 축약 요약으로 처리한다.
- `getOnchainSummary`는 펀딩/롱숏 과열 신호를 사람이 읽기 쉬운 label로 함께 반환한다.

## 사용 예시
```ts
import { getOnchainSummary } from '../../../../bots/investment/shared/onchain-data.ts';

const summary = await getOnchainSummary('BTCUSDT');
```

## 주의사항
- 네트워크 제한 환경에서는 공개 API라도 실패할 수 있다.
- 이 스킬은 데이터 수집 규약 문서다. 실제 매수/매도 해석은 오라클/루나 판단 레이어가 담당한다.

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/onchain-data.ts`

