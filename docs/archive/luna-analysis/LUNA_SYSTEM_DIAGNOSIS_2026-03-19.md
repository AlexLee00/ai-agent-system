# 루나 시스템 현황 진단서

> 작성일: 2026-03-19  
> 범위: 루나팀 자동매매 시스템의 현재 구조와 최근 운영 데이터 기준 1차 진단  
> 기준 문서: [LUNA_RESET_AUDIT_PLAN_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/LUNA_RESET_AUDIT_PLAN_2026-03-19.md)

---

## 1. 결론

루나팀은 현재 **분석은 충분히 수행하지만 거래 전환은 구조적으로 약한 상태**다.

핵심 판단:
- 암호화폐는 종목 연구 자체는 활발하다.
- 국내장/해외장도 연구는 충분히 수행된다.
- 그러나 최근 7일 기준 실제 거래는 `0건`이고, 시장별 `decision -> executed` 전환이 매우 약하다.
- 단순 threshold 조정만으로 설명되기 어려우며, **심볼 판단 이후 포트폴리오 판단과 signal 저장 전 구간의 보수성**을 의심해야 한다.
- 동시에 국내장/암호화폐는 **주문 제약 및 실행 실패 코드**도 실제로 존재한다.

따라서 현재 루나는
- `자동매매 수익 파이프라인`
보다는
- `고비용 분석 + 제한적 실행 시스템`
에 더 가깝다.

---

## 2. 최근 운영 데이터 요약

### 2.1 일간 기준 (2026-03-19)

출처:
- [trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js) `--days=1`

핵심 수치:
- 거래: `0건`
- 미결 포지션: `4개` (해외장)
- LLM 사용량: `403,995 tokens / $0.4295`

암호화폐 분석가 판단 분포:
- `news`: 총 `89건` (`BUY 1 / HOLD 84 / SELL 4`)
- `onchain`: 총 `89건` (`BUY 69 / HOLD 11 / SELL 9`)
- `sentiment`: 총 `89건` (`BUY 16 / HOLD 62 / SELL 11`)
- `ta_mtf`: 총 `89건` (`HOLD 89`)

해외장 분석가 판단 분포:
- `news`: 총 `108건` (`BUY 54 / HOLD 34 / SELL 20`)
- `sentiment`: 총 `108건` (`BUY 3 / HOLD 102 / SELL 3`)
- `ta_mtf`: 총 `85건` (`HOLD 84 / SELL 1`)

일간 퍼널 병목:
- 암호화폐: `decision 89 / BUY 0 / SELL 0 / HOLD 0 / executed 0 / weak 0 / risk 0`
- 해외장: `decision 90 / BUY 0 / SELL 0 / HOLD 0 / executed 0 / weak 0 / risk 0`

해석:
- 암호화폐와 해외장은 연구 입력은 충분하다.
- 그런데 최종 실행은 없다.
- `weakSignalSkipped = 0`, `riskRejected = 0`이므로, 현재 1차 병목은 `weak/risk`보다 앞단일 가능성이 크다.

### 2.2 주간 기준 (최근 7일)

출처:
- [trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js) `--days=7`
- [weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js) `--dry-run`

핵심 수치:
- 종료 거래: `0건`
- 미결 포지션: `4개`
- LLM 사용량: `6,724,240 tokens / $6.7981`
- 경고: `no-trade high-cost`

주간 퍼널 병목:
- 암호화폐: `decision 1420 / BUY 0 / SELL 0 / HOLD 0 / executed 0 / weak 0 / risk 0`
- 국내장: `decision 323 / BUY 0 / SELL 0 / HOLD 0 / executed 21 / weak 0 / risk 0`
- 해외장: `decision 432 / BUY 0 / SELL 0 / HOLD 0 / executed 5 / weak 0 / risk 0`

주의:
- `BUY / SELL / HOLD` 분포는 최근 추가된 저장 필드라 과거 `pipeline_runs.meta`에는 없는 값이 많다.
- 따라서 현재 `0`은 “실제 0”과 “과거 데이터 미보유”가 섞여 있을 수 있다.
- 다만 `decision_count` 대비 `executed` 수가 매우 낮은 구조 자체는 분명하다.

### 2.3 최근 저장 신호 / 실패 코드

주간 일지 기준:

암호화폐:
- 저장된 신호: `BUY 1건`
- 실패 코드: `nemesis_error`

국내장:
- 저장된 신호: `BUY 3건`
- 실패 코드: `min_order_notional 3건`

해외장:
- 주간 일지 기준 저장된 신호 요약은 없지만, 미결 포지션 `4개`가 남아 있다.

해석:
- 국내장은 주문 금액 제약이 실제 병목이다.
- 암호화폐는 적어도 최근 7일에는 signal 저장 자체가 극히 적고, signal 이후에도 리스크 레이어 예외가 있었다.

---

## 3. 현재 시스템 구조 해석

### 3.1 실제 구조

루나는 아래 5단 구조다.

1. 종목 선정 연구
2. 심볼 판단
3. 포트폴리오 판단
4. 리스크 승인
5. 주문 실행

