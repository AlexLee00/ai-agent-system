# Opus 세션 3~4 인수인계 — 시크릿 통합 전략 최종 확정

> 작성일: 2026-03-29
> 모델: Claude Opus 4.6 (메티)
> 이전: Opus 세션 2 (Hub 설계), 세션 3~4 (DEV 셋업 + 시크릿 커넥터)

---

## 1. 최종 확정된 시크릿 전략

### 지금 (P3 구현): 방법 B — Hub가 내부에서 합침

```
물리적 파일 (OPS 맥 스튜디오):
  bots/investment/config.yaml    ← 290줄 (LLM키, 거래소, 텔레그램, 투자설정)
  bots/reservation/secrets.json  ← 16키 (네이버, 픽코, DB암호화, 공공데이터)
  bots/worker/secrets.json       ← 2키 (JWT, webhook)

Hub가 읽어서 합쳐 반환:
  GET /hub/secrets/config        ← config.yaml 전체 (DEV 안전 오버라이드)
  GET /hub/secrets/llm           ← LLM API 키만 추출
  GET /hub/secrets/telegram      ← bot_token + chat_id
  GET /hub/secrets/exchange      ← 거래소 (paper/testnet 강제)
  GET /hub/secrets/reservation   ← reservation secrets (티어4 마스킹)
```

### 나중 (P5): 방법 A — config.yaml 하나로 통합

```yaml
# config.yaml에 섹션 추가:
reservation:
  naver_id: ...
  pickko_id: ...
  db_encryption_key: ...
worker:
  jwt_secret: ...
  webhook_secret: ...
```

→ secrets.json 2개 파일 제거
→ Hub 코드에서 loadJson() 제거, loadConfigYaml()만 사용
→ reservation/secrets.js, worker 코드 수정


### OPS/DEV 모두 Hub 경유 (일관성)

```
OPS 에이전트 → localhost:7788/hub/secrets/* → Hub가 config.yaml+secrets.json 읽기
                                              → 실패 시 로컬 config.yaml 폴백
DEV 에이전트 → Tailscale:7788/hub/secrets/* → Hub가 config.yaml+secrets.json 읽기
                                              → 실패 시 에러 (로컬 파일 없음)
```

env.js 설정:
- `HUB_BASE_URL`: OPS=`http://localhost:7788`, DEV=`http://localhost:7788`
- `USE_HUB`: DEV만 true (DB/n8n 프록시용)
- `USE_HUB_SECRETS`: OPS+DEV 모두 true (시크릿 일관성)
- Hub 자체만 config.yaml을 직접 읽음 → 순환 의존 없음

---

## 2. Codex 프롬프트 현황

| 프롬프트 | 줄 | 상태 | 내용 |
|----------|-----|------|------|
| P1 (env.js) | 288 | 🔄 Codex 실행 중 | Hub 변수 + USE_HUB_SECRETS 포함 |
| P2 (CI/CD) | ~300 | ⬜ 대기 | 시크릿 티어 주석 추가됨 |
| P3 (Hub) | ~1110 | ⬜ 대기 | 작업 15개 (시크릿 프록시+커넥터 포함) |
| P4 (DEV 셋업) | 563 | ✅ 완성 | setup-dev.sh + sync-dev-secrets.sh |
| P5 (파일 통합) | 미작성 | 🔮 나중 | config.yaml 통합 + secrets.json 제거 |


---

## 3. 이전 세션 누적 산출물

```
Opus 세션 2:
  docs/CODEX_P1_ENV_SPREAD.md     ← Hub 변수 + USE_HUB_SECRETS 추가
  docs/CODEX_P2_CICD.md           ← 시크릿 티어 주석 추가
  docs/CODEX_P3_RESOURCE_HUB.md   ← Hub 전체 구현 (시크릿 작업12~15 포함)
  docs/OPUS_SESSION_2_HANDOFF.md

Opus 세션 3~4:
  docs/DEV_ENV_SETUP_MACBOOK_AIR.md  ← ~570줄 (섹션19 API키 4티어)
  docs/CODEX_P4_DEV_SETUP.md         ← 563줄 (setup-dev + sync-dev-secrets)
  docs/OPUS_SESSION_3_HANDOFF.md     ← 이 문서
```

---

## 4. 다음 세션 작업 순서

### Step 1: P1 Codex 결과 확인
```bash
grep -rn "process\.env\.MODE\b" bots/ --include="*.js" | grep -v node_modules
# → 0건이면 성공
node -e "const env = require('./packages/core/lib/env'); console.log({
  HUB_BASE_URL: env.HUB_BASE_URL,
  USE_HUB: env.USE_HUB,
  USE_HUB_SECRETS: env.USE_HUB_SECRETS
})"
```

### Step 2~4: Codex P2 → P3 → P4 순서 전달

### Step 5: 수동 작업
```
1. Tailscale 설치 (맥 스튜디오 + 맥북 에어)
2. HUB_AUTH_TOKEN 생성 → 양쪽 .zprofile
3. Hub launchd plist 설치
4. 맥북 에어에서 setup-dev.sh 실행
```


---

## 5. 시크릿 접근 전수조사 결과 (다음 세션 참조)

### 계통 1: llm-keys.js (CJS, 전팀 공유)
- `packages/core/lib/llm-keys.js` → `loadConfig()` → config.yaml
- 사용처: llm-fallback.js, video/*, rag.js
- **P3 작업14에서 `initHubConfig()` 추가 예정**

### 계통 2: investment/secrets.js (ESM, 투자팀)
- `bots/investment/shared/secrets.js` → `loadSecrets()` → config.yaml
- 32곳에서 `loadSecrets()` 호출
- config.yaml 직접 읽는 파일 7개 추가:
  capital-manager, llm-client, runtime-config, cost-tracker, argos, health-report, investment-profile
- **P3 작업14에서 동일 패턴 적용 예정**

### 계통 3: reservation/secrets.js (CJS, 예약팀)
- `bots/reservation/lib/secrets.js` → `loadSecrets()` → secrets.json
- 15곳에서 호출
- **P3에서 Hub `/hub/secrets/reservation` 커넥터 추가 예정**

### 진입점 3개만 수정하면 하위 32+15+7곳 자동 적용
```
llm-keys.js       → initHubConfig() 추가 (1파일)
investment/secrets.js → initHubConfig() 추가 (1파일)
reservation/secrets.js → Hub 커넥터 추가 (1파일)
→ 나머지 54곳은 기존 loadSecrets()/getAnthropicKey() 그대로
```

---

## 6. 참조 파일

```
packages/core/lib/llm-keys.js           ← Hub 커넥터 대상 (계통1)
packages/core/lib/llm-fallback.js       ← 변경 불필요
packages/core/lib/llm-model-selector.js ← 변경 불필요
bots/investment/shared/secrets.js       ← Hub 커넥터 대상 (계통2)
bots/reservation/lib/secrets.js         ← Hub 커넥터 대상 (계통3)
bots/investment/config.yaml             ← 시크릿 원본 (Hub만 직접 읽음)
bots/reservation/secrets.json           ← 시크릿 원본 (Hub만 직접 읽음)
bots/worker/secrets.json                ← 시크릿 원본 (Hub만 직접 읽음)
```
