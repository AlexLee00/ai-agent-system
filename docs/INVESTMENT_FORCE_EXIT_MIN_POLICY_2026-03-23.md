# 투자팀 Force-Exit 최소 정책안 (2026-03-23)

## 1. 목적

- 현재 투자팀의 핵심 운영 리스크는 **진입 부족**이 아니라 **장기 미결 LIVE 포지션 누적**이다.
- 본 문서는 force-exit 레일이 아직 없는 상태에서, 시장별 최소 정리 기준을 먼저 고정하기 위한 정책 초안이다.
- 목표는 수익 극대화가 아니라 다음 3가지를 회복하는 것이다.
  1. 장기 미결 포지션 누적 방지
  2. closed trade / closed review 샘플 확보
  3. LIVE 확대 전 운영 안정성 회복

## 2. 현재 운영 현실

2026-03-23 기준 장기 미결 LIVE 포지션:

- `binance`
  - `ROBO/USDT` `101.3h`
- `kis`
  - `375500` `75.5h`
  - `006340` `72.5h`
- `kis_overseas`
  - `ORCL` `278.0h`
  - `HIMS` `256.0h`
  - `NBIS` `256.0h`
  - `NVTS` `256.0h`

현재 실행 구조:

- `hephaestos.js`
  - crypto BUY/SELL 실행 경로 존재
  - TP/SL 보호 주문 경로 존재
- `hanul.js`
  - 국내/해외 BUY/SELL 실행 경로 존재
  - SELL 신호가 와야만 청산
- `force_exit`
  - report/query에서는 기대
  - 실제 실행 레일은 아직 없음

즉 현재 상태는:

- **crypto**: 보호 주문 경로는 있으나, 장기 미결 관리 레일은 불충분
- **domestic / overseas**: SELL 신호 의존 구조라 장기 미결이 누적되기 쉬움

## 3. 정책 목표

### 지금 당장 필요한 구조

- 시장별 **최소 보유시간 상한**을 둔다
- 상한을 넘으면 `force_exit 후보`로 분류한다
- force-exit는 바로 전면 자동화하지 않고, 아래 2단계로 진행한다
  1. health/report에서 경고
  2. 실행 레일에서 최소 자동 정리

### 나중에 확장할 구조

- 시장별 `force-exit policy engine`
- `time stop`, `risk stop`, `session close cleanup`, `protective exit reconciliation`
- 테넌트/브로커별 threshold 분기

## 4. 시장별 최소 정책안

### 4-1. 암호화폐 (`binance`)

기준:

- `paper=false`
- `trade_mode='normal'`
- `age_hours >= 48`

정책:

1. `TP/SL 보호 주문 성공 상태`가 확인되지 않은 포지션은 우선 정리 후보
2. `age_hours >= 48`면 `force_exit_candidate`
3. `age_hours >= 72`면 `strong_force_exit_candidate`

실행 우선순위:

- 1순위: `tp_sl_set=false` 또는 `tp_sl_mode is null`
- 2순위: 장기 보유 + 소액 잔존 포지션
- 3순위: 신규 LIVE probe를 막고 있는 슬롯 점유 포지션

현재 적용 예:

- `ROBO/USDT 101.3h` → 즉시 정리 후보

### 4-2. 국내장 (`kis`)

기준:

- `paper=false`
- `trade_mode='normal'`
- `age_hours >= 48`

정책:

1. `age_hours >= 48`면 `force_exit_candidate`
2. 장 마감 이후에도 같은 포지션이 2거래일 이상 남아 있으면 정리 우선순위 상향
3. 대형 포지션은 금액 기준으로도 우선순위 부여

실행 우선순위:

- 1순위: `position_value` 큰 종목
- 2순위: `age_hours` 큰 종목
- 3순위: 동일 섹터/중복 포지션

현재 적용 예:

- `006340 72.5h / 2,696,200원`
- `375500 75.5h / 444,500원`

