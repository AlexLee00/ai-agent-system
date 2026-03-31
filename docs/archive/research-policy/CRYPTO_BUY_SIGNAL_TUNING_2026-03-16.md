# Crypto BUY Signal Tuning - 2026-03-16

## 배경

- 최근 암호화폐 팀은 분석가 BUY 의견은 존재했지만, 실제 저장되는 BUY 신호가 매우 적었다.
- 실행 로그 기준으로 헤파이스토스는 반복적으로 `이번 사이클: 0개 신호` 상태였다.
- 미추적 BTC 잔고가 남아 있는데도 BUY 실행 트리거가 거의 없어 흡수 로직이 발동하지 못했다.

## 확인한 병목

1. 루나 포트폴리오 결정 단계에서 HOLD 비중이 높다.
2. 실제 실행 게이트는 `getMinConfidence(exchange)`보다 `time-mode ACTIVE.minSignalScore` 영향을 더 크게 받는다.
3. 현재 ACTIVE 시간대 binance 최소 신호 점수는 `0.60`이라, borderline BUY가 신호 저장까지 올라오기 어렵다.
4. 루나 시스템 프롬프트도 `confidence 0.55 미만이면 반드시 HOLD`를 강하게 요구하고 있었다.

## 이번 1차 조정

### 코드 변경

- `bots/investment/shared/time-mode.js`
  - ACTIVE `minSignalScore: 0.60 -> 0.58`
- `bots/investment/team/luna.js`
  - `MIN_CONFIDENCE.binance: 0.55 -> 0.52`
  - `PAPER_MIN_CONFIDENCE.binance: 0.50 -> 0.48`
  - 루나 시스템 프롬프트 기준
    - `confidence 0.55 미만이면 반드시 HOLD`
    - `-> confidence 0.52 미만이면 반드시 HOLD`

## 변경 원칙

- 한 번에 크게 낮추지 않는다.
- ACTIVE 구간만 소폭 완화한다.
- SLOWDOWN/NIGHT_AUTO는 그대로 유지한다.
- 포지션 수, 포지션 비중, 일손실 한도는 건드리지 않는다.

## 추적 포인트

다음 24~48시간 동안 아래 항목을 확인한다.

1. `BUY/STRONG_BUY` 신호 생성 수
2. `approved` 전환 수
3. `failed`, `expired`, `nemesis_error_pending_stale` 재발 여부
4. 헤파이스토스 로그의 `이번 사이클: 0개 신호` 빈도
5. 미추적 BTC 흡수 여부
6. 과도한 진입 증가 여부

## 롤백 기준

아래 중 하나가 보이면 원복 또는 추가 조정 검토:

- 저신뢰 BUY가 급증
- `failed/rejected` 비율 급증
- 포지션 과밀
- 일손실/서킷브레이커 빈도 증가

## 다음 후보 조정안

1. ACTIVE `minSignalScore 0.58 -> 0.56`
2. 루나 포트폴리오 프롬프트에서 HOLD 문구를 더 완화
3. 미추적 BTC 흡수를 BUY 신호와 분리한 별도 정리 루프 도입
