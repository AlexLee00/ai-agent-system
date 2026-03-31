# P5 테스트 체크리스트 — 2026-03-30

> 범위:
> - P5-1: `llm` + `investment` Hub 커넥터
> - P5-2 1차: `reservation-shared` 분리 + 선택 병합 로더

---

## 1. 코드 점검

### 변경 커밋

- `e0799e6` `feat(secrets): add P5-1 hub connectors for llm and investment`
- `fa98cf9` `chore(lockfile): sync hub workspace entry`
- `f3789bd` `feat(secrets): split reservation shared hub path`

### 확인 결과

- [x] 로컬 워킹트리 clean 여부 확인
- [x] 변경 범위가 설계 문서와 일치
- [x] `reservation`은 전체 전환이 아니라 `shared` 분리로 유지
- [x] `USE_HUB_SECRETS` 기본값이 `false`

---

## 2. 소프트 테스트

### 2-1. 문법 검사

- [x] `packages/core/lib/env.js`
- [x] `packages/core/lib/hub-client.js`
- [x] `packages/core/lib/llm-keys.js`
- [x] `bots/investment/shared/secrets.js`
- [x] `bots/hub/lib/routes/secrets.js`
- [x] `bots/reservation/lib/secrets.js`

결과:

```text
SYNTAX_OK
hub_route_ok
reservation_ok
```

### 2-2. P5-1 로컬 폴백 동작

- [x] `USE_HUB_SECRETS=false` 상태에서 `llm-keys.js`가 로컬 파일 경로 유지
- [x] `USE_HUB_SECRETS=false` 상태에서 `investment/shared/secrets.js`가 로컬 파일 경로 유지

결과:

- `local-ok`
- `paper_mode=true`
- `trading_mode=paper`

### 2-3. P5-2 로컬 라우트 검증

- [x] `reservation-shared` 라우트 모의 호출 성공
- [x] 텔레그램 계열만 반환되는지 확인

결과:

- `telegram_bot_token`
- `telegram_chat_id`
- `telegram_group_id`
- `telegram_topic_ids`

운영 자격증명은 반환되지 않음

---

## 3. 하드 테스트

### 3-1. OPS Hub 상태 확인

- [x] `ssh mac-studio 'curl -s http://localhost:7788/hub/health'`
- [x] SSH 터널 `127.0.0.1:17788 -> mac-studio:7788` 확인

결과:

- Hub health 정상
- PostgreSQL 정상
- n8n 정상

### 3-2. P5-1 실제 Hub 경유 테스트

환경:

- `HUB_BASE_URL=http://127.0.0.1:17788`
- `USE_HUB_SECRETS=true`
- `HUB_AUTH_TOKEN` 로드

#### llm

- [x] `fetchHubSecrets('llm')` 성공
- [x] `llm-keys.js -> initHubConfig()` 성공

결과:

- `anthropic,openai,gemini,groq,cerebras,sambanova,xai,billing`
- `{"hub":true,"anthropic":true,"groq":9}`

#### investment

- [x] `investment/shared/secrets.js -> initHubSecrets()` 성공

결과:

- `{"hub":true,"paper_mode":true,"trading_mode":"paper","groq":9}`

### 3-3. P5-2 실제 Hub 경유 테스트

- [ ] `fetchHubSecrets('reservation-shared')` 성공

현재 결과:

- `HTTP 404`

원인:

- 로컬 코드는 반영됐으나 OPS 자동배포가 아직 `f3789bd`까지 반영되지 않음
- OPS 서버 Git 상태 확인 결과 최신 반영 커밋은 `fa98cf9`

판정:

- **코드 결함 아님**
- **배포 반영 대기 상태**

---

## 4. 체크리스트 판정

### P5-1

- [x] 코드 점검 통과
- [x] 소프트 테스트 통과
- [x] 하드 테스트 통과
- [x] 커밋/푸시 완료

판정:

**완료**

### P5-2 1차

- [x] 코드 점검 통과
- [x] 소프트 테스트 통과
- [ ] 하드 테스트 완료
- [x] 커밋/푸시 완료

판정:

**배포 반영 후 하드 테스트 1건 남음**

---

## 5. 최종 브리핑

### 잘 된 점

- P5-1은 설계대로 동작한다
- 자동배포 기준 핵심 요구사항인 `Hub 실패 시 로컬 폴백`이 실제로 검증됐다
- `llm`과 `investment`는 Hub 경유 성공까지 확인됐다
- `reservation`은 전체 전환 대신 `shared` 분리 전략으로 안전하게 진입했다

### 남은 점

- P5-2의 `reservation-shared`는 OPS 자동배포가 최신 커밋을 아직 반영하지 않아
  실제 HTTP 하드 테스트만 남아 있다

### 다음 액션

1. OPS 자동배포가 `f3789bd`를 반영했는지 확인
2. `fetchHubSecrets('reservation-shared')` 재실행
3. 성공 시 P5-2 1차 종료