둘 다 즉시 정리 후보

### 4-3. 해외장 (`kis_overseas`)

기준:

- `paper=false`
- `trade_mode='normal'`
- `age_hours >= 72`

정책:

1. `age_hours >= 72`면 `force_exit_candidate`
2. `age_hours >= 120`면 `strong_force_exit_candidate`
3. 시장 세션이 반복적으로 지나도 포지션이 남아 있으면 우선 정리

실행 우선순위:

- 1순위: `age_hours` 큰 순
- 2순위: 포지션 가치 큰 순
- 3순위: review가 전혀 없는 오래된 포지션

현재 적용 예:

- `ORCL 278.0h`
- `HIMS 256.0h`
- `NBIS 256.0h`
- `NVTS 256.0h`

전부 즉시 정리 후보

## 5. 최소 실행 정책

### Phase A. 경고/리포트

완료:

- `health-report.js`에서 `stale live positions` 경고 추가

역할:

- 운영자가 정리 대상을 즉시 식별
- force-exit 설계 전에도 active risk를 표준화

### Phase B. 수동/반자동 정리 레일

권장:

1. `force-exit candidate report`
   - exchange
   - symbol
   - age_hours
   - position_value
   - candidate_level
2. 운영자가 검토 후 명시적으로 정리

이 단계의 목적:

- 자동 청산 전 review 샘플 확보
- 잘못된 강제 청산 리스크 완화

### Phase C. 최소 자동 force-exit

권장 순서:

1. `kis_overseas`
   - 가장 오래 묵은 4건부터
2. `kis`
   - `006340`, `375500`
3. `binance`
   - `ROBO/USDT`

자동 force-exit는 아래 조건에서만 허용:

- LIVE health 정상
- 거래소 시장 열림
- 동일 심볼에 신규 BUY pending 없음
- 최근 30분 내 동일 심볼 force-exit 미실행

## 6. 상태값 계약

리포트/원장/리뷰가 기대하는 종료 상태를 실행도 실제로 생성해야 한다.

권장 종료 상태:

- `sell`
  - 일반 SELL 신호 청산
- `tp_hit`
  - TP로 종료
- `sl_hit`
  - SL로 종료
- `force_exit`
  - 시간상한/세션정리/운영정리 기준 강제 종료

현재 문제:

- report는 `force_exit`를 기대하지만
- 실행 코드는 거의 `sell`만 만든다

다음 구현 phase의 목적:

- `force_exit`를 실제 실행 코드와 journal에 생성

## 7. 운영 게이트와의 관계

이 정책은 LIVE 확대 정책보다 우선한다.

운영 게이트:

1. 장기 미결 포지션이 누적되면 LIVE 확대 금지
2. closed trade / closed review가 부족하면 LIVE 확대 금지
3. TP/SL 보호 주문 실표본이 없으면 crypto LIVE 확대 금지

즉 현재 운영 판단:

- `crypto LIVE 확대 = 금지`
- `domestic LIVE 확대 = 보류`
- `overseas LIVE 확대 = 금지`

## 8. 다음 구현 순서

1. `force-exit candidate report` 추가
2. `hanul.js`
   - 국내/해외 force-exit 최소 실행 경로 추가
3. `hephaestos.js`
   - 장기 미결 + 보호 미확인 포지션 정리 기준 추가
4. `trade_journal`
   - `exit_reason='force_exit'` 표준화
5. `weekly-trade-review`
   - force-exit 결과가 실제 closed review로 쌓이는지 확인

## 9. 판단

- 이 문서는 **전면 자동청산 설계서가 아니라, 최소 운영 정책안**이다.
- 내부 MVP 기준으로는 이 정도 보수 정책이 가장 적절하다.
- 이후 SaaS 확장 시에는 브로커/시장별 capability 차이를 반영한 정교한 policy engine으로 발전시키면 된다.
