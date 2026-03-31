# CODEX_PHASE_E_RESERVATION — reservation 진입점 Hub 커넥터 연결

> 실행 대상: 코덱스 (코드 구현)
> 선행 조건: P5-2 reservation-shared 구현 완료 (f3789bd)
> 환경: 맥북 에어 (DEV)
> 작성일: 2026-03-30
> 작성자: 메티 (전략+설계)

---

## 목표

reservation 팀 진입점에 `initHubSharedSecrets()` 호출을 추가.
llm/investment/claude/blog/worker와 동일한 Hub 커넥터 패턴 적용.

```
수정 전: reservation 봇 → loadSecrets() → 로컬 secrets.json만 사용
수정 후: reservation 봇 → initHubSharedSecrets() → Hub 텔레그램 키 병합 → loadSecrets() 
```

## 사전 확인

```bash
cat CLAUDE.md
node --check bots/reservation/lib/secrets.js
grep "initHubSharedSecrets" bots/reservation/lib/secrets.js
# → 48행 async function, 143행 exports 확인
```

---

## 수정 대상 (2파일)

### 1. bots/reservation/src/ska.js (팀장봇, 상시 실행)

패턴: Phase D의 dexter.js/archer.js와 동일 (CJS + async function main)

```javascript
// 기존 require 영역에 추가
const { initHubSharedSecrets } = require('../lib/secrets');

// main() 함수 시작 부분에 추가
async function main() {
  await initHubSharedSecrets();  // ← 추가 (Hub 텔레그램 키 병합)
  acquireLock();
  loadBotIdentity();
  // ... 기존 로직
}
```

### 2. bots/reservation/scripts/health-check.js (10분마다 실행)

```javascript
// 기존 require 영역에 추가
const { initHubSharedSecrets } = require('../lib/secrets');

// main() 함수 시작 부분에 추가
async function main() {
  await initHubSharedSecrets();  // ← 추가
  // ... 기존 로직
}
```

---

## 제외 범위

- `lib/secrets.js` 자체는 수정하지 않음 (이미 구현됨)
- `lib/telegram.js`는 수정하지 않음 (loadSecrets()를 통해 자동 반영)
- Shell script 진입점 (run-*.sh)은 수정하지 않음
- Python 진입점 (etl/eve/forecast)은 수정하지 않음
- `runtime-config.js`는 Phase D에서 이미 처리됨

---

## 완료 기준

```bash
# 1. 문법 검사
node --check bots/reservation/src/ska.js
node --check bots/reservation/scripts/health-check.js

# 2. init 호출 확인
grep -n "initHubSharedSecrets" bots/reservation/src/ska.js
grep -n "initHubSharedSecrets" bots/reservation/scripts/health-check.js

# 3. 기존 동작 유지 (USE_HUB_SECRETS=false)
USE_HUB_SECRETS=false node -e "
const { loadSecrets } = require('./bots/reservation/lib/secrets');
const s = loadSecrets();
console.log('telegram_bot_token:', s.telegram_bot_token ? '✅' : '❌');
console.log('pickko_id:', s.pickko_id ? '✅' : '(없어도 정상 - DEV)');
"
```

## 커밋 메시지

```
feat(secrets): Phase E — reservation 진입점 Hub 커넥터 연결

- ska.js: initHubSharedSecrets() 호출 추가
- health-check.js: initHubSharedSecrets() 호출 추가
- Hub 텔레그램 키 병합, OPS 전용 키(pickko/naver/db) 보존
- llm/investment/claude/blog/worker와 동일 패턴 완성
```
