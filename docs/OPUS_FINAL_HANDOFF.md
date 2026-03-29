# Opus 세션 최종 인수인계 — DEV↔OPS 환경 분리 완성

> 작성일: 2026-03-29
> 모델: Claude Opus 4.6 (메티)
> 세션 범위: Opus 세션 1~5 (Sonnet 이후 연속)
> 다음 채팅: '개발 프로젝트 시작'

---

## 1. 이번 세션 전체 성과

### 완성된 인프라

```
맥북 에어 (DEV)                         맥 스튜디오 (OPS)
┌──────────────────┐                   ┌──────────────────────────────┐
│  개발 환경 완성    │                   │  Resource API Hub (:7788)    │
│  MODE=dev         │  SSH 터널        │  ├─ /hub/health         ✅   │
│  PAPER_MODE=true  │ ──────────────►  │  ├─ /hub/pg/query       ✅   │
│  USE_HUB=true     │  :7788           │  ├─ /hub/n8n/*          ✅   │
│                   │                   │  ├─ /hub/services/*     ✅   │
│  Homebrew ✅      │                   │  ├─ /hub/env            ✅   │
│  Node v25.8.2 ✅  │                   │  ├─ /hub/secrets/llm    ✅   │
│  npm 11.11.1 ✅   │                   │  ├─ /hub/secrets/telegram ✅ │
│  Python 3.12 ✅   │                   │  ├─ /hub/secrets/exchange ✅ │
│  PG 17.9 (클라) ✅│                   │  ├─ /hub/secrets/reservation ✅│
│  Claude Code ✅   │                   │  └─ /hub/secrets/config  ✅  │
│  SSH mac-studio ✅│                   │                              │
│  시크릿 동기화 ✅  │                   │  Bearer Token 인증 ✅        │
│  env.js 정상 ✅   │                   │  SQL 쓰기 차단 ✅            │
└──────────────────┘                   │  Rate Limit ✅               │
                                        │  Dexter 체크 ✅              │
                                        │  launchd KeepAlive ✅        │
                                        └──────────────────────────────┘
```


### Codex P1~P4 전부 구현+검증+커밋 완료

| 프롬프트 | 커밋 | 내용 |
|----------|------|------|
| P1 (env.js 확산) | ✅ 푸시 | env.js 통합, 13파일 교체, Hub 변수, N8N/LAUNCHD 가드 |
| P2 (CI/CD) | ✅ 푸시 | deploy job, smart-restart.sh, .env 체계 |
| P3 (Hub 구현) | ✅ 푸시 | Hub 전체 + E2E 통과 |
| P4 (DEV 셋업) | ✅ 푸시 | setup-dev.sh + sync-dev-secrets.sh |
| secrets 프록시 | ✅ 푸시 | 맥북 에어에서 첫 DEV 개발 → push → OPS 반영 |

### E2E 전항목 통과

| 테스트 | 결과 |
|--------|------|
| Hub health (PG + n8n) | ✅ |
| DB 읽기 (pg/query) | ✅ 81개 포지션 |
| DB 쓰기 차단 (DELETE) | ✅ 403 |
| 인증 없이 접근 | ✅ 401 |
| LLM 키 (Anthropic/OpenAI/Gemini/Groq 9개/xAI) | ✅ |
| Telegram bot_token | ✅ |
| 거래소 paper/testnet 강제 | ✅ |
| Reservation OPS키 마스킹 | ✅ |
| DEV→OPS 개발 플로우 (push→pull→재시작) | ✅ |


---

## 2. 현재 Git 로그

```
6dfec5f feat(hub): secrets 프록시 엔드포인트 추가        ← 맥북 에어에서 커밋
67aca7f feat(dev): add macbook air setup scripts
506cff8 feat(hub): add resource api hub
xxxxxxx feat(ci): GitHub Actions CD + smart-restart.sh
xxxxxxx refactor(env): env.js 통합 — OPS/DEV 리소스 분기
```

---

## 3. API 키 4티어 전략 (확정)

