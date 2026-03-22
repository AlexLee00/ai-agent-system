# 스카 Operation Queue 설계 초안 (2026-03-22)

## 1. 목적

이 문서는 스카 예약 자동화의 차후 확장 구조로 `operation_queue`를 도입할 때 필요한 설계 기준을 정리한다.

현재 source of truth:
- [pickko-kiosk-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.js)
- [naver-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.js)
- [db.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/db.js)

현재 운영 원칙:
- 지금은 `operation_queue`를 구현하지 않는다
- 현재는 **in-memory 직렬화 강화**로 같은 고객 연속 작업 충돌을 완화한다
- `operation_queue`는 멀티단계 write-path와 멀티워크스페이스 SaaS 확장에 대비한 차후 구조다

---

## 2. 현재 구조와 한계

현재 스카 자동화는 다음 흐름으로 동작한다.

- 네이버 예약 감지 -> 픽코 등록
- 네이버 취소 감지 -> 픽코 취소
- 픽코 예약 감지 -> 네이버 차단
- 픽코 취소 감지 -> 네이버 해제

현재까지 반영된 안정화:
- `manual` 락 우선
- `manual follow-up` 자동 루프 분리
- `phone|date|start|end|room` 기준 dedupe
- `phone|date` 기준 고객 단위 cooldown / 순차 처리

하지만 현재 구조의 한계는 명확하다.

1. 작업이 원장에 **이벤트로 영속화**되지 않는다
2. 재시도/우선순위/의존관계를 별도 큐로 설명하지 못한다
3. 실패 이력이 `작업 이벤트`보다 `결과 row` 중심으로 남는다
4. 멀티프로세스/멀티워크스페이스로 확장 시 스케줄링 일관성이 약하다

즉 지금은 내부 MVP 관점에서 충분히 빠르고 실용적이지만,
장기적으로는 `operation_queue`가 필요하다.

---

## 3. 왜 지금은 미도입인가

현재 phase에서 `operation_queue`를 바로 넣지 않은 이유는 아래와 같다.

### 3-1. 지금 당장 필요한 구조

- 같은 고객의 연속 작업 충돌 완화
- 네이버 UI 처리 안정성 보강

이 두 가지는 기존 레이어를 유지한 채 해결할 수 있다.

### 3-2. operation_queue 도입 비용

- 새 테이블 설계
- producer / consumer 분리
- 기존 `naver-monitor`, `pickko-kiosk-monitor`, 수동 command와 계약 재정의
- 상태 전이 / 재시도 / 우선순위 모델 추가
- 운영 리포트와 handoff 문서 전면 조정

즉 현재는 정확성과 안정성을 해치지 않는 범위에서
**작은 수정으로 큰 효과를 보는 단계**이므로,
`operation_queue`는 설계 문서로 먼저 고정하는 것이 적절하다.

---

## 4. 현재 1단계 대안: in-memory 직렬화 강화

현재 이미 반영된 1차 구조는 아래와 같다.

- 기준 key: `phone|date`
- 같은 고객/같은 날짜의 예약 차단/해제 작업을 정렬
- 직전 작업 완료 후 `customerOperationCooldownMs`만큼 대기
- 같은 프로세스 안에서 순차 실행

이 구조의 의미:
- 새 큐 테이블 없이도 연속 작업 충돌을 1차로 줄인다
- 운영 리스크가 낮다
- 기존 deterministic pipeline을 존중한다

이 문서에서 말하는 `operation_queue`는
이 1단계를 넘어서는 **차후 영속 큐 구조**다.

---

## 5. operation_queue 도입 목표

### 목표 1. 작업 이벤트 영속화

예약/취소/차단/해제 작업을 “결과”가 아니라 “이벤트”로 저장한다.

예:
- `reserve_pickko`
- `cancel_pickko`
- `block_naver_slot`
- `unblock_naver_slot`

### 목표 2. 그룹 단위 직렬화

같은 고객, 같은 날짜, 같은 예약군을 같은 그룹으로 묶어
동시에 처리하지 않도록 한다.

### 목표 3. 재시도/우선순위 명시화

현재는 retryable failure가 결과 row에 남지만,
향후에는 큐 레벨에서
- retry policy
- priority
- cooldown
- dependency
를 다뤄야 한다.

### 목표 4. 멀티워크스페이스 SaaS 확장

workspace별 분리와 작업 관리를 가능하게 한다.

---

## 6. 권장 테이블 스키마 초안

권장 테이블명:
- `reservation.operation_queue`

권장 컬럼 초안:

```sql
CREATE TABLE reservation.operation_queue (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  operation_type TEXT NOT NULL,
  operation_group_key TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  source_ref_type TEXT,
  source_ref_id TEXT,
  payload_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority TEXT NOT NULL DEFAULT 'normal',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  not_before_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

권장 인덱스:

```sql
CREATE INDEX idx_operation_queue_ready
ON reservation.operation_queue (status, priority, not_before_at, created_at);

