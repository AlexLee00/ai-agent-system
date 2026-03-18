# 루나 시스템 재점검 Phase 계획서

> 작성일: 2026-03-19  
> 목적: 루나팀 자동매매 시스템을 부분 보정이 아닌 시스템 단위로 재점검하고, 부분 보완으로 충분한지 또는 재설계가 필요한지 판단하기 위한 사전 진단 계획을 정의한다.

---

## 1. 결론

루나팀은 현재 `분석은 활발하지만 거래 전환은 약한 상태`다.  
이 상태는 단순 threshold 조정으로 설명되기 어렵고, 다음 5개 레이어를 분리해 진단해야 한다.

1. 종목 선정 연구
2. 심볼 판단
3. 포트폴리오 판단
4. 리스크 승인
5. 주문 실행

이번 Phase의 목표는 기능 추가가 아니다.  
`어디가 병목인지`, `부분 보완으로 충분한지`, `재설계가 필요한지`를 짧은 시간 안에 명확히 판단하는 것이다.

---

## 2. 왜 재점검이 필요한가

### 비즈니스 목표

- 사용자의 목표는 `정확한 몇 건의 거래`가 아니라 `수익 가능 종목을 다양하게 선정하고 활발한 거래를 통해 수익 파이프라인을 다변화`하는 것이다.
- 현재는 분석 비용이 발생하지만 거래 전환이 약해, 시스템이 `자동매매 엔진`보다 `고비용 분석 엔진`처럼 보일 위험이 있다.

### 서비스 기획 구조

- 루나는 이미 아래 다단계 구조를 가진다.
  - 연구
  - 심볼 decision
  - portfolio decision
  - risk
  - execution
- 따라서 문제를 `단일 threshold`나 `단일 bot` 문제로 보면 안 된다.

### 개발 실현 가능성

- 현재 구조는 이미 충분히 복잡하다.
- 전면 재설계 전에도, 기존 레이어를 이용해 병목 위치를 더 정확히 측정할 수 있다.
- 즉 먼저 `퍼널 실측`과 `레이어별 불변식 점검`이 필요하다.

### 데이터 구조 및 확장성

- 현재도 `analysis`, `signals`, `trades`, `pipeline_runs.meta`, `block_code`, `block_meta`가 있다.
- 이 구조를 활용하면 시장별/단계별 전환율을 측정할 수 있다.
- 이후 SaaS 확장 시에도 이 퍼널 구조는 고객별 전략 품질 KPI가 된다.

### 운영 안정성

- 원인 미확인 상태에서 threshold를 계속 건드리면 과매매나 잘못된 주문이 생길 수 있다.
- 반대로 현재처럼 지나치게 보수적이면 운영 효율이 급격히 떨어진다.

### 추후 SaaS 확장 가능성

- 내부 MVP에서도 레이어별 책임이 명확해야 한다.
- 향후 외부 고객에게 제공하려면 시장별 전략 프로필, 보수도, 리스크 정책을 분리해 관리할 수 있어야 한다.

---

## 3. 현재까지 확인된 이상 신호

### 공통

- 분석은 많지만 거래가 적다.
- 시장별로 병목 위치가 다를 가능성이 있다.
- 최근 실패 원인이 하나로 설명되지 않는다.

### 암호화폐

- `analysis`는 충분히 쌓인다.
- `news / onchain / sentiment / ta_mtf` 모두 실제로 작동한다.
- 그런데 `decision` 대비 `executed`가 매우 약하다.
- 최근 기준 `weakSignalSkipped = 0`, `riskRejected = 0`인 구간이 확인돼, `weak/risk`보다 앞단의 보수성 가능성이 크다.

### 국내장 / 해외장

- 장외 `analysis_only`는 정상 경로다.
- 다만 전체 기간 기준 거래 부재가 계속되면, 장외 설명만으로는 충분하지 않다.

### 실행기 / 주문 제약

- 최근 차단 코드:
  - `min_order_notional`
  - `max_order_notional`
  - `legacy_order_rejected`
  - `legacy_executor_failed`
  - `nemesis_error`
- 즉 일부는 decision 이후 실행 레이어에서도 막힌다.

---