관련 핵심 코드:
- [crypto.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/crypto.js)
- [domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
- [overseas.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js)
- [luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
- [nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
- [pipeline-decision-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-decision-runner.js)

### 3.2 현재 운영 구조에서 중요한 특징

- 국내장/해외장은 장외에 `analysis_only` 모드가 있으므로, “장외 거래 없음”은 일부 정상이다.
- 암호화폐는 24시간 시장이므로 동일한 설명이 어렵다.
- 암호화폐에서 연구는 충분한데 거래가 없는 것은 구조적 경고다.

---

## 4. 1차 진단 결과

### 4.1 종목 선정 연구

판단: **정상 또는 과도할 정도로 충분**

근거:
- 암호화폐는 `news / onchain / sentiment / ta_mtf`가 모두 지속적으로 돈다.
- 해외장도 `news / sentiment / ta_mtf` 기준 연구량이 충분하다.
- 주간 LLM 비용이 `6,724,240 tokens / $6.7981`까지 누적됐다.

의미:
- 현재 문제는 “연구 부족”이 아니다.
- 오히려 연구 대비 실행 전환이 약해 **운영 효율 악화**가 더 문제다.

### 4.2 심볼 판단

판단: **연구 입력은 충분하지만 심볼 판단의 출력 품질이 보수적일 가능성이 높음**

근거:
- 암호화폐 `onchain`은 BUY 비중이 매우 높다.
- 그런데 `news`, `sentiment`, `ta_mtf`는 HOLD 비중이 크다.
- 특히 `ta_mtf`는 하루 `89건` 모두 HOLD다.

의미:
- 특정 분석가의 보수성이 전체 신호를 누르고 있을 수 있다.
- `ta_mtf`가 시장 전반을 HOLD로 고정시키는지 확인이 필요하다.

### 4.3 포트폴리오 판단

판단: **가장 유력한 1차 병목**

근거:
- `decision_count`는 충분한데 `executed`가 매우 적다.
- `weakSignalSkipped = 0`, `riskRejected = 0`인 구간이 많다.
- [luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)에서
  - `dec.action === HOLD`면 저장 전에 바로 사라진다.
  - `confidence < minConf`면 저장 전에 바로 사라진다.

의미:
- 최종 `portfolioDecision.decisions`에서 BUY/SELL이 충분히 남지 않거나,
- 남아도 signal 저장 직전 confidence gating에서 사라질 가능성이 높다.

### 4.4 리스크 승인

판단: **주요 병목으로 단정하기 어려움**

근거:
- 최근 퍼널 메트릭에서 `riskRejected = 0`
- 다만 저장된 signal에서는 `nemesis_error`가 존재

의미:
- 네메시스가 “리스크 거절을 남발하는 구조”라고 보긴 어렵다.
- 대신 예외 상황(`nemesis_error`)은 별도 안정화가 필요하다.

### 4.5 주문 실행

판단: **시장별로 부분 병목 존재**

근거:
- 국내장: `min_order_notional`
- 과거 이력: `max_order_notional`, `legacy_order_rejected`, `legacy_executor_failed`, `nemesis_error`

의미:
- 실행 레이어가 전혀 문제가 없다고 볼 수는 없다.
- 그러나 현재 가장 큰 병목은 실행보다 앞단일 가능성이 더 높다.

---

## 5. 현재 구조에 대한 종합 판단

### 비즈니스 목표 관점

- 목표는 `수익 가능 종목을 다양하게 선정하고 활발한 거래를 통해 수익 파이프라인을 다변화`하는 것이다.
- 현재는 분석량과 비용은 크지만 거래 전환이 약해 목표와 괴리가 크다.

### 서비스 기획 구조 관점

- 루나는 이미 다단 구조라, 병목을 한 단계씩 분리해 봐야 한다.
- 현재는 “자동매매 엔진”보다 “연구 + 보수적 승인 체계”에 더 가깝다.

### 개발 실현 가능성 관점

- 지금 당장 전면 재설계보다, 퍼널과 decision 분포를 더 정확히 측정하는 것이 현실적이다.
- 다만 이 진단 결과가 계속 유지되면 재설계로 넘어갈 근거는 충분하다.

### 데이터 구조 및 확장성 관점

- `pipeline_runs.meta`, `signals`, `block_code`, `analysis` 구조는 재사용 가치가 높다.
- 즉 데이터 레이어는 버리지 않고, 판단/전환 구조를 손보는 것이 우선이다.

### 운영 안정성 관점

- 지금처럼 거래가 없는데 비용이 계속 나는 구조는 운영상 위험하다.
- threshold만 추가 조정하는 방식은 더 이상 안전한 기대를 주지 못한다.

### 추후 SaaS 확장 가능성

- 현재 구조는 고객별 전략 품질 KPI로 확장 가능한 퍼널 데이터를 이미 갖고 있다.
- 따라서 재설계가 필요하더라도 데이터/리포트 계층은 최대한 재사용하는 것이 맞다.

---

## 6. 1차 판단

현재 루나는 아래처럼 해석하는 것이 가장 정확하다.

- **연구 계층**: 정상
- **심볼 판단 계층**: 보수성 의심
- **포트폴리오 판단 계층**: 핵심 병목 의심
- **리스크 계층**: 부분 예외는 있으나 주병목으로는 약함
- **실행 계층**: 일부 시장에서 제약/실패 존재

즉 1차 결론은:

> 루나는 “연구 부족”이 아니라  
> “연구 결과가 포트폴리오 판단과 signal 저장 구간에서 과도하게 소거되는 구조”에 가깝다.

---

## 7. 다음 단계

1. `portfolioDecision.decisions`의 실제 `BUY / SELL / HOLD` 분포를 새 런 기준으로 확정
2. `getPortfolioDecision()` 프롬프트와 결과 분포를 대조
3. `ta_mtf`, `sentiment`, `news`의 HOLD 편향이 실제로 decision에 어떻게 반영되는지 확인
4. 그 결과로
   - 부분 보완
   - 시장별 전략 분리
   - 최소 재설계
   중 하나를 선택
