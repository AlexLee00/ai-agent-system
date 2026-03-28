# 루나팀 재설계 Phase 1~5 로드맵

> 작성일: 2026-03-28  
> 대상: `bots/investment` 루나팀 전체 구조  
> 범위: 코드 구조, 리포트, 오류 이력, 정책 레이어, 검증 레이어, `n8n`, `RAG`, 향후 맥스튜디오 기반 확장  
> 우선순위 시장: `crypto` → `domestic` → `overseas`

---

## 1. 문서 목적

이 문서는 루나팀을 단순한 다중 분석 에이전트 집합이 아니라, **검증 가능하고 승격 가능한 자동매매 운영 시스템**으로 재정렬하기 위한 Phase 1~5 로드맵이다.

핵심 목표:

1. 현재 루나팀의 병목을 구조적으로 정의한다.
2. 각 에이전트의 역할과 실제 활동을 재정의한다.
3. `n8n`, `RAG`, 백테스트, 예측엔진, 검증엔진의 적정 위치를 고정한다.
4. 내부 MVP 기준에서 바로 실행 가능한 구조와, 향후 SaaS 확장 구조를 분리한다.
5. 맥스튜디오 도착 후 어떤 순서로 검증, 승격, 확장을 진행할지 단계별 기준을 만든다.

---

## 2. 현재 상태 요약

### 2.1 현재 강점

루나팀은 이미 다층 분석 체계를 갖추고 있다.

- `Argos`
  - 스크리닝, 외부 인텔리전스 intake
- `Aria`
  - 기술적 분석, MTF 분석
- `Hermes`
  - 뉴스 분석
- `Sophia`
  - 감성 분석
- `Oracle`
  - 온체인 및 파생 데이터 분석
- `Zeus / Athena`
  - 찬반 토론형 리서처
- `Luna`
  - 심볼 판단 및 포트폴리오 판단
- `Nemesis`
  - 리스크 승인
- `Hephaestos / Hanul`
  - 주문 실행
- `Chronos`
  - 백테스트 및 성과 분석 보조

즉 현재 루나팀의 문제는 **연구 인프라 부족**이 아니다.

### 2.2 현재 핵심 문제

운영 데이터와 리포트 기준으로 현재 루나팀의 본질적 문제는 다음과 같다.

1. 분석 결과는 많지만 실행 전환이 매우 약하다.
2. `Luna`의 포트폴리오 판단과 `Nemesis` 정책 계층에서 결정이 과도하게 소거된다.
3. `validation` lane이 실제로는 LIVE 소액 검증 레일로 사용되는데, 예산 구조는 이를 충분히 분리하지 못한다.
4. 백테스트, 워크포워드, shadow validation, 승격 검증이 코어 판단 구조에 충분히 결합돼 있지 않다.
5. `RAG`와 `n8n`은 유용하지만, 코어 매매 엔진으로 확장되면 오히려 재현성과 안정성을 해칠 수 있다.

### 2.3 현재 운영 해석

현재 루나팀은 아래처럼 해석하는 것이 가장 정확하다.

- 연구 계층: 강함
- 후보 판단 계층: 보수성 높음
- 포트폴리오 판단 계층: 핵심 병목
- 정책 계층: `validation` 편중
- 실행 계층: 시장별 제약 존재
- 검증 계층: 아직 주변 기능 수준

즉 현재 구조는

- `자동매매 운영 엔진`

보다는

- `고비용 연구 + 강한 정책 억제 + 제한적 실행 시스템`

에 더 가깝다.

---

## 3. 재설계의 기본 원칙

### 3.1 공통 원칙

1. 기존 아키텍처와 레이어를 최대한 존중한다.
2. 전면 재작성보다 기존 공용 레이어 확장을 우선한다.
3. deterministic pipeline을 코어로 유지한다.
4. LLM은 판단 보조, 설명 강화, 정성 컨텍스트 해석에 우선 사용한다.
5. 실행 직전 판단은 가능한 한 규칙 기반으로 수렴시킨다.
6. 로그, 실행 이력, 실패 이력, 정책 변경 이력, 사용자 수정 이력을 강하게 남긴다.

