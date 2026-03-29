# Opus 세션 2 인수인계 — Resource API Hub 설계 & Codex 프롬프트 완성

> 작성일: 2026-03-29
> 모델: Claude Opus 4.6 (메티)
> 역할: 전략 설계 + Codex 프롬프트 작성
> 이전 세션: Sonnet → env.js 생성 + 경로 수정 (커밋 c13770d)

---

## 1. 이번 세션 완료 항목

### 1-1. Resource API Hub 설계 확정

맥북 에어(DEV)에서 맥 스튜디오(OPS) 리소스를 안전하게 접근하는 경량 HTTP 허브.

**핵심 결정사항:**
- 접속 경로: Tailscale 우선 (SSH 터널 폴백)
- 구현 범위: 표준 (health + pg/query + n8n + services)
- 포트: 7788, Express 기반, OPS 전용 (env.ensureOps)
- 인증: Bearer Token (256비트 랜덤) + Rate Limit
- DB 안전: sql-guard.js — SELECT/WITH/EXPLAIN만 허용, DML/DDL/위험함수 차단

**Hub 엔드포인트:**
```
GET  /hub/health              통합 헬스체크 (PG + n8n) — 토큰 불필요
POST /hub/pg/query            읽기 전용 DB 쿼리 (sql-guard)
POST /hub/n8n/webhook/:path   n8n 웹훅 프록시
GET  /hub/n8n/health          n8n 헬스 프록시
GET  /hub/services/status     launchd 전 서비스 상태
GET  /hub/env                 OPS 환경 요약 (민감정보 제외)
```

**env.js 통합 원칙:**
- OPS: Hub 서버 호스트, 자기 코드는 Hub 경유 안 함 (직접 pg-pool 사용)
- DEV: `USE_HUB=true` → Hub 클라이언트로 동작, HUB_BASE_URL 경유

### 1-2. Codex 프롬프트 3개 준비 완료

| 프롬프트 | 파일 | 상태 | 내용 |
|----------|------|------|------|
| P1 | `docs/CODEX_P1_ENV_SPREAD.md` | ✅ 업데이트 | env.js 완성 + Hub 변수 4개 + 13파일 교체 |
| P2 | `docs/CODEX_P2_CICD.md` | ✅ 업데이트 | CI/CD + smart-restart + .env 체계 (Hub 포함) |
| P3 | `docs/CODEX_P3_RESOURCE_HUB.md` | ✅ 신규 | Hub 전체 구현 (11개 작업, 770줄) |

---

## 2. P1 변경 내역 (이번 세션에서 수정한 부분)

`docs/CODEX_P1_ENV_SPREAD.md`에 Hub 환경변수 섹션 추가:

```javascript
// 추가된 env.js 항목
HUB_BASE_URL    // DEV: 'http://localhost:7788' / OPS: null
USE_HUB         // DEV: true / OPS: false
HUB_AUTH_TOKEN  // 공유 Bearer Token
HUB_PORT        // 7788 (Hub 서버 바인드용, OPS)
```

module.exports에도 4개 항목 추가됨.
커밋 메시지에 Hub 관련 변경 반영됨.

## 3. P2 변경 내역

`docs/CODEX_P2_CICD.md`에 적용한 변경:

1. `.env.example`: Hub 섹션 추가 (HUB_BASE_URL, HUB_AUTH_TOKEN, HUB_PORT)
2. `docs/env.development.example`: HUB_BASE_URL=http://localhost:7788 추가
3. `docs/env.production.example`: HUB_PORT=7788, HUB_AUTH_TOKEN 추가
4. `smart-restart.sh`: ai.hub.resource-api 서비스 추가
   - 개별 재시작: `bots/hub` 변경 감지 시
   - 전체 재시작: `packages/core` 변경 시 목록에 포함

## 4. P3 구조 요약 (신규 작성)

`docs/CODEX_P3_RESOURCE_HUB.md` — 11개 작업:

```
작업 1:  bots/hub/package.json
작업 2:  bots/hub/lib/auth.js            — Bearer Token 미들웨어
작업 3:  bots/hub/lib/sql-guard.js       — SELECT만 허용, DML/DDL 차단
작업 4:  bots/hub/lib/routes/health.js   — PG+n8n 통합 헬스
작업 5:  bots/hub/lib/routes/pg.js       — 읽기전용 쿼리 (1000행, 5초 타임아웃)
작업 6:  bots/hub/lib/routes/n8n.js      — 웹훅 프록시 + 헬스 프록시
작업 7:  bots/hub/lib/routes/services.js — launchd 상태 + env 요약
작업 8:  bots/hub/src/hub.js             — 메인 진입점 (Express, rate limit)
작업 9:  launchd plist                   — ai.hub.resource-api (KeepAlive)
작업 10: bots/claude/lib/checks/hub.js   — Dexter 헬스체크 통합
작업 11: bots/registry.json              — hub 항목 추가
```

완료 기준: 9단계 테스트 (기동, 헬스, 인증, SELECT, 쓰기차단, DEV 거부 등)

