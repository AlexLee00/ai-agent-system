# 스카 재예약 회귀 테스트 절차서 (2026-03-22)

## 1. 목적

이 문서는 아래 케이스가 현재 스카 원장에서 자연스럽게 분리되는지 검증하기 위한 운영 절차서다.

- 같은 사람
- 같은 날짜
- 같은 룸
- 기존 예약 `09:00~13:00`
- 기존 예약 취소
- 같은 시작시각으로 새 예약 `09:00~11:00`

핵심 검증 포인트:
- `reservations`는 기존 예약과 재예약을 구분하는가
- `cancelled_keys`는 첫 예약 취소만 기록하는가
- `kiosk_blocks`는 `phone|date|start|end|room` v2 키 기준으로 두 예약을 다른 row로 저장하는가
- 리포트/헬스가 새 예약을 과거 취소의 잔상으로 오해하지 않는가

---

## 2. 사전 조건

- `naver-monitor`: 실행 중
- `kiosk-monitor`: 중지 유지
- 현재 스키마 버전:
  - `v7 kiosk_block_key_v2` 적용 완료
- 테스트 대상 룸/시간은 실제 운영에 영향이 없는 슬롯을 사용
- 테스트 예약은 운영자 직접 생성/취소로 진행

권장 확인 명령:

```bash
node /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/migrate.js --version
```

기대값:
- `kiosk-monitor: 미로드`
- 스키마 버전 `v7`

---

## 3. 테스트 시나리오

### Step A. 초기 예약 생성

테스트 예약:
- 전화번호: 테스트 번호 1개
- 날짜: 미래 날짜 1개
- 룸: `A1`
- 시간: `09:00~13:00`

확인할 것:
- 네이버 예약 생성
- 픽코 예약 생성 또는 수동 등록
- 필요 시 `kiosk_blocks` row 생성

### Step B. 첫 예약 취소

동일 예약 `09:00~13:00 A1`을 취소한다.

확인할 것:
- 네이버 취소 감지
- 픽코 취소
- 기존 예약 row는 취소 상태로 전환

### Step C. 같은 날/같은 룸/같은 시작시각으로 재예약

같은 사람, 같은 날짜, 같은 룸에 아래 예약을 다시 등록한다.

- 시간: `09:00~11:00`

확인할 것:
- 새 예약이 과거 취소 예약과 별도 row로 인식되는가
- `kiosk_blocks`가 새 row를 덮어쓰지 않고 분리 저장하는가

---

## 4. DB 점검 절차

### 4-1. reservations 확인

확인 기준:
- 기존 `09:00~13:00` row
- 새 `09:00~11:00` row

둘 다 존재해야 하며, 상태는 아래처럼 기대한다.

- 기존 예약:
  - `status = cancelled` 또는 취소 완료 상태
- 재예약:
  - `status = completed` 또는 현재 활성 상태

권장 점검 쿼리:

```sql
SELECT
  id,
  composite_key,
  phone,
  date,
  start_time,
  end_time,
  room,
  status,
  pickko_status,
  marked_seen
FROM reservation.reservations
WHERE phone = '테스트번호'
  AND date = 'YYYY-MM-DD'
  AND room = 'A1'
ORDER BY start_time, end_time;
```

### 4-2. cancelled_keys 확인

확인 기준:
- 첫 예약 `09:00~13:00`에 대한 취소 key만 남아야 한다
- 새 예약 `09:00~11:00`는 취소 key로 오염되면 안 된다

### 4-3. kiosk_blocks 확인

핵심 검증 포인트:
- 기존 `09:00~13:00 A1`
- 새 `09:00~11:00 A1`

위 두 건이 **서로 다른 row**로 존재해야 한다.

권장 확인 항목:
- `id`
- `date`
- `start_time`
- `end_time`
- `room`
- `naver_blocked`
- `last_block_result`
- `last_block_reason`

권장 점검 쿼리:

```sql
SELECT
  id,
  date,
  start_time,
  end_time,
  room,
  naver_blocked,
  last_block_result,
  last_block_reason,
  blocked_at,
  naver_unblocked_at
FROM reservation.kiosk_blocks
WHERE date = 'YYYY-MM-DD'
  AND start_time = '09:00'
  AND room = 'A1'
ORDER BY end_time;
```

기대 결과:
- `09:00~13:00` row 1건
- `09:00~11:00` row 1건
- 서로 다른 `id`

---

## 5. 판정 기준

### 성공

아래 4개를 모두 만족하면 성공이다.

1. `reservations`에 기존 취소 예약과 재예약이 분리되어 존재
2. `cancelled_keys`가 새 재예약을 과거 취소로 잘못 먹지 않음
3. `kiosk_blocks`에 `09:00~13:00`와 `09:00~11:00`가 서로 다른 row로 존재
4. 리포트/헬스에서 새 재예약이 과거 취소의 잔상으로 오해되지 않음

### 실패

아래 중 하나라도 보이면 실패다.

1. `kiosk_blocks`에서 기존 row가 새 예약으로 덮어써짐
2. 재예약이 과거 취소 key와 충돌해 자동 처리 누락
3. 리포트가 새 재예약을 취소/과거 이력으로 잘못 표시
4. 같은 `phone/date/start`에서 `end/room`이 다른데 row가 1건만 남음

---

## 6. 실패 시 우선 분석 포인트

우선순위 순서:

1. `kiosk_blocks` 조회 경로
   - `getKioskBlock(phone,date,start,end,room)`가 실제 호출부에서 `end/room`을 제대로 전달받는지
2. `getOpenManualBlockFollowups()` join
   - `end_time`, `room`까지 정확히 반영되는지
3. `pickko-kiosk-monitor.js`
   - 신규/재시도/해제 경로에서 legacy 조회가 남아 있는지
4. `cancelled_keys`
   - bookingId 기반 취소 key와 fallback key가 재예약을 오염시키는지

---

## 7. 운영 메모

지금 당장 필요한 구조:
- `kiosk-monitor`는 계속 꺼둔 채 회귀 테스트로 원장 정합성을 먼저 확인
- 재예약 케이스를 운영 truth 기준으로 검증

나중에 확장할 구조:
- `kiosk_blocks`를 event log + current snapshot 이중 구조로 분리
- 부분취소/재예약/시간변경/룸변경을 모두 immutable event로 남기기
- SaaS 확장 시 workspace 단위 재예약 충돌 메트릭 추가
