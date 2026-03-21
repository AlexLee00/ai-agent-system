# 암호화폐 자동매매 튜닝 제안서 + LIVE 전환 게이트

> 작성일: 2026-03-22  
> 대상: 루나 암호화폐 자동매매 레일 (`NORMAL`, `VALIDATION`)  
> 목적: 오늘 자동매매 일지 기준으로 신호 퍼널 병목을 정리하고, `PAPER -> LIVE` 전환 조건을 명확히 고정한다.

---

## 1. 결론

- 현재 암호화폐 자동매매는 **거래는 발생하지만 전부 `PAPER`**다.
- 오늘 기준으로 `VALIDATION`은 **승격 후보**로 읽히지만, **즉시 LIVE 전환은 아직 이르다**.
- 지금 당장 필요한 구조는:
  1. `onchain` BUY 편향 완화
  2. `weakSignalSkipped` 세부 원인 분해
  3. `position_reentry_blocked` 정책 보정
  4. `PAPER` 거래 품질을 기준으로 한 **LIVE 승격 게이트 고정**

코덱 권고:
- **지금은 LIVE 전환 보류**
- 먼저 `3~5 사이클` 또는 `1~2일` 추가 관찰 후,
- 아래 문서의 게이트를 만족하면 그때 `NORMAL`부터 제한형 LIVE 전환을 검토한다.

---

## 2. 관측 사실

기준 리포트:
- [trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)

오늘(2026-03-22) 기준 핵심 사실:

### 2.1 거래 결과

- 총 executed trades: `11건`
- 전부 `BUY`
- 전부 `PAPER`
- 시장: `암호화폐`
- 운영모드 분포:
  - `NORMAL`: 4건
  - `VALIDATION`: 7건

대표 체결:
- `STRK/USDT`
- `SIGN/USDT`
- `FXS/USDT`
- `ANKR/USDT`
- `RDNT/USDT`
- `FIL/USDT`
- `NIGHT/USDT`
- `PHA/USDT`

### 2.2 decision 퍼널

- decision: `195건`
- BUY: `47건`
- SELL: `0건`
- HOLD: `2건`
- approved: `21건`
- executed: `11건`
- weakSignalSkipped: `26건`
- riskRejected: `0건`

### 2.3 analyst 판단 분포

- `news`: `195건` 중 `HOLD 194 / SELL 1`
- `onchain`: `195건` 중 `BUY 195`
- `sentiment`: `195건` 중 `HOLD 153 / SELL 42`
- `ta_mtf`: `195건` 중 `BUY 4 / HOLD 184 / SELL 7`

### 2.4 실패/차단 사유

- 실패 코드:
  - `position_reentry_blocked: 4건`
- 주요 차단 사유:
  - 동일 LIVE 포지션 보유 중 — 추가매수 차단
  - 동일 NORMAL PAPER 포지션 보유 중 — 추가매수 차단

### 2.5 validation 상태

- `VALIDATION`: decision `91`, BUY `25`, approved `9`, executed `7`
- `VALIDATION` 체결도 전부 `PAPER`
- 현재 일지 출력 기준 `암호화폐: 승격 후보`

### 2.6 비용

- 총 토큰: `515,665`
- 총 비용: `$0.3376`

---

## 3. 추론 원인

### 3.1 `onchain` 단독 편향이 너무 강함

현재 분포는 사실상:
- `onchain = BUY`
- `news/sentiment/ta_mtf = HOLD 또는 일부 SELL`

즉 엔진은 다중 분석기 합의라기보다,
실제로는 `onchain`이 BUY를 만들고 나머지가 강하게 못 막는 구조에 가깝다.

의미:
- 상승장에선 후보를 잘 찾을 수 있지만,
- 횡보장/노이즈장에선 과매수 편향이 커질 수 있다.

### 3.2 `weakSignalSkipped`가 높아 신호 결합기가 거침

`decision 195 -> BUY 47 -> approved 21 -> executed 11`로 줄어드는 과정에서
`weakSignalSkipped 26`이 크게 보인다.

