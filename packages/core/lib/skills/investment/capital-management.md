# Capital Management

## 목적
루나팀의 자본관리 규칙을 문서화한다.
주요 영역은 가용 자본 계산, 동적 최소주문금액, 포지션 사이징, 일일/주간 가드다.

## 입력/출력
- 입력:
  - `exchange`
  - `tradeMode`
  - `signal`
  - 계좌 잔고 / 포지션 / 최근 손익
- 출력:
  - 가용 자본
  - 동적 최소주문금액
  - 사이징 결과
  - 거래 가능 여부와 차단 사유

## 핵심 함수 API
- `getCapitalConfig(exchange?, tradeMode?)`
- `getAvailableUSDT()`
- `getAvailableBalance(exchange?)`
- `getMarketAvailableFunds(exchange?)`
- `getDynamicMinOrderAmount(exchange?, tradeMode?)`
- `calculatePositionSize(signal, opts?)`
- `preTradeCheck(signal, opts?)`
- `checkCircuitBreaker(exchange?, opts?)`
- `formatDailyTradeLimitReason(dailyTrades, maxDailyTrades)`

## 핵심 규칙
- 최소주문금액은 `보유금의 비율`과 `폴백 최소금액` 중 큰 값을 사용한다.
- 시장별 기본 정책:
  - 국내장 `kis`: 정수 주수
  - 국외장 `kis_overseas`: mock 경로 소수점 허용
  - 암호화폐 `binance`: 소수점 허용
- 거래소/모드별 설정은 `config.yaml capital_management`를 우선한다.
- 잔고 조회 실패 시 폴백 최소금액을 사용한다.
- 서킷 브레이커와 일일 손실 제한은 매매 전에 항상 체크한다.

## 사용 예시
```ts
import {
  getDynamicMinOrderAmount,
  preTradeCheck,
} from '../../../../bots/investment/shared/capital-manager.ts';

const minOrder = await getDynamicMinOrderAmount('binance', 'normal');
const guard = await preTradeCheck(signal, { exchange: 'binance' });

if (!guard.allowed) {
  console.log(guard.reason);
}
```

## 운영 포인트
- `dynamic_min_order`는 테스트 환경에서도 동작하지만, 실제 값은 잔고 조회 성공 여부에 따라 달라진다.
- 로그 키워드:
  - `dynamic_min_order`
  - `daily trade limit`
  - `circuit breaker`

## 소스 경로
- `/Users/alexlee/projects/ai-agent-system/bots/investment/shared/capital-manager.ts`