## 4. 이번 Phase의 핵심 질문

### 1차: 시스템 개선 질문

1. 종목 선정 연구는 충분히 다양한가?
2. 연구 결과가 심볼 decision으로 충분히 승격되는가?
3. 심볼 decision이 portfolio decision에서 과도하게 HOLD로 소거되는가?
4. risk 레이어가 실제 병목인가, 아니면 병목처럼 보이기만 하는가?
5. execution 레이어가 실제 체결 손실을 만들고 있는가?

### 2차: 리포트/관측 질문

1. 운영자는 지금 `거래가 왜 없는지`를 리포트만 보고 설명할 수 있는가?
2. 시장별로 병목 위치를 코드형 상태로 읽을 수 있는가?
3. 다음 튜닝이 threshold 조정이어야 하는지, 구조 재설계여야 하는지 판단 가능한가?

---

## 5. 진단 범위

### 포함

- [bots/investment/markets/crypto.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/crypto.js)
- [bots/investment/markets/domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
- [bots/investment/markets/overseas.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js)
- [bots/investment/team/luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
- [bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
- [bots/investment/shared/pipeline-decision-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-decision-runner.js)
- [bots/investment/shared/pipeline-db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-db.js)
- [bots/investment/shared/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)
- [bots/investment/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)
- [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

### 제외

- 지금 당장은 UI 개편
- 새 외부 API 도입
- 전략 백테스터 신규 구현
- 멀티테넌트 구조화

---

## 6. 이번 Phase의 산출물

반드시 아래 3개를 남긴다.

1. **루나 시스템 현황 진단서**
   - 시장별 현재 구조
   - 실제 퍼널 수치
   - 병목 위치

2. **레이어별 병목 보고서**
   - 연구
   - decision
   - portfolio
   - risk
   - execution

3. **부분 보완안 vs 재설계안 비교안**
   - 무엇을 재사용할지
   - 무엇을 버릴지
   - 비용/효과/리스크 비교

---

## 7. 진단 불변식

다음 불변식을 만족해야 `부분 보완`으로 간다.

1. 연구 결과가 decision으로 일정 비율 이상 승격된다.
2. decision이 signal 저장 전 단계에서 과도하게 사라지지 않는다.
3. risk reject와 execution reject가 현재 목표와 양립 가능하다.
4. 시장별 거래 부재가 운영 정책으로 설명 가능하다.
5. 분석 비용 대비 거래/수익 파이프라인이 회복 가능하다.

하나라도 구조적으로 깨져 있으면 `재설계안`으로 전환한다.

---

## 8. 구현 전단계 체크리스트

### 이미 확보한 것

- `decision 퍼널 병목` 섹션
- `weakSignalSkipped`, `riskRejected`, `savedExecutionWork` 영속 저장
- 일지/주간 리뷰 노출
- `BUY / SELL / HOLD` 저장 필드 추가

### 아직 필요한 것

- 새 파이프라인 런 기준 `BUY / SELL / HOLD` 실제 값 확인
- `portfolioDecision.decisions`와 실제 저장된 분포 일치 확인
- 시장별 `analysis -> decision -> signal -> executed` 전환율 실측
- 최근 실패 코드와 시장별 영향도 정리

---

## 9. 구현 경계

### 지금 당장 필요한 구조

- 진단
- 계측
- 병목 지도
- 부분 보완 가능 여부 판단

### 나중에 확장할 구조

- 바이낸스 전용 공격형 전략 엔진
- 국내/해외장 보수형 전략 분리
- 고객별 risk profile
- 전략 실험/승격 프레임워크

---

## 10. 다음 구현 라운드 시작점

다음 라운드는 아래 순서로 시작한다.

1. 최신 `pipeline_runs` 기준 `BUY / SELL / HOLD` 실측
2. 시장별 `analysis -> decision -> signal -> executed` 퍼널 수치화
3. `portfolioDecision` HOLD 과다 여부 확정
4. 그 후 `부분 보완안`과 `재설계안`을 비교

이 문서 단계에서는 **구현을 시작하지 않는다.**  
다음 단계부터 실제 진단 실행 또는 재설계 착수로 넘어간다.
