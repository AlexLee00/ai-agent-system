# Opus 세션 인수인계 — 팀 제이 환경 분리 & 리소스 허브 설계

> 작성일: 2026-03-29  
> 이전 모델: Claude Sonnet 4.6  
> 다음 모델: Claude Opus 4.6  
> 역할: 메티 (Metis) — 팀 제이 전략 담당

---

## 1. 현재 상태 요약

### 완료된 작업 (커밋 c13770d)

```
packages/core/lib/env.js         ← 신규 생성 (공용 환경 계층)
packages/core/lib/mode-guard.js  ← env.js re-export 래퍼로 교체
bots/reservation/lib/mode.js     ← env.js re-export 래퍼로 교체
scripts/auto-commit.sh 등 8개    ← 하드코딩 절대경로 수정 완료
docs/CODEX_P1_ENV_SPREAD.md      ← Codex 실행 프롬프트 (준비됨)
docs/CODEX_P2_CICD.md            ← Codex 실행 프롬프트 (준비됨)
```

### env.js 현재 제공 항목

```javascript
// 경로
PROJECT_ROOT, projectPath(), corePath()

// 환경
MODE, IS_OPS, IS_DEV, PAPER_MODE, NODE_ENV

// 보호 가드
ensureOps(), ensureDev(), runIfOps(), runIfDev()

// 유틸
modeSuffix(), printModeBanner()
```

### 아직 env.js에 추가 안 된 항목 (P1 Codex 작업)

```javascript
// 맥 스튜디오 전용 리소스 플래그
N8N_ENABLED        // OPS: true  / DEV: false
LAUNCHD_AVAILABLE  // OPS: true  / DEV: false
OPENCLAW_PORT      // OPS: 18789 / DEV: -1
PG_HOST, PG_PORT
OPENCLAW_WORKSPACE, OPENCLAW_LOGS
```

---

## 2. 맥 스튜디오 ↔ 맥북 에어 리소스 차이 전체 정리

| 리소스 | 맥 스튜디오 (OPS) | 맥북 에어 (DEV) | 현재 처리 |
|--------|-------------------|-----------------|-----------|
| n8n | localhost:5678 로컬 | 없음 | ❌ 미처리 |
| PostgreSQL | localhost 직접 | SSH 터널 필요 | ❌ 미처리 |
| launchd | 전 팀 서비스 가동 | 없음 | ❌ 미처리 |
| OpenClaw | 포트 18789 | 없음 | ❌ 미처리 |
| ~/.openclaw | 실서비스 상태 | 로컬 개발용 | ✅ os.homedir() |
| 절대 경로 | /Users/alexlee/... | 동일 (계정통일) | ✅ 완료 |

---

## 3. 새로운 아이디어: 리소스 API 허브 (이번 세션 핵심 과제)

### 배경 & 문제

맥북 에어(DEV)에서 개발 시:
- n8n은 맥 스튜디오에만 있음
- PostgreSQL은 SSH 터널을 수동으로 맺어야 함
- 매번 SSH 터널 관리가 번거롭고 끊기면 오류 발생
- 개발자가 실수로 운영 DB에 직접 쓸 위험

### 제안: 맥 스튜디오에 경량 Resource API Hub 구성

```
맥북 에어 (DEV)
    │
    │ HTTP  (포트 예: 7788)
    │ → SSH 터널로 맥 스튜디오에 접근
    ▼
맥 스튜디오 Resource API Hub  (새 에이전트)
    ├── GET  /hub/health           → 전체 리소스 상태
    ├── POST /hub/n8n/trigger      → n8n 웹훅 프록시 (DEV→OPS n8n)
    ├── GET  /hub/n8n/health       → n8n 헬스 프록시
    ├── GET  /hub/pg/query         → 읽기 전용 DB 쿼리 (DEV용 안전 게이트)
    ├── GET  /hub/launchd/status   → 서비스 상태 조회
    └── GET  /hub/env              → 현재 OPS 환경변수 요약
```

### 기대 효과