| 티어 | DEV 접근 방식 | 파일 복사 |
|------|--------------|----------|
| 1 (DB, n8n) | Hub /hub/pg/query, /hub/n8n/* | 불필요 |
| 2 (LLM, Telegram) | Hub /hub/secrets/llm, /telegram | 불필요 |
| 3 (거래소) | Hub /hub/secrets/exchange (paper 강제) | 불필요 |
| 4 (Naver/Pickko) | Hub가 마스킹 반환 | 불필요 |

> sync-dev-secrets.sh는 Hub 미연결 시 폴백용으로 유지.

---

## 4. 미완료 & 향후 작업

### 즉시 가능 (다음 세션)
- **P5 (시크릿 커넥터)**: llm-keys.js `initHubConfig()` 추가
  → 진입점 3개만 수정하면 54곳 자동 적용
  → OPS/DEV 모두 Hub 경유로 시크릿 접근 (일관성)
- **P5 확장**: config.yaml 하나로 통합 (reservation/worker secrets.json 흡수)

### 기존 미완료 항목
- 루나팀 P1 미완료: PnL 보정(9건), max_daily_trades 상향, unrealized_pnl 갱신
- 루나팀 재설계 구현: 13→11에이전트, EXIT 전용 경로, 4전략, VectorBT
- 블로팀 기획 완료 후 구현: Node.js 120강 커리큘럼 33강 진행 중
- n8n 자격증명 복호화 에러 → UI에서 PostgreSQL+Telegram 재입력 필요
- CalDigit TS4 이더넷 미인식 → A/S 예정
- Tailscale 설치 (현재 SSH 터널 사용 중, Tailscale이 더 편리)

---

## 5. 개발 워크플로우 (확립됨)

```
맥북 에어(DEV)에서 코드 작성/수정
  → git push origin main
    → 맥 스튜디오 cron 5분마다 자동 pull (~/bin/deploy.sh)
      → 변경된 팀만 launchd 재시작
      → Hub도 자동 재시작 (smart-restart.sh)
```

DEV에서 OPS 리소스 접근:
```bash
# DB 조회 (읽기 전용)
curl -s -X POST http://localhost:7788/hub/pg/query \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql":"SELECT ...","schema":"investment"}'

# LLM 키 조회
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  http://localhost:7788/hub/secrets/llm
```

SSH 터널 시작 (맥북 에어에서):
```bash
ssh -L 7788:localhost:7788 mac-studio -N -f
```

---

## 6. 환경 정보 요약

### 맥 스튜디오 (OPS)
- MODE=ops, PAPER_MODE=false, NODE_ENV=production
- Node v25.8.2, PG 17.9, n8n 2.13.4
- Hub :7788 (launchd KeepAlive)
- launchd 서비스 63개, cron deploy.sh 5분

### 맥북 에어 (DEV)
- MODE=dev, PAPER_MODE=true, NODE_ENV=development
- Node v25.8.2, PG 17.9 (클라이언트), Python 3.12
- USE_HUB=true, HUB_BASE_URL=http://localhost:7788
- SSH mac-studio 비밀번호 없이 연결
- Claude Code + OpenClaw 설치됨

---

## 7. 주요 파일 참조

```
핵심 인프라:
  packages/core/lib/env.js              ← 공용 환경 계층 (모든 팀 사용)
  bots/hub/src/hub.js                   ← Resource API Hub 메인
  bots/hub/lib/routes/secrets.js        ← 시크릿 프록시 (5 카테고리)
  bots/hub/lib/auth.js                  ← Bearer Token 인증
  bots/hub/lib/sql-guard.js             ← SELECT만 허용
  scripts/smart-restart.sh              ← 팀별 선택 재시작
  scripts/setup-dev.sh                  ← DEV 원클릭 셋업
  scripts/sync-dev-secrets.sh           ← 시크릿 안전 동기화

문서:
  docs/DEV_ENV_SETUP_MACBOOK_AIR.md     ← DEV 셋업 가이드 (~570줄)
  docs/OPUS_FINAL_HANDOFF.md            ← 이 문서
  docs/OPUS_SESSION_2_HANDOFF.md        ← Hub 설계
  docs/OPUS_SESSION_3_HANDOFF.md        ← 시크릿 커넥터 설계

Codex 프롬프트 (전부 실행 완료):
  docs/CODEX_P1_ENV_SPREAD.md           ← env.js 확산
  docs/CODEX_P2_CICD.md                 ← CI/CD
  docs/CODEX_P3_RESOURCE_HUB.md         ← Hub 구현
  docs/CODEX_P4_DEV_SETUP.md            ← DEV 셋업

시크릿 원본 (Hub만 직접 읽음):
  bots/investment/config.yaml           ← LLM/거래소/텔레그램/투자설정
  bots/reservation/secrets.json         ← 예약팀
  bots/worker/secrets.json              ← 워커팀

노션:
  메인 허브: 31fff93a809a81468d84c5f74b3485e4
  소스코드 분석: 325ff93a809a81899098e3b15401b06f
  루나팀 딥 분석: 331ff93a809a81cb86e5faebb24faf1d
```
