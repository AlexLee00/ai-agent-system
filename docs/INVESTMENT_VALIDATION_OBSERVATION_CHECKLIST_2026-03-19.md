# Investment Validation Observation Checklist

> 작성일: 2026-03-19
> 목적: `ai.investment.crypto.validation` 검증거래 레일을 3~5 사이클 관찰하면서, `normal` KPI와 섞이지 않게 성공/실패를 판정하기 위한 운영 체크리스트

---

## 1. 결론

- validation 레일은 이제 실제로 launchd, `trade_mode`, 퍼널 메트릭, 일지/주간 리뷰까지 연결된 상태다.
- 다음 단계는 추가 구현보다 **3~5 사이클 관찰**이다.
- 관찰의 목적은 아래 세 가지다.
  1. validation이 실제로 `BUY / approved / executed`를 만드는가
  2. validation이 normal KPI를 오염시키지 않고 별도 관측되는가
  3. validation 정책 중 normal로 승격할 항목이 있는가

---

## 2. 관찰 범위

### 대상 서비스

- normal 레일
  - `ai.investment.crypto`
- validation 레일
  - `ai.investment.crypto.validation`

### 대상 로그

- normal
  - `/tmp/investment-crypto.log`
  - `/tmp/investment-crypto.err.log`
- validation
  - `/tmp/investment-crypto-validation.log`
  - `/tmp/investment-crypto-validation.err.log`

### 대상 리포트

- [trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

### 대상 데이터

- `signals.trade_mode`
- `trades.trade_mode`
- `trade_journal.trade_mode`
- `pipeline_runs.meta.investment_trade_mode`

---

## 3. 반드시 확인할 KPI

### A. 레일 분리 KPI

- validation 로그에 `investmentMode=VALIDATION [VALIDATION]`가 찍히는가
- 일지/주간 리뷰 퍼널에 `mode NORMAL X / VALIDATION Y`가 분리되어 보이는가
- validation 레일이 normal 레일 쿨다운과 독립적으로 움직이는가
  - `investment-state-validation.json` 기준

### B. 퍼널 KPI

- validation `decision_count`
- validation `buy_decisions`
- validation `approved_signals`
- validation `executed_symbols`
- validation `weakSignalSkipped`
- validation `riskRejected`

### C. 실행 KPI

- validation 거래가 실제로 생기는가
- 거래 발생 시 `LIVE / PAPER`가 무엇인가
- 거래 레코드에 `[VALIDATION]` 태그가 붙는가

### D. 비용/효율 KPI

- validation이 `BUY 0`만 반복하지 않는가
- validation 비용 증가 대비 승인/실행이 전혀 없는 상태가 지속되는가
- validation이 normal보다 더 작은 손실 반경에서 더 많은 후보를 검증하는가

---

## 4. 실패 패턴 판정

### 실패 패턴 1: 레일만 분리되고 실제 효과 없음

조건:
- `mode VALIDATION`은 보이지만
- 3~5 사이클 동안 `buy_decisions = 0` 또는 `approved_signals = 0`만 반복

해석:
- validation 레일은 존재하지만 실험 가치가 약함
- `nemesis` 또는 `luna` fallback이 여전히 너무 보수적일 수 있음

### 실패 패턴 2: 수집 노드 실패가 지속

조건:
- validation 로그에 `L03/L04/L05 failed`가 반복

해석:
- news / sentiment / onchain 입력 품질 또는 외부 API/네트워크 의존성이 validation 결과를 왜곡
- 이 경우 risk 정책보다 먼저 수집 신뢰성 점검 필요

### 실패 패턴 3: 승인되지만 실행 안 됨

조건:
- `approved_signals > 0`
- `executed_symbols = 0`

해석:
- `nemesis`는 통과
- `hephaestos` 또는 broker/execution 경계 재점검 필요

### 실패 패턴 4: PAPER만 반복

조건:
- validation 거래는 생기지만 전부 `paper=true`

해석:
- reserve / min-order / capital rescue / broker 보호정책이 여전히 live를 막고 있음

---

## 5. 성공 패턴 판정

validation을 성공으로 볼 최소 기준:

- 3~5 사이클 내
  - `BUY > 0`
  - `approved_signals > 0`
  - 가능하면 `executed > 0`
- 일지/주간 리뷰에서 validation이 normal과 분리 집계됨
- validation 로그에서 `investmentMode=VALIDATION [VALIDATION]`가 안정적으로 유지됨

강한 성공 기준:

- validation에서 반복적으로 `approved/executed`가 발생
- normal보다 작은 리스크 프로파일로도 유의미한 후보 탐색이 가능함
- 이후 normal로 승격 가능한 threshold / starter rule 후보가 식별됨

---

## 6. 운영 절차

### 1차 확인

```bash
launchctl list | egrep 'ai\.investment\.(crypto|crypto\.validation|commander|reporter)'
tail -n 120 /tmp/investment-crypto-validation.log
tail -n 120 /tmp/investment-crypto-validation.err.log
```

### 2차 리포트 확인

```bash
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js --dry-run
```

### 3차 판정 질문

- validation이 normal과 데이터상 분리되어 보이는가
- validation이 실제 BUY/approved/executed를 만들고 있는가
- validation의 실패 원인은 판단, 리스크, 실행, 외부 입력 중 어디인가

---

## 7. 다음 의사결정

### 유지

- validation이 분리 관측되고
- 유의미한 후보 또는 승인/실행이 생기면
- 3~7일 더 관찰 후 승격 판단

### 보정

- validation이 `BUY는 생기지만 approved/executed`가 약하면
- `nemesis` 또는 `hephaestos`의 validation 전용 정책만 추가 보정

### 중단/재설계

- validation이 3~5 사이클 내내 `HOLD only`이거나
- 수집 실패가 많아 실험 가치가 없으면
- 루나 재점검 Phase 문서 기준으로 부분 보완을 중단하고 재설계 판단으로 전환