- 맥북 에어는 HTTP 한 줄로 모든 OPS 리소스 접근
- SSH 터널 수동 관리 불필요
- DEV에서 DB 쓰기 차단 (읽기 전용 엔드포인트만 노출)
- n8n, launchd 상태를 DEV에서 모니터링 가능
- 에이전트 추가 → 덱스터 감시 대상에 포함 가능

### 구현 스택 제안

```javascript
// bots/hub/src/hub.js (신규)
// Express 기반 경량 서버, 맥 스튜디오에서만 실행
// launchd: ai.hub.resource-api

const express = require('express');
const env = require('../../../packages/core/lib/env');

// env.IS_OPS 아닐 때 기동 거부
env.ensureOps('Resource API Hub');
```

---

## 4. 다음 세션 작업 순서

### Step 1: Codex P1 실행 (env.js 완성)

```
docs/CODEX_P1_ENV_SPREAD.md 내용을 Codex에 전달
→ N8N_ENABLED, LAUNCHD_AVAILABLE, OPENCLAW_PORT 추가
→ process.env.MODE/PAPER_MODE 직접 참조 13개 파일 교체
→ n8n/launchd 호출부에 가드 추가
```

### Step 2: Codex P2 실행 (CI/CD)

```
docs/CODEX_P2_CICD.md 내용을 Codex에 전달
→ GitHub Actions deploy job 추가 (self-hosted runner)
→ scripts/smart-restart.sh 생성 (DEV 자동 스킵)
→ .env.example 생성
```

### Step 3: Resource API Hub 설계 & 구현 (이번 세션 신규)

```
bots/hub/ 디렉토리 신규 생성
packages/core/lib/env.js에 HUB_BASE_URL 추가
  - OPS: 직접 접근 (내부)
  - DEV: http://localhost:7788 (SSH 터널 경유)
덱스터 헬스체크 대상에 허브 추가
```

### Step 4: self-hosted runner 등록 (수동)

```bash
# 맥 스튜디오에서
mkdir -p ~/actions-runner && cd ~/actions-runner
# GitHub → Settings → Actions → Runners → New self-hosted runner
./config.sh --url https://github.com/AlexLee00/ai-agent-system \
            --token <TOKEN> \
            --name "mac-studio-ops" \
            --labels "self-hosted,macOS,arm64,production"
./svc.sh install && ./svc.sh start
```

---

## 5. 참고 정보

### 레포지토리

- GitHub: https://github.com/AlexLee00/ai-agent-system
- 최신 커밋: c13770d
- 계정: alexlee (맥 스튜디오·맥북 에어 동일)

### DB 접속 (맥 스튜디오)

```bash
/opt/homebrew/opt/postgresql@17/bin/psql -U alexlee -d jay
```

### 주요 노션 페이지

- 메인 허브: 31fff93a809a81468d84c5f74b3485e4
- 소스코드 분석: 325ff93a809a81899098e3b15401b06f
- 루나팀 딥 분석: 331ff93a809a81cb86e5faebb24faf1d

### 팀 제이 구성

- 스카팀: 스터디카페 예약/키오스크 관리
- 루나팀: 암호화폐·주식 자동매매
- 클로드팀: 시스템 모니터링 (Dexter 중심)
- 블로팀: 네이버 블로그 자동화
- 워커팀: 비즈니스 관리 SaaS
- **허브팀**: 리소스 API 허브 (신규 제안)

### 현재 운영 이슈

1. n8n 자격증명 복호화 오류 → UI에서 PostgreSQL+Telegram 재입력 필요
2. 루나팀 P1 미완료: PnL 보정(9건), max_daily_trades 상향
3. CalDigit TS4 이더넷 미인식 → WiFi 사용 중

---

## 6. 메티 역할 원칙

- 전략 수립, 딥 분석, 설계 검증, Codex 프롬프트 작성
- 소스코드 직접 수정 금지 → 구현은 Codex에 위임
- DB 쿼리(라이브 PostgreSQL)로 다중 라운드 재검증 후 설계 확정
