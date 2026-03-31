# Community-driven Autotrading Improvements - 2026-03-16

## 목적

- 자동매매 엔진의 성능을 커뮤니티에서 검증된 개선 기법 기준으로 재해석한다.
- 우리 구조(루나 → 네메시스 → 헤파이스토스)에 맞게 변환한다.
- 일일/주간 일지와 연결해, 2026년 4월 중순 실전매매 가능 수준까지 단계적으로 개선한다.

## 참고한 커뮤니티/문서

- QuantConnect Walk Forward Optimization  
  https://www.quantconnect.com/docs/v2/writing-algorithms/optimization/walk-forward-optimization
- QuantConnect Liquidity Universes  
  https://www.quantconnect.com/docs/v2/writing-algorithms/universes/equity/liquidity-universes
- QuantConnect forum - Dynamic Position Sizing Based on Risk/Risk Tolerance  
  https://www.quantconnect.com/forum/discussion/8083/dynamic-position-sizing-based-on-risk-risk-tolerance/
- QuantConnect forum - Adaptive Volatility (position sizing)  
  https://www.quantconnect.com/forum/discussion/3082/adaptive-volatility-aka-position-sizing/
- QuantConnect forum - Algorithm is trading too often  
  https://www.quantconnect.com/forum/discussion/3548/algorithm-is-trading-too-often/
- QuantConnect forum - multiple Alphas trade on unanimous signals  
  https://www.quantconnect.com/forum/discussion/14640/algorithm-framework-with-multiple-alphas-trade-on-unanimous-signals/
- Reddit algotrading - in-sample / out-of-sample / walk-forward 관련 토론  
  https://www.reddit.com/r/algotrading/comments/1diowgj

## 커뮤니티 인사이트를 우리 구조로 번역한 내용

### 1. Walk-forward식 임계치 재조정

커뮤니티 공통점:
- 고정 파라미터는 시장 구간이 바뀌면 금방 낡는다.
- 하지만 너무 자주 재최적화하면 과최적화 위험이 커진다.

우리에게 맞는 형태:
- 루나 `minSignalScore`, `MIN_CONFIDENCE`를 일별이 아니라 주간 단위로 재검토
- 일일 일지에서는 후보 변경안만 기록
- 실제 파라미터 변경은 주간 리뷰에서만 반영

### 2. Universe selection 강화

커뮤니티 공통점:
- 단순 방향성보다 `유동성`, `거래대금`, `노이즈`, `추세 지속성`을 같이 봐야 성능이 오른다.

우리에게 맞는 형태:
- 암호화폐 종목 선정에 `단기 관심도`만 쓰지 말고
  - 유동성
  - 변동성
  - 최근 실패율
  - 스프레드/체결 가능성
를 같이 반영
- 종목 선정은 별도 점수로 일지에 기록

### 3. HOLD/abstain의 품질 관리

커뮤니티 공통점:
- 신호를 많이 내는 것보다, 잘 쉬는 전략이 중요하다.
- 다만 HOLD가 지나치면 실행 엔진이 죽는다.

우리에게 맞는 형태:
- 분석가별 HOLD 비율과 루나 최종 HOLD 비율을 일지에 기록
- `헤파이스토스 0개 신호` 빈도를 추적
- HOLD가 과도하면 threshold 또는 종목 선정 기준을 조정

### 4. 다중 신호 합의의 품질 관리

커뮤니티 공통점:
- 여러 alpha의 unanimous/consensus는 유용하지만, 너무 빡빡하면 신호가 사라진다.

우리에게 맞는 형태:
- 전원 합의만 보지 않고
  - 강한 반대가 없는 BUY
  - 핵심 분석가(아리아/오라클)의 동의
  - 소피아/헤르메스는 보조 확인
같은 계층형 합의 구조 검토

### 5. 리스크 기반 포지션 사이징

커뮤니티 공통점:
- 고정 비중보다 stop distance/volatility 기반 사이징이 안정적이다.

우리에게 맞는 형태:
- 헤파이스토스 포지션 크기를
  - confidence
  - ATR/변동성
  - stop distance
기준으로 더 세밀하게 조절
- 현재는 포지션 수/총자산 비중 위주라, 다음 단계에서 확장 후보

### 6. 거래 빈도 제어

커뮤니티 공통점:
- 거래가 잦으면 수수료와 슬리피지로 성과가 훼손된다.

우리에게 맞는 형태:
- 동일 심볼 재진입 cooldown
- 같은 사이클 내 중복 BUY 차단
- stale 신호 조기 정리
- 일지에 `거래 과다/과소` 여부를 같이 기록

### 7. 일지 중심 개선 루프

커뮤니티 공통점:
- 전략 성능을 올리는 핵심은 “좋은 일지 + 좋은 회고”다.

우리에게 맞는 형태:
- 일일 일지에 아래를 고정 기록
  - 저장된 신호 수
  - status 분포
  - 분석가 판단 분포
  - 주요 차단/실패 사유
  - trade_review 요약
- 주간 리뷰에서 이 누적 데이터를 보고 threshold/선정/리스크를 수정

## 이번 즉시 반영

### 코드

- `bots/investment/scripts/trading-journal.js`
  - `신호 퍼널 / 판단 품질` 섹션 추가
  - 포함 항목:
    - 저장된 신호의 action/status 분포
    - 분석가별 판단 분포
    - 주요 차단/실패 사유

### 목적

- 지금까지는 거래/손익 중심 일지였다.
- 이제는 `왜 신호가 저장되지 않았는지`, `누가 HOLD를 만들었는지`, `무슨 사유로 막혔는지`를 추적할 수 있다.

## 다음 적용 후보

1. 주간 리뷰에 `종목 선정 품질` 섹션 추가
2. 신호-실행-결과 퍼널을 일별 차트화
3. 미추적 자산(BTC) 흡수 여부를 일지에 포함
4. 루나 합의 구조를 계층형 가중 합의로 완화
5. ATR/stop distance 기반 포지션 사이징 실험
