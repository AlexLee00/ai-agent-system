# 개발 프롬프트: Phase D — 에이전트 진입점 Hub 커넥터 연결

> 작성: 메티 (전략+설계)
> 실행: 코덱스 (코드 구현)
> 환경: 맥북 에어 (DEV)
> 작성일: 2026-03-30

---

## 0. 코드 병합 전 참고사항

### OPS에서 변경된 내용 (git pull로 받을 것)

| 커밋 | 내용 |
|------|------|
| `716e0e1` | `env.js` — `HUB_BASE_URL` OPS에서도 활성화 |
| `2d1ff2e` | `docs/ROLE_PRINCIPLES.md` 신규 (역할 분담 원칙) |

### DEV에서 pull 후 확인할 것

```bash
cd ~/projects/ai-agent-system
git pull origin main --ff-only

# 1. env.js 변경 확인 (HUB_BASE_URL 기본값)
node -e "
const env = require('./packages/core/lib/env');
console.log('HUB_BASE_URL:', env.HUB_BASE_URL);
console.log('USE_HUB:', env.USE_HUB);
console.log('USE_HUB_SECRETS:', env.USE_HUB_SECRETS);
"
# 기대: HUB_BASE_URL=http://localhost:7788, USE_HUB=true, USE_HUB_SECRETS=true

# 2. DEV 동작 영향 없음 확인
#    USE_HUB는 IS_DEV && !!HUB_BASE_URL → DEV에서 기존과 동일
#    OPS에서만 HUB_BASE_URL이 null → http://localhost:7788로 변경됨
```

### 역할 원칙 (필독)

`docs/ROLE_PRINCIPLES.md` 참고:
- 메티: 기획/설계/코드점검 — 코드 직접 수정 금지
- 코덱스: 프롬프트 기반 코드 구현
- 코덱스 구현 후 → 메티가 점검 (문법/소프트/하드)

---

## 1. 현재 상태

P5-1 Hub 커넥터 코드가 배포되었고, `USE_HUB_SECRETS=true` 플래그도 활성화됨.
하지만 **에이전트 진입점에서 `initHubConfig()`/`initHubSecrets()`를 호출하지 않아서**
실제로는 로컬 config.yaml 폴백으로 동작 중.

Hub가 메인 경로가 되려면, 각 에이전트 시작 시 init 함수를 호출해야 함.

---

## 2. 수정 대상 파일

### 계통 1: llm-keys.js 사용처 (initHubConfig 호출 필요)

Hub 커넥터: `packages/core/lib/llm-keys.js`의 `initHubConfig()`

진입점 후보 (코덱스가 확인 후 적용):
```
bots/investment/markets/crypto.js     ← ESM, 주기적 실행
bots/investment/markets/domestic.js   ← ESM, 주기적 실행
bots/investment/markets/overseas.js   ← ESM, 주기적 실행
bots/orchestrator/src/index.js        ← 오케스트레이터 메인
bots/claude/src/dexter.js             ← 덱스터 헬스체크
bots/blog/src/*.js                    ← 블로그 팀
bots/worker/src/*.js                  ← 워커 팀
```

### 계통 2: investment/secrets.js 사용처 (initHubSecrets 호출 필요)

Hub 커넥터: `bots/investment/shared/secrets.js`의 `initHubSecrets()`

이 함수는 `loadSecrets()` 전에 호출되어야 함.
investment 진입점(crypto.js, domestic.js, overseas.js)에서 호출.

---

## 3. 수정 패턴

### 패턴 A: ESM 진입점 (investment/markets/*.js)

```javascript
// 기존 코드 (crypto.js 예시)
// ... import 선언부 ...
async function main() {
  // ... 기존 로직
}
main();

// 변경 후
import { initHubSecrets } from '../shared/secrets.js';

async function main() {
  // Hub 시크릿 초기화 (Hub 1순위, 로컬 config.yaml 폴백)
  await initHubSecrets();

  // ... 기존 로직
}
main();
```

### 패턴 B: CJS 진입점 (orchestrator, claude, blog, worker)

```javascript
// 기존 코드
const { initHubConfig } = require('../../../packages/core/lib/llm-keys');

async function main() {
  // Hub LLM 키 초기화 (Hub 1순위, 로컬 config.yaml 폴백)
  await initHubConfig();

  // ... 기존 로직
}
main();
```

### 주의사항

1. `initHubSecrets()`와 `initHubConfig()`는 **async 함수**
   → main() 함수가 async가 아니면 async로 변경 필요
2. 이미 `async function main()` 패턴이면 `await` 한 줄 추가만
3. Hub 실패 시 자동 로컬 폴백이므로, init 호출이 실패해도 프로세스는 정상 동작
4. `initHubSecrets()`는 내부적으로 `/hub/secrets/config` 호출
   `initHubConfig()`는 내부적으로 `/hub/secrets/llm` 호출
   → 둘은 별도 캐시, 각각 호출 필요

---

## 4. 제외 범위

- `bots/reservation/` 진입점은 수정하지 않음 (Phase E에서 별도 처리)
- `initHubConfig`/`initHubSecrets` 함수 자체는 수정하지 않음 (이미 구현됨)
- Hub 서버 코드(`bots/hub/`)는 수정하지 않음

---

## 5. 완료 기준

```bash
# 1. 문법 검사 — 수정한 모든 진입점 파일
find bots/investment/markets -name "*.js" | xargs -I{} node --check {}
node --check bots/orchestrator/src/index.js
node --check bots/claude/src/dexter.js
# ... 수정한 파일 전부

# 2. DEV에서 Hub 커넥터 동작 확인 (SSH 터널 필요)
# SSH 터널: ssh -L 7788:localhost:7788 mac-studio -N -f
USE_HUB_SECRETS=true node --input-type=module -e "
import { initHubSecrets, loadSecrets } from './bots/investment/shared/secrets.js';
await initHubSecrets();
const s = loadSecrets();
console.log('trading_mode:', s.trading_mode);
console.log('anthropic:', !!s.anthropic_api_key);
"

# 3. USE_HUB_SECRETS=false 에서 기존 동작 유지 확인
USE_HUB_SECRETS=false node --input-type=module -e "
import { loadSecrets } from './bots/investment/shared/secrets.js';
const s = loadSecrets();
console.log('trading_mode:', s.trading_mode);
"
# → 로컬 config.yaml에서 정상 로드

# 4. Hub 로그에서 요청 확인 (OPS push 후)
# ssh mac-studio "tail -10 ~/projects/ai-agent-system/bots/hub/hub.log"
# → /hub/secrets/config, /hub/secrets/llm 요청이 보이면 성공
```

---

## 6. 커밋 메시지

```
feat(secrets): Phase D — 에이전트 진입점 Hub 커넥터 연결

- investment/markets/*.js: initHubSecrets() 호출 추가
- orchestrator, claude, blog, worker: initHubConfig() 호출 추가
- Hub 1순위 → 로컬 config.yaml 폴백 구조 완성
- reservation은 Phase E에서 별도 처리
```

---

## 7. 점검 체크리스트 (메티용)

구현 완료 후 메티가 점검할 항목:
- [ ] 수정 파일 전체 `node --check` 통과
- [ ] DEV env.js 로드 정상 (USE_HUB_SECRETS=true)
- [ ] Hub 커넥터 동작 — Hub 경유 시 키 수신
- [ ] Hub 폴백 — Hub 불가 시 로컬 config.yaml 사용
- [ ] 기존 동작 — USE_HUB_SECRETS=false 시 변경 없음
- [ ] OPS push 후 Hub 로그에 secrets 요청 확인
