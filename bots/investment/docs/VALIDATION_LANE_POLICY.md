# 투자팀 Validation / Paper / Live 운영 정책

## 목적

- 이 문서는 투자팀 자동화에서 `trade_mode`, `paper`, `live gate`를 어떻게 해석해야 하는지 현재 기준선을 고정한다.
- 최근 암호화폐 리포트에서 `LIVE 12 / PAPER 0`, `VALIDATION 4건도 LIVE`가 확인되면서, 기존 "`validation = paper 검증`" 해석과 실제 실행 현실이 어긋난 상태를 정리하는 것이 목적이다.

## 핵심 축

투자팀 실행 레일은 아래 두 축이 독립이다.

1. `trade_mode`
- `normal`
- `validation`

2. `paper`
- `true`
- `false`

즉 `validation`과 `paper`는 같은 개념이 아니다.

## 현재 운영 기준

### 1. `normal + live`

- 의미:
  - 일반 실거래 레일
  - 정상 승인된 신호가 운영 예산과 리스크 정책을 통과했을 때 사용하는 기본 레일

### 2. `validation + live`

- 의미:
  - 현재 암호화폐 운영에서는 `validation`이 `PAPER`가 아니라 **소액 LIVE 검증 레일**로 쓰이고 있다.
- 최근 실측:
  - 최근 12건 binance 체결 중 `VALIDATION 4건`이 모두 `paper=false`
  - 대표 예시:
    - `FET/USDT`
    - `CFG/USDT`
    - `RENDER/USDT`
    - `SIGN/USDT`
- 해석:
  - 현재 crypto validation은 “실거래 전 가짜 주문”이 아니라
  - **작은 금액으로 실거래 표본을 쌓는 guarded LIVE 레일**이다.

### 3. `paper + normal|validation`

- 의미:
  - 브로커 실거래 없이 시뮬레이션/연습/검증을 남기는 레일
- 현재 상태:
  - 최근 crypto 집계에서는 표본이 거의 없거나 0건일 수 있다.
  - 즉 paper 레일은 완전히 사라진 개념은 아니지만, 현재 crypto 운영의 주 검증 축은 아니다.

## crypto LIVE gate 해석 기준

### 현재 의미

- `crypto LIVE gate = blocked`는
  - “암호화폐에서 LIVE가 전혀 실행되지 않는다”는 뜻이 아니다.
- 현재 더 정확한 의미:
  - **validation LIVE 표본은 있으나**
  - `PAPER` 검증 표본은 부족하고
  - `near-threshold weak`가 아직 높으며
  - `capital_guard / reentry` 정책 병목도 더 관찰이 필요하다는 뜻이다.

### 운영 문장으로 풀어 쓰면

- 허용 중:
  - `validation + live`의 guarded sample
- 아직 보수적으로 보는 것:
  - crypto `normal + live` 확대
  - LIVE gate 완화 또는 공격적 증설

## 지금 당장 필요한 구조

- health/report에서는 아래를 분리해서 보여준다.
  - `LIVE / PAPER`
  - `NORMAL / VALIDATION`
- gate reason은 아래를 함께 설명해야 한다.
  - `validation LIVE 표본 수`
  - `PAPER 표본 부족 여부`
  - `weak near-threshold`
  - `capital_guard`
  - `reentry`

즉 지금 당장 필요한 구조는
- `validation = paper`로 오해하지 않는 것
- `validation LIVE`를 별도 운영 레일로 인정하는 것이다.

## 나중에 확장할 구조

- 선택지 A. crypto를 계속 `validation LIVE` 중심으로 운영
  - 내부 MVP에서는 가장 단순하고 실용적이다.
- 선택지 B. `PAPER validation` 레일을 다시 복원
  - 더 보수적이지만 운영/리포트 해석은 쉬워진다.
- 선택지 C. 멀티워크스페이스 SaaS 확장 시 risk profile별 분리
  - workspace A: `validation LIVE 허용`
  - workspace B: `PAPER validation 필수`

## 후속 점검 지표

- `NORMAL LIVE / PAPER` 체결 수
- `VALIDATION LIVE / PAPER` 체결 수
- `mid_gap_promoted`
- `mid_gap_executed`
- `mid_gap_rejected_by_risk`
- `capital_guard_rejected`
  - `daily trade limit`
  - `max positions`
  - `validation` 비중
- `paper_position_reentry_blocked`
- `live_position_reentry_blocked`

## 운영 판단 기준

- `validation LIVE` 표본이 쌓여도
  - `weak near-threshold`
  - `capital_guard`
  - `reentry`
가 높으면 즉시 gate 완화로 가지 않는다.
- `PAPER` 표본이 부족하더라도
  - 현재 운영이 `validation LIVE` 중심이라면
  - 리포트는 이를 숨기지 않고 그대로 드러내야 한다.
- 즉 gate는 “LIVE on/off 스위치”가 아니라
  - **검증 표본과 리스크 병목을 종합해 normal live 확대 여부를 판단하는 운영 게이트**로 해석한다.