의미:
- BUY까지는 나오는데,
- 결합기나 후단 승인 정책이 “애매한 신호”를 많이 버린다.

이건 나쁜 것만은 아니지만,
현재는 왜 약한지 세부 원인이 충분히 구조화돼 있지 않다.

### 3.3 `position_reentry_blocked`가 실제 체결을 깎음

현재 4건이 `position_reentry_blocked`로 실패했다.

의미:
- 퍼널 앞단은 BUY를 만들었는데
- 후단 포지션 정책이 재진입을 막아 실제 실행 수가 줄어들었다.

현재 구조는 “과매매 방지”에는 좋지만,
유효한 scale-in까지 과하게 막을 가능성이 있다.

### 3.4 `PAPER`만으로는 아직 LIVE 품질이 증명되지 않음

오늘 체결은 활발하지만,
- 전부 `PAPER`
- 실현 손익 없음
- 미결 포지션 다수

즉 지금은 “실행 가능성”은 보이지만,
**실전 체결 품질과 청산 품질**은 아직 충분히 검증되지 않았다.

---

## 4. 튜닝 제안

### A. `onchain` BUY 편향 완화

지금 당장 필요한 구조:
- `onchain` 단독 BUY를 그대로 밀지 말고,
- `news/sentiment/ta_mtf`와 최소 합의 규칙을 추가 검토

권장안:
1. `onchain BUY` 단독이면 starter confidence를 소폭 깎기
2. `news HOLD + sentiment SELL` 조합이면 BUY 강도를 낮추기
3. `ta_mtf`가 BUY가 아닐 때는 aggressive starter 승인을 억제

나중에 확장할 구조:
- analyst별 calibration weight를 성과 기반으로 자동 보정

### B. `weakSignalSkipped` 세부 사유 분해

지금 당장 필요한 구조:
- `weakSignalSkipped`를 한 코드로 두지 말고,
  - consensus_low
  - confidence_low
  - analyst_conflict
  - starter_gate_failed
같은 세부 사유로 분해

권장안:
1. `pipeline_runs.meta` 또는 신호 리뷰 원장에 세부 skip reason 저장
2. 일지/주간 리뷰에서 세부 skip reason 상위 3개를 출력

1차 반영 완료:
- `pipeline_runs.meta`에 `weak_signal_reason_top`, `weak_signal_reasons`를 저장하도록 보강
- 현재 분류 기준:
  - `confidence_near_threshold`
  - `confidence_mid_gap`
  - `confidence_far_below_threshold`
- `trading-journal.js`, `weekly-trade-review.js`, `runtime-config-suggestions.js`가 새 필드를 읽도록 연결 완료
- 주의: 기존 과거 meta에는 새 필드가 없으므로, 의미 있는 `weakTop`은 다음 파이프라인 실행부터 누적된다

나중에 확장할 구조:
- analyst 조합별 전환율 비교

### C. `position_reentry_blocked` 정책 보정

지금 당장 필요한 구조:
- 재진입을 “무조건 차단”이 아니라 상태 기반으로 세분화

권장안:
1. `동일 심볼 / 동일 액션 / 동일 trade_mode` 차단은 유지
2. 다만 아래는 완화 검토
   - 기존 포지션이 매우 작을 때 추가 진입 허용
   - 일정 시간 경과 후 재진입 허용
   - validation에서는 reentry 기준을 normal보다 조금 더 완화

1차 반영 완료:
- execution bot block code를 아래처럼 분리
  - `paper_position_reentry_blocked`
  - `live_position_reentry_blocked`
- 목적은 threshold 조정보다 먼저, 실제 병목이
  - PAPER 검증 포지션 과밀인지
  - LIVE 실포지션 보유 상태인지
를 운영 리포트에서 분리해 읽게 만드는 것이다

나중에 확장할 구조:
- scale-in 전용 정책
- position age / unrealized / exposure 기반 재진입 허용

### D. `PAPER` 품질 관찰 강화

