# Phase E reservation 엔트리포인트 Hub 연결 테스트 체크리스트 — 2026-03-30

> 범위:
> - `bots/reservation/src/ska.js`
> - `bots/reservation/scripts/health-check.js`
> - `bots/reservation/lib/secrets.js`의 `initHubSharedSecrets()` 연동 검증

---

## 1. 코드 점검

### 변경 파일

- `bots/reservation/src/ska.js`
- `bots/reservation/scripts/health-check.js`

### 점검 결과

- [x] `ska.js`는 `main()` 시작 직후 `await initHubSharedSecrets()` 호출
- [x] `health-check.js`는 `main()` 시작 직후 `await initHubSharedSecrets()` 호출
- [x] 두 변경 모두 기존 제어 흐름을 깨지 않고 선초기화만 추가
- [x] `initHubSharedSecrets()` 실패 시에도 내부 폴백으로 기존 로컬 시크릿 경로 유지

### 코드 점검 판정

- 수정 범위가 작고, 변경 의도와 실제 연결 위치가 일치한다
- 이번 Phase E 범위에서는 명확한 회귀 버그를 발견하지 못했다

---

## 2. 소프트 테스트

### 2-1. 문법 검사

- [x] `bots/reservation/src/ska.js`
- [x] `bots/reservation/scripts/health-check.js`
- [x] `bots/reservation/lib/secrets.js`

### 2-2. init 호출 확인

- [x] `ska.js`에 `initHubSharedSecrets` import 존재
- [x] `ska.js`에 `await initHubSharedSecrets()` 존재
- [x] `health-check.js`에 `initHubSharedSecrets` import 존재
- [x] `health-check.js`에 `await initHubSharedSecrets()` 존재

### 2-3. 기존 동작 유지

환경:

- `USE_HUB_SECRETS=false`

결과:

```json
{"telegram":true,"pickko":false,"naver":false}
```

판정:

- 로컬 시크릿 로드는 기존과 동일하게 유지된다
- DEV에서 OPS 전용 키가 비어 있는 상태도 기존 기대와 일치한다

---

## 3. 하드 테스트

### 3-1. reservation-shared Hub 병합

환경:

- `. ~/.zprofile`
- `USE_HUB_SECRETS=true`
- `HUB_BASE_URL=http://127.0.0.1:17788`
- `HUB_AUTH_TOKEN` 로드

실행:

- `initHubSharedSecrets()` 호출 후 `loadSecrets()` 결과 확인

결과:

```json
{"hub":true,"telegram":true,"chat":true,"topics":true}
```

판정:

- DEV에서 OPS Hub 터널 경유 `reservation-shared` 병합 성공
- 텔레그램 공유 키(`bot_token/chat/topic_ids`)가 실제로 로드된다

### 3-2. 진입점 적용 타당성 검토

- [x] `ska.js`는 상단 import 체인에서 `reservation/lib/telegram.js`를 직접 잡지 않음
- [x] `health-check.js`도 시작 전 단계에서 `reservation/lib/telegram.js`를 직접 잡지 않음

판정:

- 이번 두 엔트리포인트에서는 `initHubSharedSecrets()`가 충분히 이른 시점에 실행된다

---

## 4. 잔여 리스크

- `bots/reservation/lib/telegram.js`는 여전히 모듈 로드 시점에 `loadSecrets()`를 캐시한다
- 따라서 다른 reservation 진입점이 `initHubSharedSecrets()`보다 먼저 `telegram.js`를 import하면 Hub 병합 효과가 반영되지 않을 수 있다
- 이번 Phase E 대상(`ska.js`, `health-check.js`)에서는 해당 경로가 확인되지 않았지만, reservation 전반 정리 단계에서 lazy-load 또는 runtime 초기화 패턴 통일이 권장된다

---

## 5. 최종 판정

- [x] Phase E reservation 엔트리포인트 연결 완료
- [x] 로컬 폴백 유지
- [x] `reservation-shared` Hub 병합 실검증 성공
- [x] 현재 수정 범위 기준 push 가능한 상태

### 핵심 결론

**Phase E는 기능적으로 닫혔고, reservation도 다른 팀과 같은 Hub 초기화 패턴으로 정렬되었다.**
