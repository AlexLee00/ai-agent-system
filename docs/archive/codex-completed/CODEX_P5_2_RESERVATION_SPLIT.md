# CODEX_P5_2_RESERVATION_SPLIT — reservation 시크릿 분리 설계

> 목적: reservation 시크릿을 자동배포 친화적으로 Hub 연동하기 위한 2차 설계
> 전제: P5-1 완료 (`llm` + `investment` Hub 커넥터 도입)
> 작성일: 2026-03-30

---

## 1. 결론

`reservation`은 한 번에 Hub 전환하면 안 된다.

이유:

- 예약팀 코드는 `loadSecrets()`를 모듈 로드 시점에 바로 읽는 패턴이 많다.
- 현재 Hub의 `reservation` 응답은 운영 전용 자격증명을 의도적으로 마스킹한다.
- 따라서 기존 `loadSecrets()`를 Hub 1순위로 바로 바꾸면
  일부 운영/수동 스크립트가 즉시 실패한다.

따라서 P5-2는 아래 방식으로 가는 것이 가장 자연스럽다.

```text
reservation_shared  → DEV/OPS 공통으로 Hub 제공 가능
reservation_ops     → OPS 전용, 로컬 파일 유지 또는 별도 정책
```

---

## 2. 현재 키 분류

`bots/reservation/secrets.json` 기준:

### A. 공유 가능 / Hub 제공 가능

- `telegram_bot_token`
- `telegram_chat_id`
- `telegram_group_id`
- `telegram_topic_ids`

이 값들은 현재도 DEV 셋업에서 복사되거나 공유 사용되는 성격에 가깝다.

### B. 운영 전용 / Hub 전역 제공 금지

- `naver_id`
- `naver_pw`
- `pickko_id`
- `pickko_pw`
- `naver_url`
- `pickko_url`
- `db_encryption_key`
- `db_key_pepper`
- `datagokr_holiday_key`
- `datagokr_weather_key`
- `datagokr_neis_key`
- `datagokr_festival_key`

이 값들은 운영 자격증명 또는 암호화 핵심 키라
DEV/자동배포에서 무심코 흘러가면 위험하다.

---

## 3. 실제 코드 사용 패턴

### 공유 가능 값 사용처

- `bots/reservation/lib/telegram.js`
- 알림/주제 분기 로직
- 일부 e2e/모니터링 보조 경로

### 운영 전용 값 사용처

- `pickko_*`:
  - 수동 예약/정산/감사 스크립트
  - 모니터 봇
- `naver_*`:
  - 네이버 모니터
  - 키오스크 모니터
- `db_*`:
  - `bots/reservation/lib/crypto.js`
- `datagokr_*`:
  - 공공데이터 연계 경로

즉 reservation은 단일 묶음이 아니라
실제로도 “알림 그룹”과 “운영 자격증명 그룹”으로 나뉜다.

---

## 4. 권장 목표 구조

### 4-1. Hub 카테고리 분리

현재:

```text
/hub/secrets/reservation
```

권장:

```text
/hub/secrets/reservation-shared
/hub/secrets/reservation-ops   (필요 시)
```

### 4-2. 반환 정책

#### `reservation-shared`

반환:

- `telegram_bot_token`
- `telegram_chat_id`
- `telegram_group_id`
- `telegram_topic_ids`

특징:

- DEV/OPS 모두 허용 가능
- 자동배포에서 먼저 연결해도 리스크 낮음

#### `reservation-ops`

선택지 A:

- Hub에서 아예 제공하지 않음
- 운영 자격증명은 계속 로컬 `secrets.json` 유지

선택지 B:

- OPS 환경에서만 제공
- DEV에서는 403 또는 마스킹

자동배포/보수성 기준 추천은 **선택지 A**다.

---

## 5. reservation/lib/secrets.js 권장 방향

P5-2에서 자연스러운 변경 방향:

1. 기존 `loadSecrets()`는 그대로 유지
2. `initHubSharedSecrets()`만 추가
3. Hub에서 `reservation-shared`만 가져와 캐시에 병합
4. 로컬 `secrets.json`이 항상 최종 운영 자격증명을 보유

예상 동작:

```text
기본:
  loadSecrets() → 기존 로컬 파일

선택적 초기화:
  await initHubSharedSecrets()
  → telegram 계열만 Hub 값으로 주입/병합
  → pickko/naver/db 계열은 로컬 유지
```

즉 reservation은 “전체 대체”가 아니라 “부분 병합”이 맞다.

---

## 6. 자동배포 기준 최적 순서

### Phase 1

- Hub에 `reservation-shared` 추가
- `reservation/lib/secrets.js`에 `initHubSharedSecrets()` 추가
- 기본 동작은 그대로 유지

### Phase 2

- 텔레그램 관련 시작점에서만 선택적으로 초기화
- DEV에서 알림 경로 검증

### Phase 3

- 필요하면 OPS 전용 자격증명 정책 논의
- 그 전까지 `pickko/naver/db`는 로컬 유지

---

## 7. 왜 이 방식이 자연스러운가

- 현재 코드 구조를 거의 안 깨뜨림
- 자동배포 중간 상태에서도 기존 운영 스크립트가 안 죽음
- reservation의 민감 키를 DEV로 흘리지 않음
- 향후 통합이 필요하면 그때 `reservation-ops`를 따로 논의할 수 있음

즉 “지금 필요한 것”과 “나중에 더 공격적으로 정리할 것”이 분리된다.

---

## 8. P5-2 1차 구현 범위 제안

포함:

- `bots/hub/lib/routes/secrets.js`
  - `reservation-shared` 카테고리 추가
- `bots/reservation/lib/secrets.js`
  - `initHubSharedSecrets()` 추가
  - telegram 계열만 Hub 병합
- 간단 검증 문서/명령

제외:

- `reservation-ops` 구현
- `pickko/naver/db` Hub 제공
- reservation 전 경로의 일괄 초기화

---

## 9. 한 줄 정리

> P5-2의 핵심은 reservation 전체를 Hub로 옮기는 것이 아니라, `shared`와 `ops`를 분리해서 안전한 값만 먼저 Hub에 올리는 것이다.