지금 당장 필요한 구조:
- 단순 executed 수보다
  - symbol diversity
  - hold time
  - exit quality
  - realized outcome
를 같이 봐야 함

권장안:
1. `decision -> approved -> executed -> closed` 퍼널 지표 추가
2. `PAPER` 체결 후 청산까지 이어지는 품질 리뷰 보강
3. 1일 단위가 아니라 3~7일 집계로 변동성 완화

---

## 5. LIVE 전환 게이트

### 5.1 현재 판정

- **지금은 LIVE 전환 금지**

이유:
1. 오늘 암호화폐 거래는 전부 `PAPER`
2. `SELL/청산` 품질 데이터가 거의 없음
3. `position_reentry_blocked`와 `weakSignalSkipped` 구조를 아직 손보지 않음
4. 실현 손익 기반 검증이 부족함

1차 자동 리뷰 기준:
- [crypto-live-gate-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/crypto-live-gate-review.js) 최근 3일 출력 기준
  - decision `2236`
  - BUY `344`
  - approved `247`
  - executed `48`
  - 체결 `48건`, 전부 `PAPER`
  - weakSignalSkipped `99`
  - 종료 거래 리뷰 `0건`
- 즉 신호/체결 활력은 충분하지만, **청산 품질과 LIVE 체결 데이터가 없어 게이트는 여전히 `blocked`**다

### 5.2 최소 승격 조건

아래를 만족해야 `NORMAL` 제한형 LIVE 전환 검토 가능:

1. `3~5 사이클` 또는 `1~2일` 추가 관찰
2. 암호화폐 `VALIDATION`에서:
   - executed `>= 5`
   - 고유 심볼 `>= 3`
   - 전부 한 심볼 편중이 아님
3. `weakSignalSkipped` 세부 원인 상위가 파악됨
4. `position_reentry_blocked` 정책이 의도된 차단인지 검증됨
5. 가능하면 최소 `1개 이상` 청산 사례 확보
6. health / launchd / broker 경계가 안정적

### 5.3 강한 승격 조건

아래까지 만족하면 `NORMAL LIVE`를 더 강하게 검토 가능:

1. validation executed가 2일 연속 안정적
2. symbol diversity 유지
3. 청산 데이터 포함
4. 비용 대비 executed 품질이 유지
5. 동일 차단 코드(`position_reentry_blocked`) 과다 발생이 완화

### 5.4 실제 전환 순서

지금 당장 필요한 구조:
1. `VALIDATION`은 계속 `PAPER`
2. `NORMAL`만 제한형 LIVE 후보로 검토
3. first live는 소액 / 소심볼 / 보수 threshold

권장 단계:
1. `VALIDATION PAPER` 추가 관찰
2. 튜닝 1차 반영
3. 다시 일지/주간 리뷰 확인
4. `NORMAL` 제한형 LIVE
5. 1일 관찰 후 확대 여부 결정

즉 코덱 권고는:
- **validation을 바로 LIVE로 올리는 게 아니라**
- **normal의 제한형 LIVE를 나중에 검토**하는 순서가 더 안전하다.

---

## 6. 실행 체크리스트

### 즉시 할 일

1. `weakSignalSkipped` 세부 분류 설계
2. `position_reentry_blocked` 정책 세분화 검토
3. analyst별 전환율 비교
4. `PAPER` 청산 품질 관찰 항목 추가

### 관찰 명령

```bash
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js --dry-run
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js --days=7
```

---

## 7. 최종 권고

- 현재 암호화폐는 **`PAPER` 거래가 맞다**
- 오늘 리포트는 **validation 승격 후보** 신호는 준다
- 하지만 아직 **LIVE 전환 근거로는 부족하다**

코덱 최종 판단:
- **지금은 튜닝 → 추가 관찰 → 제한형 LIVE 검토**
순서가 맞다.
- “모든 작업이 끝나면 LIVE 전환”은 가능하지만,
그 “모든 작업”에는 최소한 이 문서의 **승격 게이트 충족**이 포함되어야 한다.
