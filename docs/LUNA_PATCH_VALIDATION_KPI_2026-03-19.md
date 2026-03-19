# 루나 부분 보완 검증 KPI

> 작성일: 2026-03-19  
> 범위: 루나 시스템 부분 보완 검증 단계의 성공/실패 판단 기준  
> 연계 문서:
> - [LUNA_SYSTEM_DIAGNOSIS_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_SYSTEM_DIAGNOSIS_2026-03-19.md)
> - [LUNA_LAYER_BOTTLENECK_REPORT_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_LAYER_BOTTLENECK_REPORT_2026-03-19.md)
> - [LUNA_PATCH_VS_REDESIGN_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_PATCH_VS_REDESIGN_2026-03-19.md)

---

## 1. 결론

루나의 부분 보완 검증은 **짧고 명확하게** 끝내야 한다.

코덱 권고:
- 검증 기간: **1~2일**
- 검증 범위: **바이낸스 우선, 국내장/해외장은 보조 확인**
- 판정 방식: **거래가 실제로 늘었는가**, **거래 후보가 다양해졌는가**, **비용 대비 전환이 좋아졌는가**

이 문서의 목적은 단순 튜닝을 반복하지 않고,
**부분 보완이 실제로 유효한지 / 재설계로 전환해야 하는지**를 빠르게 결정하는 것이다.

---

## 2. 검증 목표

### 2.1 최우선 목표

바이낸스 기준으로 아래를 확인한다.

- 수익 가능 종목 후보가 실제로 넓어졌는가
- `analysis -> decision -> signal -> executed` 전환이 실제로 개선됐는가
- 실행된 거래가 1개 심볼에 편중되지 않고 분산되는가

### 2.2 보조 목표

국내장/해외장 기준으로 아래를 확인한다.

- 주문 금액 제약(`min_order_notional`, `max_order_notional`)이 완화됐는가
- 미결 포지션 관리가 안정적으로 이뤄지는가
- 실행 실패 코드(`legacy_order_rejected`, `legacy_executor_failed`)가 줄어드는가

---

## 3. 검증 기간과 원칙

### 검증 기간

- 시작 시점부터 **최대 2일**
- 2일 내 유의미한 개선이 없으면 부분 보완은 실패로 본다.

### 운영 원칙

- threshold를 연속적으로 무한 조정하지 않는다.
- 중간 관찰은 하되, 하루 안에 구조를 다시 바꾸지 않는다.
- 검증 중에는 **퍼널 데이터 수집**을 우선한다.

---

## 4. 핵심 KPI

### 4.1 바이낸스 KPI

#### KPI-A1. Executed Count

- 정의:
  - 바이낸스 기준 실제 실행 거래 수
- 성공 기준:
  - **일간 executed > 0**
- 강한 성공 기준:
  - **일간 executed >= 3**

#### KPI-A2. Symbol Diversity

- 정의:
  - executed 또는 저장 signal 기준 고유 심볼 수
- 성공 기준:
  - **고유 심볼 2개 이상**
- 강한 성공 기준:
  - **고유 심볼 3개 이상**

#### KPI-A3. Decision Conversion

- 정의:
  - `decision_count` 대비 `executed_count`
- 성공 기준:
  - 기존 대비 **유의미한 상승**
- 운영 기준:
  - 지금은 `decision`은 많고 `executed`는 0에 가까우므로,
    **0에서 벗어나는 것 자체가 1차 성공**

#### KPI-A4. Action Distribution

- 정의:
  - `BUY / SELL / HOLD` 분포
- 성공 기준:
  - `HOLD` 일변도에서 벗어나 `BUY/SELL`이 실제로 관측됨
- 실패 시그널:
  - 새 런 기준으로도 `BUY/SELL`이 거의 0

#### KPI-A5. Cost-to-Execution Efficiency

- 정의:
  - LLM 비용 대비 executed 수
- 성공 기준:
  - 비용 증가와 함께 실행도 증가
- 실패 시그널:
  - 비용은 계속 누적되는데 executed는 0 또는 극소수

### 4.2 국내장/해외장 KPI

#### KPI-S1. Order Constraint Relief

- 정의:
  - `min_order_notional`, `max_order_notional` 실패 코드 빈도
- 성공 기준:
  - 최근 일간/주간 기준 감소

#### KPI-S2. Execution Continuity

- 정의:
  - 국내장/해외장의 실제 executed 유지 여부
- 성공 기준:
  - 현재 수준 이상 유지
- 실패 시그널:
  - 기존에도 적은 executed가 더 줄거나 0으로 수렴

#### KPI-S3. Position Management Stability

- 정의:
  - 미결 포지션 수와 강제 종료 기준 점검 결과
- 성공 기준:
  - 미결 포지션의 누적/방치가 줄어듦

---

## 5. 성공 / 실패 판정

### 5.1 부분 보완 성공

아래 중 다수를 만족하면 성공으로 본다.

- 바이낸스 일간 executed가 실제 발생
- 바이낸스 고유 거래 심볼 수가 늘어남
- `BUY/SELL` action이 실제로 관측됨
- 비용 증가와 실행 증가가 같이 나타남
- 국내장/해외장의 주문 제약 실패 코드가 감소

### 5.2 부분 보완 실패

아래 중 하나라도 강하게 나타나면 실패로 본다.

- 바이낸스 executed가 여전히 0 또는 거의 0
- 바이낸스 action 분포가 여전히 `HOLD` 중심
- 비용은 계속 누적되는데 executed가 늘지 않음
- 국내장/해외장의 주문 제약/실행 실패가 그대로 유지
- 미결 포지션 관리도 개선이 없음

부분 보완 실패 시, 코덱 권고는 **즉시 재설계 전환**이다.

---

## 6. 재설계 전환 트리거

아래 조건이 만족되면 재설계로 넘어간다.

1. 바이낸스에서 2일 내 executed 개선이 없음
2. `BUY/SELL` action 분포가 실제로 생성되지 않음
3. 국내장/해외장의 실행 제약 문제가 여전히 큼
4. 주간 비용 대비 전환율이 여전히 비정상적으로 낮음

즉 재설계 트리거는:

> **연구는 계속 충분한데, 거래 전환이 여전히 회복되지 않는 경우**

---

## 7. 구현 전 체크리스트

부분 보완 구현 전 아래를 먼저 확인한다.

- `pipeline_runs.meta`의 action 분포 저장이 새 런에서 실제 쌓이는가
- 일지/주간 리뷰가 퍼널 병목을 정상 노출하는가
- 바이낸스 최근 런 기준 `BUY / SELL / HOLD`가 실제로 보이는가
- `trading-journal.js`와 `weekly-trade-review.js`로 결과를 바로 판독 가능한가

---

## 8. 다음 단계

1. 이 KPI 문서를 기준으로 부분 보완 구현 범위를 고정
2. 바이낸스 우선으로 제한형 부분 보완 실행
3. 1~2일 검증 후
   - 성공: 부분 보완 연장
   - 실패: 시장별 전략 분리 재설계 착수
