# 루나 제한형 부분 보완 구현안

> 작성일: 2026-03-19  
> 범위: 루나 재점검 Phase 이후 즉시 착수 가능한 제한형 부분 보완 구현 범위  
> 연계 문서:
> - [LUNA_SYSTEM_DIAGNOSIS_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_SYSTEM_DIAGNOSIS_2026-03-19.md)
> - [LUNA_LAYER_BOTTLENECK_REPORT_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_LAYER_BOTTLENECK_REPORT_2026-03-19.md)
> - [LUNA_PATCH_VS_REDESIGN_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_PATCH_VS_REDESIGN_2026-03-19.md)
> - [LUNA_PATCH_VALIDATION_KPI_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_PATCH_VALIDATION_KPI_2026-03-19.md)

---

## 1. 결론

루나의 제한형 부분 보완은 **바이낸스 우선**으로 아래 4가지만 수행한다.

1. `portfolio decision` 보수성 완화
2. `ta_mtf` HOLD 고정 편향 완화
3. `BUY / SELL / HOLD` action 분포와 전환 퍼널 가시성 강화
4. 바이낸스 결과를 1~2일 내 KPI로 검증

중요한 원칙:
- 이번 단계에서는 **전면 재설계하지 않는다**
- 국내장/해외장은 **관측 강화 + 제약 확인**만 수행하고 대규모 정책 변경은 하지 않는다
- KPI 미달 시 즉시 재설계안으로 전환한다

---

## 2. 구현 목표

### 2.1 비즈니스 목표

- 바이낸스에서 수익 가능 종목을 더 넓게 포착
- 거래를 실제로 발생시켜 수익 파이프라인을 다변화
- 분석 비용만 크고 거래가 없는 상태에서 벗어남

### 2.2 서비스 기획 구조 목표

- 연구 -> 판단 -> signal -> 실행 퍼널을 실제로 연결
- “거래 없음”이 아니라 “왜 거래가 없는지”가 리포트에서 보이게 유지
- 바이낸스와 stock의 목표 차이는 인정하되, 이번 단계에선 crypto 우선 개선

---

## 3. 구현 범위

### 3.1 포함 범위

#### A. 바이낸스 `portfolio decision` 프롬프트 조정

대상 파일:
- [luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)

변경 방향:
- crypto 전용 포트폴리오 판단에서
  - HOLD는 “명확한 edge 부재”일 때만 허용
  - 다수 종목 분산 진입을 더 적극 장려
  - 강한 단일 확신보다 “중간 확신 다수 분산”도 허용
  - 24시간 시장 특성상 지나친 대기보다 소규모 진입을 우선

목표:
- `portfolioDecision.decisions`에서 BUY/SELL이 실제로 남게 만들기

#### B. `ta_mtf` HOLD 고정 편향 완화

대상 파일:
- [luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
- 관련 analyst 설정/프롬프트 파일이 있으면 함께 검토

변경 방향:
- `ta_mtf`가 구조적으로 HOLD 일변도로 수렴하는지 점검
- crypto에서 trend continuation, breakout, mean-reversion entry를 더 적극 반영
- “불확실 -> HOLD” 대신 “소규모 진입 가능 여부”까지 판단하게 유도

목표:
- `ta_mtf`가 전 종목 HOLD 고정 레이어로 작동하는 상태 해소

#### C. action 분포 / 전환 메트릭 강화

대상 파일:
- [pipeline-decision-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-decision-runner.js)
- [trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

변경 방향:
- 새 런 기준 `BUY / SELL / HOLD` 분포가 실제로 쌓이는지 확인
- 필요하면 텍스트 요약에
  - `action distribution`
  - `promotion rate`
  - `signal save rate`
  를 더 짧게 추가

목표:
- KPI 판독을 리포트만으로 가능하게 만들기

#### D. 바이낸스 결과 관측 우선

대상:
- [trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

변경 방향:
- 바이낸스 결과를 상단 또는 별도 강조 블록으로 노출
- 일간 `executed / signal / decision / weak / risk`
  한눈에 보이게 유지

목표:
- 사용자가 바이낸스 성과를 빠르게 확인

### 3.2 제외 범위

이번 단계에서는 아래를 **의도적으로 건드리지 않는다.**

- 전면 재설계
- 시장별 엔진 완전 분리
- 국내장/해외장 risk policy 대규모 변경
- execution layer 전체 교체
- `nemesis` 철학 자체의 전면 수정
- 데이터 스키마 대수술

이유:
- 지금은 제한형 부분 보완 검증 단계이기 때문

---

## 4. 시장별 전략

### 4.1 암호화폐

이번 단계의 중심 대상이다.

변경 목표:
- BUY/SELL action 실제 생성
- executed 발생
- 심볼 다양성 증가

### 4.2 국내장

이번 단계에서는 관측 중심이다.

확인 항목:
- `min_order_notional`
- `max_order_notional`
- 최근 executed 유지 여부

### 4.3 해외장

이번 단계에서는 미결 관리와 실행 연속성 확인 중심이다.

확인 항목:
- 미결 포지션 관리
- executed 유지
- 종료/강제 종료 기준

---

## 5. 구현 순서

### Step 1. crypto decision prompt/threshold 보정

- `luna.js`의 crypto 포트폴리오 판단 문구 조정
- 필요 시 fast-path, hold gate를 crypto 기준으로만 추가 보정

### Step 2. `ta_mtf` 판단 완화

- `ta_mtf`가 HOLD 일변도로 수렴하는 원인 점검
- crypto용 가이드 보정

### Step 3. 리포트 가시성 보강

- 일지/주간 리뷰가 KPI 판독에 충분한지 보강

### Step 4. 1~2일 검증

- [LUNA_PATCH_VALIDATION_KPI_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_PATCH_VALIDATION_KPI_2026-03-19.md) 기준으로 판정

---

## 6. 성공 기준

부분 보완 성공은 아래를 만족해야 한다.

- 바이낸스 executed가 실제 발생
- 고유 거래 심볼이 늘어남
- `BUY/SELL` action이 새 런에서 실제 관측됨
- 비용 증가와 함께 전환도 증가

이 기준을 만족하지 못하면, 코덱 권고는 **즉시 재설계 전환**이다.

---

## 7. 리스크

### 비즈니스 목표 관점

- 거래를 늘리려다 품질이 무너지면 안 된다.
- 그러나 지금처럼 분석 비용만 크고 거래가 없으면 더 큰 실패다.

### 운영 안정성 관점

- crypto만 먼저 손보되 stock은 건드리지 않는 이유는 리스크 범위를 제한하기 위해서다.

### SaaS 확장성 관점

- 이번 단계는 임시 튜닝이 아니라,
  추후 시장별 전략 분리 재설계 전 검증 실험으로 남겨야 한다.

---

## 8. 다음 단계

1. 이 구현안을 기준으로 실제 코드 수정 착수
2. 바이낸스 우선 결과 수집
3. KPI 판정
4. 미달 시 재설계안 전환
