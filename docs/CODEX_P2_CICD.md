# Codex 프롬프트 P2: GitHub Actions CD + smart-restart.sh + .env 파일 체계

> 기준 커밋: a081fcb
> 대상 머신: 맥 스튜디오 M4 Max (alexlee) — self-hosted runner 등록 후 사용

---

## 작업 1: .github/workflows/ci.yml 에 deploy job 추가

기존 ci.yml 의 jobs 섹션 맨 끝에 추가 (lint-and-check job 은 그대로 유지):

```yaml
  deploy:
    name: 운영 배포 (맥 스튜디오)
    needs: lint-and-check
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: self-hosted
    environment: production

    steps:
      - name: 코드 동기화
        run: |
          cd "$PROJECT_ROOT"
          git pull origin main

      - name: 의존성 갱신 확인
        run: |
          cd "$PROJECT_ROOT"
          if git diff --name-only HEAD~1 HEAD | grep -qE "package\.json|package-lock\.json"; then
            echo "📦 package.json 변경 감지 — npm install 실행"
            npm install --production
          else
            echo "✅ 의존성 변경 없음"
          fi

      - name: 변경된 팀만 재시작
        run: |
          cd "$PROJECT_ROOT"
          bash scripts/smart-restart.sh

      - name: 배포 후 헬스체크 (실패해도 배포는 성공)
        run: |
          sleep 15
          cd "$PROJECT_ROOT"
          node bots/claude/scripts/health-check.js --post-deploy --json || true
```

---

## 작업 2: scripts/smart-restart.sh 신규 생성

```bash
#!/bin/bash
# scripts/smart-restart.sh
# CI/CD 배포 후 변경된 팀만 선택적 재시작
# OPS 전용 — DEV(맥북 에어)에서는 LAUNCHD_AVAILABLE=false 이므로 자동 스킵

set -e

PROJECT_ROOT="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"

# DEV 환경 체크 — launchd 없으면 조용히 종료
if [ "${MODE:-dev}" != "ops" ]; then
  echo "ℹ️ DEV 환경 — launchd 서비스 없음, smart-restart 스킵"
  exit 0
fi

CHANGED=$(git -C "$PROJECT_ROOT" diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")

restart_service() {
  local label=$1
  echo "🔄 재시작: $label"
  launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null \
    && echo "  ✅ $label" \
    || echo "  ⚠️ $label 재시작 실패 (서비스 미등록?)"
  sleep 2
}

echo "📋 변경 파일 감지 중..."
if [ -z "$CHANGED" ]; then
  echo "ℹ️ 변경 파일 없음 (첫 배포 또는 git 이력 없음)"
  CHANGED="."
fi

# packages/core 변경 → 전체 재시작
if echo "$CHANGED" | grep -q "^packages/core"; then
  echo ""
  echo "⚠️  packages/core 변경 — 전체 팀 순차 재시작"
  restart_service "ai.investment.crypto"
  restart_service "ai.ska.commander"
  restart_service "ai.ska.naver-monitor"
  restart_service "ai.blog.daily"
  restart_service "ai.worker.lead"
  restart_service "ai.worker.task-runner"
  restart_service "ai.orchestrator"
  restart_service "ai.claude.dexter"
  echo "✅ 전체 재시작 완료"
  exit 0
fi

# 팀별 선택 재시작
RESTARTED=0

echo "$CHANGED" | grep -q "^bots/investment" && {
  restart_service "ai.investment.crypto"
  RESTARTED=$((RESTARTED+1))
}

echo "$CHANGED" | grep -qE "^bots/reservation|^bots/ska" && {
  restart_service "ai.ska.commander"
  restart_service "ai.ska.naver-monitor"
  RESTARTED=$((RESTARTED+1))
}

echo "$CHANGED" | grep -q "^bots/blog" && {
  restart_service "ai.blog.daily"
  RESTARTED=$((RESTARTED+1))
}

echo "$CHANGED" | grep -q "^bots/worker" && {
  restart_service "ai.worker.lead"
  restart_service "ai.worker.task-runner"
  RESTARTED=$((RESTARTED+1))
}

echo "$CHANGED" | grep -q "^bots/orchestrator" && {
  restart_service "ai.orchestrator"
  RESTARTED=$((RESTARTED+1))
}

echo "$CHANGED" | grep -q "^bots/claude" && {
  restart_service "ai.claude.dexter"
  RESTARTED=$((RESTARTED+1))
}

if [ "$RESTARTED" -eq 0 ]; then
  echo "ℹ️  재시작 대상 없음 (docs/config 변경만 감지됨)"
else
  echo "✅ ${RESTARTED}개 팀 재시작 완료"
fi
```

---

## 작업 3: .env.example 신규 생성 (프로젝트 루트)