CREATE INDEX idx_operation_queue_group
ON reservation.operation_queue (workspace_id, operation_group_key, status);
```

---

## 7. operation_type 제안

초기 operation_type 후보:

- `reserve_pickko`
- `cancel_pickko`
- `block_naver_slot`
- `unblock_naver_slot`
- `verify_naver_block`
- `verify_naver_unblock`
- `manual_followup_review`

운영 의미:
- write-path와 verify-path를 분리
- 향후 상태확인형 네이버 UI 처리와 자연스럽게 연결 가능

---

## 8. operation_group_key 제안

현재 MVP 권장:
- `phone|date`

차후 세분화 가능:
- `workspace|phone|date`
- `workspace|phone|date|room`
- `reservation_composite_key`

현재 판단:
- 같은 고객의 연속 예약/취소 충돌이 핵심이므로
- 1차 그룹 키는 `phone|date`가 가장 실용적

---

## 9. producer / consumer 구조

### producer

작업을 큐에 넣는 주체:

- `naver-monitor.js`
  - 예약 감지 -> `reserve_pickko`
  - 취소 감지 -> `cancel_pickko`
- `pickko-kiosk-monitor.js`
  - 예약 감지 -> `block_naver_slot`
  - 취소 감지 -> `unblock_naver_slot`
- 수동 command / 운영 도구
  - `manual_followup_review`
  - `verify_naver_block`

### consumer

작업을 실제로 수행하는 주체:

- 초기에는 `ska-operation-worker` 단일 consumer 권장
- 한 번에 하나의 `operation_group_key`만 실행

운영 의미:
- 같은 그룹 작업은 consumer 레벨에서 직렬화
- 같은 슬롯/같은 고객 충돌을 큐에서 제어 가능

---

## 10. 상태 전이 초안

권장 상태:

- `queued`
- `blocked`
- `running`
- `succeeded`
- `failed_retryable`
- `failed_terminal`
- `cancelled`

예시:

1. producer가 작업 insert
2. consumer가 `queued -> running`
3. 성공 시 `running -> succeeded`
4. 재시도 가능 실패 시 `running -> failed_retryable`
5. 더 이상 시도 가치 없으면 `running -> failed_terminal`

---

## 11. 재시도 정책 초안

operation_type별 재시도 정책을 다르게 두는 것이 좋다.

예:
- `block_naver_slot`
  - UI timeout / detached frame / verify_failed
  - retryable
- `unblock_naver_slot`
  - retryable
- `reserve_pickko`
  - member/date/slot 단계별 오류 코드에 따라 분기
- `cancel_pickko`
  - retryable / terminal 구분

지금 당장 필요한 구조:
- 재시도 정책은 아직 코드 안에 흩어져 있음

나중에 확장할 구조:
- 큐 레벨에서 `not_before_at`, `attempt_count`, `last_error_code`로 통합

---

## 12. result_json / audit trail

각 작업은 결과 JSON을 남겨야 한다.

예:

```json
{
  "ok": true,
  "reason": "blocked",
  "beforeState": "available",
  "afterState": "blocked",
  "verified": true,
  "uiScreenshot": "/tmp/..."
}
```

이 구조는 운영 안정성에 중요하다.

- 실패 이력
- 운영자 수정 이력
- 사용자 피드백 구조
- 향후 품질 분석

모두 여기서 재사용 가능하기 때문이다.

---

## 13. 현재 원장과의 관계

`operation_queue`가 들어와도 기존 원장을 버리지는 않는다.

기존 원장:
- `reservations`
- `cancelled_keys`
- `kiosk_blocks`

차후 역할 분리:
- `operation_queue`
  - 작업 이벤트와 실행 상태
- `reservations / kiosk_blocks`
  - 현재 스냅샷 결과

즉 구조는
- **event log + current snapshot**
로 가는 것이 맞다.

---

## 14. 단계별 도입 계획

### Phase 1

현재 완료:
- in-memory 고객 단위 직렬화
- 수동 우선 락
- manual follow-up 분리

### Phase 2

다음 권장:
- 네이버 슬롯 상태확인형 보강
- `block/unblock` 결과를 더 구조화

### Phase 3

그 다음:
- `operation_queue` 테이블 추가
- producer 일부부터 큐 insert 전환

### Phase 4

마지막:
- 전 작업을 큐 consumer 중심으로 전환
- 메트릭/리포트/운영 대시보드 연결

---

## 15. 리스크

### 현재 리스크

- 큐를 너무 빨리 도입하면 현재 운영 안정화보다 범위가 커질 수 있음
- 기존 모니터와 수동 경로 contract를 동시에 바꾸면 회귀 위험이 큼

### 차후 리스크

- queue가 생겨도 네이버 UI가 불안정하면 성공률은 제한적
- 따라서 queue는 UI 안정화 이후 도입하는 것이 더 효과적

---

## 16. 최종 판단

코덱 권장 방향:

- **지금 당장 필요한 구조**
  - in-memory 직렬화 유지/관찰
  - 네이버 UI 상태확인형 보강

- **나중에 확장할 구조**
  - `operation_queue`
  - event log + snapshot 구조
  - workspace별 queue scope

즉 `operation_queue`는 맞는 방향이지만,
현재 phase에서는 설계 문서로 고정하고
다음 안정화 단계가 끝난 뒤 도입하는 것이 가장 안전하다.

