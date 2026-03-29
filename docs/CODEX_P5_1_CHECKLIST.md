# CODEX_P5_1_CHECKLIST — 1차 구현 체크리스트

> 범위: `llm` + `investment` Hub 커넥터 1차 도입
> 원칙: 자동배포 안전성 우선, 기본 동작 유지, 플래그 후활성화

---

## 1. 구현 범위

- [ ] `packages/core/lib/env.js`
  - [ ] `USE_HUB_SECRETS` 추가
  - [ ] 기본값은 보수적으로 `false`
  - [ ] exports에 추가

- [ ] `packages/core/lib/hub-client.js`
  - [ ] 신규 생성
  - [ ] `fetchHubSecrets(category, timeoutMs=3000)` 구현
  - [ ] `USE_HUB_SECRETS=false`면 즉시 `null`
  - [ ] 오류/타임아웃 시 `null` 반환

- [ ] `packages/core/lib/llm-keys.js`
  - [ ] `initHubConfig()` 추가
  - [ ] Hub `llm` 1순위
  - [ ] 로컬 `config.yaml` 폴백 유지
  - [ ] 기존 getter 시그니처 유지

- [ ] `bots/investment/shared/secrets.js`
  - [ ] `_hubClient` 추가
  - [ ] `_hubInitDone` 추가
  - [ ] `initHubSecrets()` 추가
  - [ ] Hub `config` 1순위
  - [ ] 기존 `loadSecrets()` 폴백 유지

---

## 2. 제외 범위

- [ ] `bots/reservation/lib/secrets.js` 변경하지 않음
- [ ] OPS 기본 Hub 강제하지 않음
- [ ] 엔트리포인트 일괄 선초기화 넣지 않음
- [ ] config/secrets 물리 통합하지 않음

---

## 3. 검증

- [ ] `node --check packages/core/lib/env.js`
- [ ] `node --check packages/core/lib/hub-client.js`
- [ ] `node --check packages/core/lib/llm-keys.js`
- [ ] `node --check bots/investment/shared/secrets.js`

- [ ] `node -e "const env = require('./packages/core/lib/env'); console.log(env.USE_HUB_SECRETS)"`
- [ ] `node -e "const { fetchHubSecrets } = require('./packages/core/lib/hub-client'); fetchHubSecrets('llm').then(v => console.log(v ? 'hub' : 'fallback'))"`
- [ ] `USE_HUB_SECRETS=false node -e "const { getAnthropicKey } = require('./packages/core/lib/llm-keys'); console.log(!!getAnthropicKey())"`

---

## 4. 배포 후 확인

- [ ] OPS에서 `/hub/secrets/llm` 응답 확인
- [ ] OPS에서 `/hub/secrets/config` 응답 확인
- [ ] DEV에서 토큰 포함 Hub 호출 확인
- [ ] 플래그 OFF 상태에서 기존 동작 유지 확인
- [ ] 이후 `USE_HUB_SECRETS=true` 활성화 여부 별도 결정