---

## 5. 다음 세션 실행 순서

### Step 1: Codex P1 실행
```
docs/CODEX_P1_ENV_SPREAD.md 내용을 Codex에 전달
→ env.js에 서비스 플래그 + Hub 변수 추가
→ 13개 파일 process.env.MODE/PAPER_MODE → env.js 교체
→ n8n/launchd 호출부에 가드 추가
```

### Step 2: Codex P2 실행
```
docs/CODEX_P2_CICD.md 내용을 Codex에 전달
→ ci.yml에 deploy job 추가 (self-hosted runner)
→ scripts/smart-restart.sh 생성
→ .env.example + docs/env.*.example 생성
```

### Step 3: Codex P3 실행
```
docs/CODEX_P3_RESOURCE_HUB.md 내용을 Codex에 전달
→ bots/hub/ 디렉토리 전체 생성
→ bots/claude/lib/checks/hub.js 생성
→ bots/registry.json 업데이트
```

### Step 4: 수동 작업
```bash
# 1. HUB_AUTH_TOKEN 생성
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# → .env.production 과 .env.development 양쪽에 동일 값 설정

# 2. launchd plist 설치 (맥 스튜디오)
cp bots/hub/launchd/ai.hub.resource-api.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.hub.resource-api.plist

# 3. Tailscale 설치 (맥 스튜디오 + 맥북 에어)
# https://tailscale.com/download/mac
# 설치 후 양쪽에서 로그인 → 자동 연결
# 맥북 에어 .env.development에 HUB_BASE_URL=http://<tailscale-ip>:7788

# 4. self-hosted runner 등록 (P2 배포용, 선택)
# GitHub → Settings → Actions → Runners → New self-hosted runner
```

---

## 6. 주의사항 & 미결 항목

### Hub 설계에서 의도적으로 뺀 것
- **hub-client SDK**: 첫 버전에서는 DEV 코드가 직접 fetch로 Hub 호출.
  향후 `packages/core/lib/hub-client.js`로 추출 가능하나 지금은 과도함.
- **WebSocket 실시간 로그**: 복잡도 대비 이득이 적음. 필요 시 추가.
- **Hub를 통한 DB 쓰기**: 의도적 차단. DEV에서 쓰기가 필요하면
  SSH 직접 접속으로 psql 사용 (의식적 행동 강제).

### P3 실행 전 확인할 것
- `express` 패키지가 프로젝트 루트 node_modules에 있는지 확인
  없으면: `cd ~/projects/ai-agent-system && npm install express`
- `express-rate-limit`은 선택사항 (없으면 no-op 폴백 처리됨)

### 현재 운영 이슈 (미해결)
1. n8n 자격증명 복호화 에러 → UI에서 PostgreSQL+Telegram 재입력 필요
2. 루나팀 P1 미완료: PnL 보정(9건), max_daily_trades 상향
3. CalDigit TS4 이더넷 미인식 → WiFi 사용 중
4. 맥북 에어 초기화 → alexlee 계정 셋업 진행 중

---

## 7. 아키텍처 요약

```
맥북 에어 (DEV)                        맥 스튜디오 (OPS)
┌────────────────┐                    ┌─────────────────────────────┐
│  개발 코드      │                    │  Resource API Hub (:7788)   │
│                │  Tailscale/SSH     │  ├─ /hub/health             │
│  USE_HUB=true  │ ─────────────────► │  ├─ /hub/pg/query          │
│  HUB_BASE_URL  │    HTTP            │  ├─ /hub/n8n/webhook/:path │
│                │                    │  ├─ /hub/n8n/health        │
└────────────────┘                    │  ├─ /hub/services/status   │
                                      │  └─ /hub/env               │
                                      │                             │
                                      │  ┌─ pg-pool (localhost)     │
                                      │  ├─ n8n (:5678)            │
                                      │  ├─ launchd 서비스          │
                                      │  └─ Dexter → checks/hub.js │
                                      └─────────────────────────────┘
```

---

## 8. 참조 파일 목록

```
수정된 파일 (이번 세션):
  docs/CODEX_P1_ENV_SPREAD.md    ← Hub 환경변수 추가
  docs/CODEX_P2_CICD.md          ← .env + smart-restart Hub 반영

신규 파일 (이번 세션):
  docs/CODEX_P3_RESOURCE_HUB.md  ← Hub 구현 프롬프트 (770줄)
  docs/OPUS_SESSION_2_HANDOFF.md ← 이 문서

기존 참조 (변경 없음):
  packages/core/lib/env.js       ← P1 실행 시 확장 대상
  .github/workflows/ci.yml      ← P2 실행 시 deploy job 추가 대상
  bots/claude/lib/checks/        ← P3 실행 시 hub.js 추가 위치
  bots/registry.json             ← P3 실행 시 hub 항목 추가

노션:
  메인 허브: 31fff93a809a81468d84c5f74b3485e4
  소스코드 분석: 325ff93a809a81899098e3b15401b06f
```
