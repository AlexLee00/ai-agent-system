# Opus 세션 3~4 인수인계 — Hub 시크릿 커넥터 설계 완료

> 작성일: 2026-03-29
> 모델: Claude Opus 4.6 (메티)
> 이전: Opus 세션 2 (Hub 기본 설계), Opus 세션 3 (DEV 셋업 + 4티어)

---

## 1. 이번 세션 핵심 결정

### Hub 시크릿 커넥터 — DEV에서 시크릿 파일 복사 불필요

제이의 아이디어: LLM 셀렉터를 커넥터로 확장.
분석 결과 `llm-keys.js`의 `loadConfig()`가 Single Source of Truth.
여기에 Hub fallback 한 줄 추가로 전체 LLM 체인이 자동 적용.

**최종 구조:**
```
DEV 프로세스 시작
  └─ initHubConfig()          ← llm-keys.js 신규 함수
      └─ GET /hub/secrets/config   ← Hub가 config.yaml 반환 (DEV 안전 오버라이드)
          └─ 메모리 캐시
              └─ getAnthropicKey(), getGroqAccounts() 등 기존 함수가 Hub 데이터 사용
                  └─ llm-fallback.js / llm-model-selector.js → 코드 변경 없음
```


### 시크릿 엔드포인트 5개 (P3 작업 12~15에 추가됨)

```
GET /hub/secrets/llm          LLM API 키 전체 (Anthropic/OpenAI/Gemini/Groq 등)
GET /hub/secrets/telegram     bot_token + chat_id
GET /hub/secrets/exchange     Binance/Upbit/KIS (★ DEV는 paper/testnet 강제)
GET /hub/secrets/reservation  공유키만, OPS전용(Naver/Pickko/DB암호화) 마스킹
GET /hub/secrets/config       config.yaml 전체 (DEV 안전 오버라이드 적용)
```

### 4티어 전략 최종 (Hub 반영)

| 티어 | DEV에서의 접근 방식 | 시크릿 파일 복사 |
|------|-------------------|----------------|
| 1 (DB, n8n) | Hub /hub/pg/query, /hub/n8n/* | 불필요 |
| 2 (LLM, Telegram) | Hub /hub/secrets/llm, /telegram | **불필요** (Hub 경유) |
| 3 (거래소) | Hub /hub/secrets/exchange (paper 강제) | **불필요** (Hub 경유) |
| 4 (Naver/Pickko) | Hub가 마스킹 반환 | 불필요 (빈값) |

**결론: DEV에 시크릿 파일을 하나도 안 복사해도 됨.**

---

## 2. P3 추가된 작업 (작업 12~15)

| 작업 | 내용 |
|------|------|
| 12 | `bots/hub/lib/routes/secrets.js` — 카테고리별 시크릿 프록시 |
| 13 | `hub.js`에 secrets 라우트 등록 (Rate Limit 10/분) |
| 14 | `llm-keys.js` 수정 — `initHubConfig()` 추가 (Hub 커넥터) |
| 15 | 완료 기준에 시크릿 테스트 4개 추가 |


---

## 3. Codex 실행 상태

| 프롬프트 | 파일 | 줄 수 | 상태 |
|----------|------|-------|------|
| P1 (env.js 확산) | `CODEX_P1_ENV_SPREAD.md` | 280 | 🔄 Codex 실행 중 |
| P2 (CI/CD) | `CODEX_P2_CICD.md` | ~300 | ⬜ 대기 (시크릿 주석 추가됨) |
| P3 (Hub 구현) | `CODEX_P3_RESOURCE_HUB.md` | ~1110 | ⬜ 대기 (시크릿 커넥터 작업12~15 추가됨) |
| P4 (DEV 셋업) | `CODEX_P4_DEV_SETUP.md` | 563 | ✅ 완성 |

---

## 4. P4 sync-dev-secrets.sh 역할 변경

Hub 시크릿 커넥터가 도입되면서 `sync-dev-secrets.sh`의 역할이 변경됨:
- **이전**: OPS에서 시크릿 파일 scp + 패치 (필수)
- **이후**: Hub 미연결 시 폴백용 (선택) — Hub가 정상이면 실행 불필요

P4는 이미 작성 완료 상태이므로, 다음 세션에서 sync-dev-secrets.sh를
"Hub 폴백 전용" 주석으로 업데이트할지 결정 필요.


---

## 5. 다음 세션 작업 순서

### Step 1: P1 Codex 결과 확인
```
grep -rn "process\.env\.MODE\b" bots/ --include="*.js" | grep -v node_modules
→ 0건이면 성공
node -e "const env = require('./packages/core/lib/env'); console.log(env)"
→ HUB_BASE_URL, USE_HUB 등 확인
```

### Step 2: P3 커밋 메시지 업데이트
P3의 기존 커밋 메시지를 시크릿 커넥터 반영 버전으로 교체
(이번 세션에서 edit_block 시도했으나 fuzzy match로 실패 — 수동 교체 필요)

### Step 3: Codex P2→P3→P4 순서 전달

### Step 4: 수동 작업
```
1. Tailscale 설치 (맥 스튜디오 + 맥북 에어)
2. HUB_AUTH_TOKEN 생성 → 양쪽 .zprofile에 설정
3. Hub launchd plist 설치
4. 맥북 에어에서 bash scripts/setup-dev.sh 실행
```

---

## 6. 산출물 전체 목록

```
이번 세션 수정:
  docs/CODEX_P3_RESOURCE_HUB.md     ← 시크릿 프록시 작업12~15 추가 (~1110줄)
  docs/DEV_ENV_SETUP_MACBOOK_AIR.md ← 섹션19 API키 4티어 추가 (~570줄)
  docs/CODEX_P2_CICD.md             ← 시크릿 티어 주석 추가

이전 세션 완성:
  docs/CODEX_P4_DEV_SETUP.md        ← 563줄 (setup-dev.sh + sync-dev-secrets.sh)
  docs/DEV_ENV_SETUP_MACBOOK_AIR.md ← 502→~570줄

인수인계:
  docs/OPUS_SESSION_3_HANDOFF.md    ← 이 문서
```

---

## 7. 참조 파일

```
핵심 분석 대상 (이번 세션에서 읽은 파일):
  packages/core/lib/llm-keys.js           ← Hub 커넥터 적용 대상 (loadConfig)
  packages/core/lib/llm-model-selector.js ← 셀렉터 레지스트리 (변경 불필요)
  packages/core/lib/llm-selector-advisor.js ← 어드바이저 (변경 불필요)
  packages/core/lib/llm-router.js         ← 복잡도 라우터 (변경 불필요)
  packages/core/lib/llm-fallback.js       ← 폴백 실행기 (변경 불필요)
  bots/investment/shared/secrets.js       ← config.yaml 로더 (변경 불필요)
  bots/investment/config.yaml             ← 시크릿 원본 (OPS)

노션:
  메인 허브: 31fff93a809a81468d84c5f74b3485e4
  소스코드 분석: 325ff93a809a81899098e3b15401b06f
```
