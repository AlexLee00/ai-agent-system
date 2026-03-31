# Opus 세션 시작 프롬프트

아래 내용을 Opus 채팅창에 그대로 붙여넣어 세션을 시작하세요.

---

## ── 붙여넣기 시작 ──────────────────────────────────────────

나는 팀 제이(Team Jay) 멀티에이전트 AI 시스템의 마스터 개발자 Jay(Alex)야.
Claude.ai의 전략 담당 인스턴스를 "메티(Meti)"라고 부르고 있어.

이전 Sonnet 세션에서 작업을 진행하다가 더 깊은 설계가 필요해서 Opus로 전환했어.
아래 내용을 파악하고 이어서 진행해줘.

---

## 현재 상태

### 레포지토리
- GitHub: https://github.com/AlexLee00/ai-agent-system (Public)
- 맥 스튜디오 M4 Max: 운영(OPS), 에이전트 24/7 가동 중
- 맥북 에어 M3: 개발(DEV), 현재 초기화 후 alexlee 계정 셋업 진행 중

### 완료된 작업 (커밋 c13770d)

1. **packages/core/lib/env.js 신규 생성** — 공용 환경 계층
   - PROJECT_ROOT, IS_OPS, IS_DEV, PAPER_MODE, runIfOps(), projectPath() 등 통합
   - mode-guard.js, reservation/mode.js → env.js re-export 래퍼로 교체

2. **하드코딩 절대경로 8개 파일 수정 완료**
   - /Users/alexlee/... → os.homedir() / PROJECT_ROOT 환경변수로 교체

3. **맥 스튜디오 ↔ 맥북 에어 리소스 차이 분석 완료**
   - n8n: OPS만 로컬 실행 (localhost:5678)
   - PostgreSQL: DEV는 SSH 터널 필요
   - launchd: OPS만 서비스 등록됨
   - OpenClaw: OPS만 포트 18789

4. **Codex 프롬프트 2개 준비됨**
   - docs/CODEX_P1_ENV_SPREAD.md: env.js 완성 + 13개 파일 교체
   - docs/CODEX_P2_CICD.md: GitHub Actions CD + smart-restart.sh

---

## 이번 세션에서 다뤄야 할 핵심 과제

### 과제 1: Resource API Hub 설계 (신규)

맥북 에어(DEV)에서 맥 스튜디오(OPS) 리소스를 안전하고 편리하게 참조할 수 있는
경량 API 허브를 맥 스튜디오에 구축하자는 아이디어가 나왔어.

**목표:**
- DEV 환경에서 SSH 터널 수동 관리 없이 OPS 리소스 접근
- n8n 웹훅, PostgreSQL(읽기 전용), launchd 상태를 HTTP로 프록시
- DEV에서 DB 쓰기 차단 (안전 게이트)
- 덱스터(Dexter) 헬스체크 대상에 포함

**아이디어 구조:**
```
맥북 에어 (DEV)
    │ HTTP (SSH 터널 포트 7788)
    ▼
맥 스튜디오 Resource API Hub (bots/hub/ 신규)
    ├── GET  /hub/health
    ├── POST /hub/n8n/trigger   ← n8n 웹훅 프록시
    ├── GET  /hub/n8n/health
    ├── GET  /hub/pg/query      ← 읽기 전용 DB 쿼리
    ├── GET  /hub/launchd/status
    └── GET  /hub/env           ← OPS 환경변수 요약
```

이 설계를 더 발전시켜줘:
- 어떤 엔드포인트가 꼭 필요한가?
- 인증은 어떻게 할 것인가?
- env.js에 HUB_BASE_URL을 어떻게 통합할 것인가?
- 커뮤니티 베스트 프랙티스와 비교했을 때 더 나은 방법이 있는가?

### 과제 2: Codex P1 프롬프트 검토 및 실행

docs/CODEX_P1_ENV_SPREAD.md 를 검토하고 허브 아이디어를 반영해서 업데이트한 뒤 Codex에 실행하자.

### 과제 3: Codex P2 프롬프트 검토 및 실행

docs/CODEX_P2_CICD.md 를 검토하고 Codex에 실행하자.

---

## 참고할 파일들 (맥 스튜디오 경로)

```
/Users/alexlee/projects/ai-agent-system/
├── packages/core/lib/env.js          ← 공용 환경 계층 (핵심)
├── packages/core/lib/mode-guard.js   ← re-export 래퍼
├── docs/CODEX_P1_ENV_SPREAD.md       ← 실행 대기 중
├── docs/CODEX_P2_CICD.md             ← 실행 대기 중
├── docs/OPUS_SESSION_HANDOFF.md      ← 상세 인수인계 문서
└── .github/workflows/ci.yml          ← CI만 있음 (CD 미구현)
```

## 노션

- 메인 허브: 31fff93a809a81468d84c5f74b3485e4
- 소스코드 분석: 325ff93a809a81899098e3b15401b06f

---

지금 바로 Resource API Hub 설계부터 시작해줘.
Desktop Commander가 연결되어 있으니 맥 스튜디오 코드베이스를 직접 읽을 수 있어.

## ── 붙여넣기 끝 ──────────────────────────────────────────