### 3.2 MVP 원칙

지금 당장 필요한 구조:

- 단일 조직 기준
- 단일 DB 기준
- 단일 투자 운영 기준
- 운영자 해석이 쉬운 구조
- 기존 `signals`, `pipeline_runs.meta`, `trade review`, `health report` 재사용

나중에 확장할 구조:

- 멀티워크스페이스
- 고객별 정책 프로파일
- 전략 버전 분리
- 승격/강등 자동화
- 서비스형 투자 운영 SaaS

---

## 4. 목표 아키텍처

루나팀 재설계는 아래 6개 레인 구조를 목표로 한다.

1. `Research Lane`
2. `Decision Lane`
3. `Policy Lane`
4. `Execution Lane`
5. `Validation Lane`
6. `Review Lane`

### 4.1 Research Lane

역할:

- 시장/심볼에 대한 정성·정량 입력 생성
- raw signal 및 feature 공급
- explanation source 제공

대상 에이전트:

- `Argos`
- `Aria`
- `Hermes`
- `Sophia`
- `Oracle`
- `Zeus / Athena`

핵심 원칙:

- 이 레인의 목적은 `결정 근거 생산`이다.
- 이 레인 자체가 주문 실행 결정권을 갖지 않는다.

### 4.2 Decision Lane

역할:

- 심볼별 후보 판단
- 포트폴리오 제약 하의 후보 정렬
- 최종 주문 후보 생성

대상 에이전트:

- `Luna`

재정의 방향:

- 현재 `Luna`는 자유 생성형 최종 판단 성격이 강하다.
- 앞으로 `Luna`는 `제약형 후보 오케스트레이터`로 축소한다.

핵심 원칙:

- 자유 서술형 BUY/SELL 창조보다
- 허용된 후보 집합 안에서 constrained selection을 수행한다.

### 4.3 Policy Lane

역할:

- 실행 전 제약 적용
- 예산/포지션/재진입/노출/시간대 리스크 제어

대상 에이전트:

- `Nemesis`

분해 방향:

- `L20 hard-rules`
- `L21 adaptive risk`
- `validation budget policy`
- `reentry policy`
- `exposure policy`

핵심 원칙:

- “왜 막혔는가”가 정책 단위로 분리되어야 한다.
- 이후 워크스페이스별 정책 프로파일로 확장 가능해야 한다.

### 4.4 Execution Lane

역할:

- 실제 주문
- 체결 확인
- 보호 주문
- 실패 코드 분류

대상 에이전트:

- `Hephaestos`
- `Hanul`

핵심 원칙:

- 현재 실행 계층은 비교적 책임이 명확하다.
- 따라서 전면 수정 대상이 아니라 failure taxonomy와 capability profile 강화가 우선이다.

### 4.5 Validation Lane

역할:

- 전략 검증
- shadow 실행
- validation live
- 승격/강등 판단
- 백테스트/워크포워드

대상:

- `Chronos` 승격
- 향후 `Validation Engine`

핵심 원칙:

- 이 레인을 코어로 승격해야 한다.
- 현재 루나팀에서 가장 부족한 것은 이 레인이다.

### 4.6 Review Lane

역할:

- post-trade review
- journal
- weekly review
- 실패/성공 패턴 회고
- 정책 피드백

핵심 원칙:

- review는 보고서 생성으로 끝나면 안 된다.
- 다음 cycle의 policy, threshold, strategy version에 되먹임되어야 한다.

---

## 5. 에이전트별 재정의

### 5.1 유지 우선 에이전트

#### Argos

유지 이유:

- 후보군 생성과 외부 인텔리전스 intake는 여전히 필요하다.

보강 방향:

- screening precision score
- source quality score
- false positive tracking

#### Aria

유지 이유:

- TA/MTF는 기본 deterministic input으로 가치가 높다.

보강 방향:

- HOLD 과편향 검증
- data sparsity 영향 측정
- regime별 성능 추적

#### Hermes

유지 이유:

- 뉴스는 정성 컨텍스트 보강에 유효하다.

보강 방향:

- 실행 trigger보다 thesis modifier 역할 강화
- 선행성보다 contextual value 중심 평가

#### Sophia

유지 이유:

- 감성은 market mood feature로 사용 가치가 있다.

보강 방향:

- noise contribution 측정
- 단독 결정권 약화

#### Oracle

유지 이유:

- crypto에서는 온체인/파생 feature가 여전히 중요하다.

보강 방향:

- BUY 편향 여부 검증
- funding/open interest 극단치 calibration

### 5.2 재정의 우선 에이전트

#### Luna

현재 문제:

- 심볼 판단과 포트폴리오 판단권이 과도하게 크다.
- 자유 생성형 최종 판정자에 가깝다.

재정의:

- `창조적 최종 결정자`에서
- `제약형 후보 정렬 오케스트레이터`로 축소

구체화:

- 입력:
  - symbol decision candidates
  - deterministic ranking signals
  - current exposure
  - validation/live lane policy
- 출력:
  - 허용 후보 중 우선순위 리스트
  - explainable rationale

제약:

- 허용되지 않은 새 심볼 생성 금지
- 허용되지 않은 action 생성 금지
- sizing은 policy 입력 기준에 종속

#### Nemesis

현재 문제:

- 하드룰, 예산정책, adaptive risk, starter logic이 한 파일에 몰려 있다.

재정의:

- `Hard Rule Engine`
- `Budget Policy Engine`
- `Adaptive Risk Engine`

효과:

- 정책 해석이 쉬워진다.
- validation lane 전용 정책을 더 선명하게 분리 가능하다.
- SaaS 확장 시 workspace별 policy profile 분리가 쉬워진다.

#### Zeus / Athena

현재 문제:

- 비용은 큰데 uplift가 아직 충분히 검증되지 않았다.

재정의:

- 항상 실행이 아니라 조건부 실행
- ambiguity high, conflict high 구간에서만 실행

효과:

- 비용 절감
- 토론 목적 명확화
- 설명 가능성 유지

### 5.3 승격 우선 에이전트

#### Chronos

현재 문제:

- 백테스트/성과 분석이 코어 판단 구조와 분리돼 있다.

재정의:

- Phase 2 이후 루나팀의 핵심 검증 엔진으로 승격

담당 범위:

- backtest
- walk-forward
- shadow validation
- validation live score
- strategy promotion gate
- performance drift detection

---

## 6. n8n 적절성 검토

### 6.1 적합한 영역

`n8n`은 아래 용도로 적합하다.

- market cycle scheduling
- research-only workflow
- report generation
- notification
- retry/backoff orchestration
- human approval workflow
- batch pipeline visibility

즉 운영 orchestration에는 적합하다.

### 6.2 부적합한 영역

`n8n`은 아래 용도로는 부적합하다.

- 주문 직전 core decision path
- 저지연 이벤트 반응형 execution path
- 브로커 직결 실시간 decision engine
- critical risk gate의 source of truth

이유:

- worker 전달 구조와 queue mode는 확장에는 좋지만 저지연 핵심 경로에는 불리할 수 있다.
- workflow 편의성과 실시간 매매 안정성은 별개다.

### 6.3 적용 원칙

지금 당장 필요한 구조:

- `n8n`은 research-only, 리포트, 승인, 재시도 orchestration까지만 사용

나중에 확장할 구조:

- Node CLI → HTTP wrapper → `n8n` HTTP Request 전환
- 단, core decision path는 deterministic Node layer 유지

---

## 7. RAG 적절성 검토

### 7.1 적합한 영역

`RAG`는 아래에 적합하다.

