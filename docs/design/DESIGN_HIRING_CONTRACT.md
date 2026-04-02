# 고용 계약 시스템 설계서

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> Phase 1 세 번째: 에이전트가 최선을 다하게 하는 구조적 장치

---

## 1. 개요

```
고용 계약 = 팀장이 에이전트를 작업에 투입하는 공식 프로세스

현재: 에이전트가 하드코딩된 순서로 실행 (정적)
목표: 팀장이 작업 목표 수신 → Registry에서 최적 에이전트 선택 → 계약 체결 → 실행 → 평가

핵심 원칙 (학술 근거):
  Principal-Agent Contract Theory (노벨경제학상 2016)
  Confidence-weighted Rewards (arXiv 2505.18286)
  Auto-adjusting Incentives — +22% (arXiv 2409.02960)
```

---

## 2. 계약서 구조 (agent.contracts 테이블 활용)

```json
{
  "contract_id": "CTR-2026-04-02-001",
  "employer": {
    "team": "blog",
    "leader": "blo"
  },
  "agent": {
    "name": "pos",
    "role": "writer",
    "model": "anthropic"
  },
  "task": {
    "type": "lecture_post",
    "description": "Node.js 57강 포스팅 작성",
    "deadline_ms": 300000
  },
  "requirements": {
    "min_chars": 9000,
    "sections": ["핵심요약", "인사말", "브리핑", "이론", "코드", "FAQ"],
    "ai_risk_max": 70,
    "quality_min": 7.0
  },
  "reward": {
    "base_score": 1.0,
    "quality_bonus": 0.5,
    "speed_bonus": 0.2,
    "confidence_multiplier": true
  },
  "penalty": {
    "quality_fail": -0.5,
    "deadline_miss": -0.3,
    "hallucination": -1.0,
    "overconfident_wrong": -0.8
  },
  "terms": {
    "max_retries": 2,
    "replacement_allowed": true,
    "monitoring_days": 7
  }
}
```

---

## 3. 5가지 인센티브 메커니즘

```
① 성과 기반 고용 (Performance-based Hiring)
  → getTopAgents(role, limit=3) → 점수 상위 에이전트 우선 고용
  → 점수 낮으면 고용 안 됨 = 다음 기회 상실
  → 구현: agent.registry.score DESC 정렬 → 상위 N명 선택

② 자가 확신도 보고 (Confidence Scoring)
  → 에이전트가 결과물에 확신도(1~10) 자가 보고
  → 시스템 프롬프트: "결과물의 품질 확신도를 1~10으로 보고하라"
  → 점수 계산:
    확신 높고(≥7) + 결과 좋음(≥8) = score × 1.2 (보너스)
    확신 높고(≥7) + 결과 나쁨(<6) = score × 0.7 (허세 페널티)
    확신 낮고(<5) + 결과 좋음(≥8) = score × 1.0 (겸손 실력자)
    확신 낮고(<5) + 결과 나쁨(<6) = score × 0.9 (솔직한 부족)

③ 경쟁 압력 (Competition Pressure)
  → 같은 역할 에이전트 여러 명 → 대체 가능
  → 그룹 경쟁 패배 → 다음 고용 확률 감소
  → 구현: 역할별 에이전트 풀 크기 ≥ 2명 유지

④ 하이브리드 인센티브 (Hybrid Incentives)
  → 보상(reward) + 페널티(penalty) 균형
  → hallucination 페널티 최고 (-1.0)
  → quality_bonus 최고 (+0.5)
  → 구현: evaluateContract() 함수에서 자동 계산

⑤ 학습 강화 복귀 기회 (Rehabilitation Path)
  → 점수 하위 20% → 메딕(연구팀) 진단
  → 멘토(연구팀) 재교육 프로그램
  → 재시험 통과 → 풀 복귀 (status=idle)
  → 미통과 → 아카이브 (status=archived)
```

---

## 4. 고용 워크플로우