```bash
# 팀 제이 ai-agent-system 환경변수 목록
# ─────────────────────────────────────────────────────────────────────
# 실제 값은 .env.development (맥북 에어) / .env.production (맥 스튜디오) 에 작성
# 두 파일 모두 .gitignore 에 포함되어 있어 Git에 올라가지 않음
# ─────────────────────────────────────────────────────────────────────
# 참고: packages/core/lib/env.js 가 이 환경변수들을 읽어 IS_OPS 등을 결정

# ─── 실행 환경 (필수) ────────────────────────────────────────────────
PROJECT_ROOT=           # 프로젝트 루트 (기본: ~/projects/ai-agent-system)
MODE=                   # ops(맥 스튜디오) | dev(맥북 에어)
PAPER_MODE=             # false(맥 스튜디오) | true(맥북 에어)
NODE_ENV=               # production | development

# ─── n8n (맥 스튜디오 OPS 전용) ─────────────────────────────────────
# 맥북 에어(DEV)에서는 N8N_ENABLED=false 로 자동 설정됨
N8N_ENABLED=            # true(맥 스튜디오) | false(맥북 에어, 기본값)
N8N_BASE_URL=           # http://127.0.0.1:5678 (기본값)
N8N_EMAIL=
N8N_PASSWORD=

# ─── PostgreSQL ───────────────────────────────────────────────────────
# 맥 스튜디오: 로컬 직접 접근 (PG_HOST=localhost)
# 맥북 에어:   SSH 터널 후 접근 (ssh -L 5432:localhost:5432 mac-studio)
#              터널 맺은 후 동일하게 PG_HOST=localhost 사용
PG_HOST=                # localhost (두 머신 동일, 맥북 에어는 SSH 터널 전제)
PG_PORT=                # 5432
PG_USER=                # alexlee
PG_DATABASE=            # jay

# ─── 알림 ────────────────────────────────────────────────────────────
TELEGRAM_CHAT_ID=

# ─── 구글 드라이브 ───────────────────────────────────────────────────
GDRIVE_BLOG_DIR=
GDRIVE_BLOG_IMAGES=
GDRIVE_BLOG_INSTA=

# ─── 블로그 ──────────────────────────────────────────────────────────
OPENWEATHERMAP_API_KEY=
BLOG_LLM_MODEL=         # gpt4o | gemini

# ─── 개발 편의 (맥북 에어 DEV 전용) ────────────────────────────────
# SSH 터널 상태에서 원격 PostgreSQL 접근 확인용
# ssh -L 5432:localhost:5432 mac-studio -N -f
```

---

## 작업 4: .env.development / .env.production 참고 파일 생성 (docs/)

docs/env.development.example 신규 생성:
```bash
# 맥북 에어 (개발 환경) — 이 파일을 복사해 .env.development 로 사용
PROJECT_ROOT=/Users/alexlee/projects/ai-agent-system
MODE=dev
PAPER_MODE=true
NODE_ENV=development
N8N_ENABLED=false
PG_HOST=localhost
PG_PORT=5432
PG_USER=alexlee
PG_DATABASE=jay
TELEGRAM_CHAT_ID=665606590
```

docs/env.production.example 신규 생성:
```bash
# 맥 스튜디오 (운영 환경) — 이 파일을 복사해 .env.production 으로 사용
PROJECT_ROOT=/Users/alexlee/projects/ai-agent-system
MODE=ops
PAPER_MODE=false
NODE_ENV=production
N8N_ENABLED=true
N8N_BASE_URL=http://127.0.0.1:5678
PG_HOST=localhost
PG_PORT=5432
PG_USER=alexlee
PG_DATABASE=jay
TELEGRAM_CHAT_ID=665606590
```

---

## 작업 5: .gitignore 확인 및 추가

.gitignore 에 없으면 추가:
```
# 환경별 설정 (Git 제외)
.env.development
.env.production
.env.local
.env.*.local
```

---

## 완료 기준

```bash
# 1. 파일 존재 확인
ls .github/workflows/ci.yml      # deploy job 포함됐는지 확인
ls scripts/smart-restart.sh
ls .env.example
ls docs/env.development.example
ls docs/env.production.example

# 2. smart-restart.sh 문법 확인
bash -n scripts/smart-restart.sh && echo "OK"

# 3. DEV 모드에서 smart-restart 동작 확인 (스킵 확인)
MODE=dev bash scripts/smart-restart.sh
# 출력: "ℹ️ DEV 환경 — launchd 서비스 없음, smart-restart 스킵"
```

---

## 커밋 메시지

```
feat(ci): GitHub Actions CD + smart-restart.sh + .env 체계 구축

- .github/workflows/ci.yml: deploy job 추가 (self-hosted, main 브랜치)
  변경 팀만 선택 재시작, post-deploy 헬스체크
- scripts/smart-restart.sh: 팀별 선택 재시작
  DEV 환경 자동 감지 → 스킵 (맥북 에어 안전)
  packages/core 변경 시 전체 재시작
- .env.example: 머신별 환경변수 목록 (OPS/DEV 주석 포함)
- docs/env.development.example: 맥북 에어 설정 참고본
- docs/env.production.example: 맥 스튜디오 설정 참고본
```