- 과거 trade review retrieval
- 유사 실패 사례 검색
- thesis memo retrieval
- 뉴스/공시/분석 메모 보강
- explanation 강화

### 7.2 부적합한 영역

`RAG`는 아래에는 부적합하다.

- 주문 직전 수학적 기준 원장
- sizing 기준 원장
- exposure limit 기준 원장
- stop-loss / take-profit source of truth
- trade eligibility 최종 판정

### 7.3 적용 원칙

지금 당장 필요한 구조:

- `RAG`는 explanation, memory, 사례 회수 보조 레이어

나중에 확장할 구조:

- regime-specific case retrieval
- strategy memo store
- failed trade memory layer

핵심 금지 원칙:

- `RAG`를 deterministic policy 대신 사용하지 않는다.

---

## 8. 맥스튜디오 도입 이후 목표 구조

### 8.1 Backtest Engine

목표:

- deterministic replay
- 전략별 historical validation
- 수수료, 슬리피지, 시장시간, partial fill 반영

필수 저장 항목:

- strategy version
- market
- trade mode
- parameter snapshot
- expected vs realized 분리

### 8.2 Prediction Engine

목표:

- 직접 BUY/SELL을 내리는 엔진이 아니라 확률 feature 공급 엔진

출력 예시:

- breakout probability
- trend continuation probability
- regime probability
- expected volatility band

적용 원칙:

- `Luna` / `Nemesis` 입력 feature 중 하나로만 사용
- 단독 실행권 금지

### 8.3 Validation Engine

목표:

- 전략/파라미터별 승격 및 강등 판단
- validation live와 normal live 사이 정책 연결

핵심 지표:

- hit rate
- expectancy
- max drawdown
- regime consistency
- slippage sensitivity
- paper/live divergence

### 8.4 Strategy Registry

목표:

- 전략을 코드가 아니라 운영 객체로 다룬다.

저장 대상:

- `strategy_id`
- `version`
- `market`
- `description`
- `feature_profile`
- `validation_status`
- `promotion_history`
- `rollback_history`

---

## 9. 검증 절차 설계

### 9.1 검증 목표

루나팀은 앞으로 “좋아 보이는 아이디어”가 아니라, **승격 가능한 전략**을 기준으로 움직여야 한다.

### 9.2 검증 단계

#### Stage 1. Research Validation

- 각 분석가의 coverage
- signal distribution
- confidence calibration
- failure rate
- cost

#### Stage 2. Decision Validation

- symbol decision survival rate
- portfolio decision survival rate
- weak/risk reject profile
- debate uplift 여부

#### Stage 3. Policy Validation

- capital guard bias
- validation vs normal lane 분리
- reentry block 정합성
- exposure control 적절성

#### Stage 4. Backtest Validation

- 전략별 historical replay
- regime별 성능
- 비용 포함 성능

#### Stage 5. Walk-forward Validation

- rolling train/validate/test
- parameter stability 확인

#### Stage 6. Shadow Validation

- 실제 시장에서 실행 없이 시그널 추적
- expected vs realized 비교

#### Stage 7. Validation Live

- 소액 실거래
- policy gate 하의 표본 수집

#### Stage 8. Promotion

- 승격 기준 충족 시 normal live 전환
- 미충족 시 유지 또는 rollback

---

## 10. 데이터 구조 초안

### 10.1 지금 당장 필요한 구조

추가 또는 명확화가 필요한 핵심 원장:

- `strategy_registry`
- `strategy_validation_runs`
- `strategy_promotion_log`
- `prediction_feature_snapshot`
- `validation_policy_snapshot`
- `decision_survival_log`

### 10.2 핵심 저장 항목

#### strategy_registry

- `strategy_id`
- `version`
- `market`
- `description`
- `feature_profile`
- `active_flag`
- `created_at`
- `retired_at`

#### strategy_validation_runs

- `run_id`
- `strategy_id`
- `version`
- `validation_type`
  - `backtest`
  - `walk_forward`
  - `shadow`
  - `validation_live`