```
[1] 팀장이 작업 목표 수신
  → 블로(팀장): "오늘 IT 강의 포스팅 1건 + 일반 포스팅 1건"
  ↓
[2] 필요 역할 산출
  → 강의: writer(IT기술) + researcher + publisher
  → 일반: writer(감성) + researcher + publisher
  ↓
[3] Agent Registry 조회
  → getTopAgents('writer', 3) → [pos(9.2), gems(8.7), ...]
  → 팀장이 최적 에이전트 선택
  ↓
[4] 계약 체결
  → createContract(agent, task, requirements, reward, penalty)
  → agent.contracts INSERT (status=active)
  → agent.registry UPDATE (status=active)
  → WebSocket: agent:contract_start (대시보드 카드 이동)
  ↓
[5] 작업 실행
  → 에이전트가 작업 수행
  → 완료 시 확신도(1~10) 자가 보고
  ↓
[6] 품질 평가
  → 요구사항 대비 결과 검증 (글자수, 섹션, AI리스크, 품질)
  → 확신도 + 결과 → 점수 계산 (인센티브 ② 적용)
  ↓
[7] 계약 완료 + 점수 반영
  → completeContract(contractId, { result, score, confidence })
  → agent.performance_history INSERT
  → agent.registry.score UPDATE (이동 평균)
  → agent.registry.emotion_state UPDATE (자신감/피로/동기)
  → WebSocket: agent:contract_end + agent:score_update
  ↓
[8] 실패 시 처리
  → quality < requirements.quality_min → 재시도 (max 2회)
  → 2회 실패 → replacement_allowed=true → 다른 에이전트 교체
  → 교체 실패 → 팀장에게 "작업 실패" 보고
```

---

## 5. 점수 계산 공식

```
기본 점수 = base_score(1.0)

보너스:
  + quality_bonus(0.5) × (result_quality - quality_min) / (10 - quality_min)
  + speed_bonus(0.2) × (deadline_ms - actual_ms) / deadline_ms  (빠를수록)

페널티:
  - quality_fail(0.5) × max(0, quality_min - result_quality) / quality_min
  - deadline_miss(0.3)  (시간 초과 시)
  - hallucination(1.0)  (존재하지 않는 API 사용 등)

확신도 보정:
  final_score = raw_score × confidence_multiplier

Registry 점수 갱신 (지수 이동 평균):
  new_score = old_score × 0.7 + task_score × 0.3
  (최근 작업에 30% 가중, 이력에 70% 가중)

내적 상태 갱신:
  성공 시: confidence += 0.5, motivation += 0.3, fatigue += 0.5
  실패 시: confidence -= 0.8, motivation -= 0.5, fatigue += 1.0
  모든 값: 0~10 범위 클램핑
```

---

## 6. API (packages/core/lib/hiring-contract.js)

```js
// 고용 프로세스
selectBestAgent(role, team, requirements)  // 최적 에이전트 선택
createContract(agentName, contractData)     // 계약 생성
executeContract(contractId)                 // 작업 실행 트리거
evaluateContract(contractId, result)        // 결과 평가 + 점수 계산
completeContract(contractId)               // 계약 완료 + Registry 갱신
retryContract(contractId)                  // 재시도 (max 2회)
replaceAgent(contractId, newAgentName)     // 에이전트 교체

// 조회
getActiveContracts(team)                   // 진행 중 계약
getContractHistory(agentName, days)        // 에이전트 계약 이력
```

---

## 7. 구현 계획

```
Step 1: hiring-contract.js 핵심 로직
  → selectBestAgent, createContract, evaluateContract
  → 점수 계산 공식 구현

Step 2: 팀장 오케스트레이터 연동
  → 블로팀 maestro.js에서 hiring-contract 사용
  → 기존 하드코딩된 에이전트 호출 → 동적 선택으로 전환

Step 3: 확신도 보고 연동
  → 각 에이전트 시스템 프롬프트에 확신도 보고 지시 추가
  → LLM 응답에서 확신도 파싱

Step 4: 대시보드 WebSocket 연동
  → contract_start/end 이벤트 발행
  → 대시보드 카드 이동 트리거

Step 5: 검증
  → 블로팀에서 1회 전체 프로세스 실행
  → 목표→선택→계약→실행→평가→점수갱신 확인
```