- `period_from`
- `period_to`
- `result_summary`
- `metrics_json`

#### strategy_promotion_log

- `strategy_id`
- `from_stage`
- `to_stage`
- `reason`
- `approver`
- `created_at`

#### decision_survival_log

- `session_id`
- `market`
- `symbol`
- `research_score`
- `symbol_decision`
- `portfolio_decision`
- `risk_decision`
- `execution_status`
- `failure_code`
- `review_result`

---

## 11. Phase 1~5 로드맵

## Phase 1. 기준선 고정

목표:

- 재설계 방향 문서화
- 역할 경계 확정
- `n8n` / `RAG` 위치 확정
- validation budget, live gate, stale 정책 기준선 고정

핵심 산출물:

- 역할 재정의 문서
- 정책/검증 기준 문서
- strategy/validation 데이터 모델 초안

완료 기준:

- 루나팀 재설계 방향이 문서로 고정되어 있고
- health/report/suggestion이 같은 정책 결론을 말한다.

## Phase 2. 책임 재배치

목표:

- `Luna` constrained decision 구조화
- `Nemesis` policy 분해
- `Chronos` 승격 준비

핵심 작업:

- `L20 hard-rules` 실체화
- validation budget policy 분리
- debate 조건부 실행
- portfolio decision을 constrained selection으로 축소

완료 기준:

- BUY/SELL 후보 생성과 정책 소거가 명확히 분리됨
- policy rejection reason이 구조적으로 분해됨

## Phase 3. 검증 코어 도입

목표:

- backtest
- walk-forward
- shadow validation
- promotion gate 도입

핵심 작업:

- `Chronos` 중심 deterministic validation pipeline
- 전략 version + parameter snapshot 기록
- expected vs realized 비교 구조 도입

완료 기준:

- 전략은 최소한 backtest + walk-forward + shadow를 거쳐야 승격 후보가 됨

## Phase 4. 엔진 고도화

목표:

- prediction engine
- validation engine
- strategy registry 자동화

핵심 작업:

- 확률 feature 공급 엔진 연동
- 승격/강등 판단 자동화
- regime-aware validation

완료 기준:

- validation 결과가 policy 조정과 strategy promotion에 자동 반영됨

## Phase 5. SaaS 확장 준비

목표:

- 멀티워크스페이스 구조 대응
- 고객별 policy profile 분리
- 전략 운영 SaaS 기반 마련

핵심 작업:

- workspace-scoped strategy registry
- workspace-scoped policy profile
- workspace-scoped validation history

완료 기준:

- 루나팀 구조가 단일 내부 운영을 넘어 외부 고객별 운영으로 확장 가능함

---

## 12. Phase별 우선순위 판단

지금 당장 필요한 구조:

- `Phase 1`
- `Phase 2`

나중에 확장할 구조:

- `Phase 3`
- `Phase 4`
- `Phase 5`

핵심 판단:

- 지금 루나팀은 새 분석가 추가보다
- `결정권 재배치`, `정책 분해`, `검증 승격`
이 먼저다.

---

## 13. 최종 판단

루나팀은 지금

- 더 많은 에이전트를 붙이는 단계가 아니라
- **결정권을 재배치하고 검증권을 강화하는 단계**

다.

가장 중요한 방향은 아래와 같다.

1. 연구는 유지한다.
2. `Luna`의 자유 생성형 결정권은 축소한다.
3. `Nemesis`를 정책 엔진으로 분해한다.
4. `Chronos`를 검증 코어로 승격한다.
5. `n8n`은 orchestration에 한정한다.
6. `RAG`는 retrieval 보조에 한정한다.
7. 맥스튜디오 도착 후 백테스트/검증 엔진을 가장 먼저 붙인다.

이 방향이

- 내부 MVP의 정확성과 안정성
- 운영 데이터의 신뢰성
- 추후 SaaS 확장성

을 동시에 만족시키는 가장 현실적인 재설계 방향이다.
