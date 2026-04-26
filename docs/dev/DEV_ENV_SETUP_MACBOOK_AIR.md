# 맥북 에어 개발환경 셋업 가이드 v2

> 기준일: 2026-03-29 (맥 스튜디오 환경 전수조사 반영)
> 맥 스튜디오 M4 Max 36GB/512GB — 운영(OPS), 24/7 가동
> 맥북 에어 15 M3 24GB/1TB — 개발(DEV), 사무실
> 계정명: `alexlee` (두 머신 동일)
> GitHub: https://github.com/AlexLee00/ai-agent-system (Public)

---

## 0. 맥 스튜디오(OPS) 환경 스냅샷

이 문서는 맥 스튜디오의 현재 상태를 기준으로 맥북 에어를 동일하게 구성한다.

### 0-1. 버전 정보

| 도구 | 맥 스튜디오 버전 | 맥북 에어 목표 |
|------|-----------------|---------------|
| macOS | Sequoia (darwin arm64) | 동일 |
| Node.js | v25.8.2 | v25.x (brew install node) |
| npm | 11.11.1 | 동일 (node 포함) |
| PostgreSQL | 17.9 (Homebrew) | 17.x (클라이언트만, 서버 불필요) |
| pgvector | 0.8.2 (PG 확장) | 불필요 (서버 미운영) |
| Python | 3.9.6 (시스템) + 3.12 (brew) | 동일 |
| Git | 2.53.0 | 최신 (brew) |
| Homebrew | 5.1.1 | 최신 |
| tmux | 설치됨 | 설치 |
| Claude Code | 2.1.87 | 동일 |
| Hub control/alarm | local | 동일 |
| n8n | 2.13.4 | **미설치** (OPS 전용) |

### 0-2. Homebrew 패키지 (formula)

```
# OPS에 설치된 전체 formula:
abseil ada-url bfg brotli c-ares ca-certificates cairo duti fmt fontconfig
freetype gettext gh giflib git glib graphite2 harfbuzz hdrhistogram_c htop
icu4c@78 jpeg-turbo krb5 libevent libidn2 libnghttp2 libnghttp3 libngtcp2
libpng libtiff libunistring libuv libx11 libxau libxcb libxdmcp libxext
libxrender little-cms2 llhttp lz4 lzo mosh mpdecimal ncurses node openjdk
openssl@3 pcre2 pgvector pixman postgresql@17 powerlevel10k protobuf
python@3.12 readline simdjson sqlite tmux utf8proc uvwasi wget xorgproto xz zstd
```

DEV 필수: `git node postgresql@17 python@3.12 gh tmux htop mosh powerlevel10k wget`
DEV 불필요: `pgvector bfg cairo openjdk` (서버·일회성 도구)

### 0-3. Homebrew Cask (GUI 앱)

```
OPS 설치됨: cursor font-meslo-lg-nerd-font iterm2 maccy orbstack raycast rectangle visual-studio-code
```

### 0-4. npm 전역 패키지

```
@anthropic-ai/claude-code@2.1.87
n8n@2.13.4          ← OPS 전용, DEV 불필요
hub-control local runtime
```

### 0-5. 환경변수 (.zprofile)

```bash
# 맥 스튜디오 현재 .zprofile:
eval "$(/opt/homebrew/bin/brew shellenv zsh)"
export TELEGRAM_CHAT_ID="665606590"
export N8N_EMAIL="leejearyong@gmail.com"
export GDRIVE_BLOG_DIR="/Users/alexlee/Library/CloudStorage/GoogleDrive-leejearyong@gmail.com/내 드라이브/010_BlogPost"
export GDRIVE_BLOG_IMAGES="${GDRIVE_BLOG_DIR}/images"
export GDRIVE_BLOG_INSTA="${GDRIVE_BLOG_DIR}/insta"
export PAPER_MODE=false
export MODE=ops
export NODE_ENV=production
source ~/.orbstack/shell/init.zsh 2>/dev/null || :
```

### 0-6. 활성 포트 (OPS)

| 포트 | 서비스 | DEV 필요 여부 |
|------|--------|--------------|
| 3031 | 워커 프론트 (dev) | 개발 시 로컬 실행 |
| 3032 | 워커 프론트 (ops) | 불필요 |
| 4000 | ops-platform backend | 불필요 |
| 4001 | 워커 웹 | 개발 시 로컬 실행 |
| 5432 | PostgreSQL | SSH 터널 / Tailscale |
| 5678 | n8n | Hub 경유 |
| 7788 | Hub resource API | OPS 전용 |

### 0-7. PostgreSQL 스키마 & 테이블

```
DB: jay / User: alexlee / Extensions: plpgsql, pgcrypto, uuid-ossp, vector(0.8.2)

스키마별 테이블 수:
  blog        | 11
  claude      | 22
  investment  | 22
  public      |  3
  reservation | 30
  ska         | 10
  video       |  2
  worker      | 30
  n8n         | (n8n 내부)
```

### 0-8. Git 제외 설정 파일 (secrets/config)

DEV에서 맥 스튜디오에서 복사해야 하는 파일:
```
bots/reservation/secrets.json   ← 예약 API 키
bots/worker/secrets.json        ← 워커 API 키
bots/investment/config.yaml     ← 투자 설정 (trading_mode 등)
bots/reservation/config.yaml    ← 예약 설정
bots/blog/config.json           ← 블로그 설정
bots/claude/config.json         ← 클로드팀 설정
bots/ska/config.json            ← 스카팀 설정
bots/worker/config.json         ← 워커 설정
bots/orchestrator/config.json   ← 오케스트레이터 설정
```

### 0-9. launchd 서비스 (OPS 전용, 63개)

DEV에서는 launchd 서비스를 실행하지 않는다. 참조용으로만 기록:
```
ai.agent.auto-commit / nightly-sync / post-reboot
ai.blog.daily / health-check / node-server
ai.claude.archer / commander / dexter / dexter.daily / dexter.quick / health-check / health-dashboard / speed-test
ai.env.setup
ai.investment.argos / commander / crypto / domestic / health-check / market-alert-* (6개) / overseas / prescreen-* (2개) / reporter / unrealized-pnl
ai.n8n.server
ai.hub.resource-api / model-sync
ai.ops.platform.backend / frontend
ai.orchestrator
ai.ska.commander / dashboard / db-backup / etl / eve / eve-crawl / forecast-* (3개) / health-check / kiosk-monitor / log-report / log-rotate / naver-monitor / pickko-* (3개) / rebecca / rebecca-weekly / today-audit
ai.worker.claude-monitor / health-check / lead / nextjs / task-runner / web
```

### 0-10. cron & 자동 배포

```
*/5 * * * * /Users/alexlee/bin/deploy.sh   ← 5분마다 git pull + 변경 서비스 재시작
```

### 0-11. tmux 세션

```
code: 코드 작업용
dev:  개발/디버깅용
ops:  운영 모니터링용
```

---

## 1. 사전 준비

```bash
xcode-select --install
```

---

## 2. Homebrew 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

---

## 3. Homebrew 패키지 설치

```bash
# 필수 (OPS와 동일 버전 유지)
brew install git node postgresql@17 python@3.12

# 개발 도구
brew install gh tmux htop mosh wget

# 터미널 꾸미기
brew install powerlevel10k

# PostgreSQL PATH
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zprofile
```

> PostgreSQL 서버 시작 불필요 — Hub 또는 SSH 터널로 맥 스튜디오 DB 사용.
> n8n 미설치 — Hub 경유로 웹훅 트리거.

---

## 4. GUI 앱 설치

```bash
brew install --cask \
  iterm2 \
  visual-studio-code \
  cursor \
  raycast \
  rectangle \
  maccy \
  font-meslo-lg-nerd-font \
  tailscale
```

---

## 5. npm 전역 패키지

```bash
npm install -g @anthropic-ai/claude-code
npm --prefix bots/hub install
```

> n8n은 OPS 전용 — 미설치.

---

## 6. Node.js / Python 버전 확인

```bash
node -v   # v25.x 이상
npm -v    # v11.x 이상
python3.12 --version
psql --version   # 17.x (클라이언트)
```

---

## 7. 프로젝트 클론 및 의존성

```bash
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/AlexLee00/ai-agent-system.git
cd ai-agent-system

# 루트 의존성 (workspaces 포함)
npm install

# 워커 웹 (Next.js + Twick)
cd bots/worker/web && npm install && cd ../../..

# 블로그 봇
cd bots/blog && npm install && cd ../..
```

---

## 8. Python 가상환경 (스카팀)

```bash
cd ~/projects/ai-agent-system/bots/ska
python3.12 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate
```

---

## 9. ~/.zprofile 설정

```bash
cat >> ~/.zprofile << 'EOF'

eval "$(/opt/homebrew/bin/brew shellenv zsh)"

# ─── Team Jay 환경변수 ───
export TELEGRAM_CHAT_ID="665606590"
export N8N_EMAIL="leejearyong@gmail.com"
export GDRIVE_BLOG_DIR="/Users/alexlee/Library/CloudStorage/GoogleDrive-leejearyong@gmail.com/내 드라이브/010_BlogPost"
export GDRIVE_BLOG_IMAGES="${GDRIVE_BLOG_DIR}/images"
export GDRIVE_BLOG_INSTA="${GDRIVE_BLOG_DIR}/insta"

# ─── DEV 환경 (맥북 에어) ───
export PAPER_MODE=true
export MODE=dev
export NODE_ENV=development

# ─── Resource API Hub ───
export HUB_BASE_URL="http://localhost:7788"
export HUB_AUTH_TOKEN=""   # ← 맥 스튜디오와 동일 값 입력

# PostgreSQL@17 PATH
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
EOF
```

> **핵심 차이**: `MODE=dev`, `PAPER_MODE=true` — OPS와 반드시 다르게 설정.

---

## 10. ~/.zshrc 설정

```bash
cat >> ~/.zshrc << 'EOF'

[[ -f ~/.zprofile ]] && source ~/.zprofile

setopt AUTO_CD AUTO_PUSHD PUSHD_IGNORE_DUPS HIST_IGNORE_DUPS SHARE_HISTORY INTERACTIVE_COMMENTS
HISTFILE=$HOME/.zsh_history
HISTSIZE=50000
SAVEHIST=50000

export CLICOLOR=1
export LSCOLORS='GxFxCxDxBxegedabagaced'
export TERM=xterm-256color

alias ll='ls -lah'
alias la='ls -A'
alias gs='git status -sb'
alias gl='git log --oneline --decorate -10'

if command -v compinit >/dev/null 2>&1; then
  autoload -Uz compinit && compinit
fi

source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
EOF
```

---

## 11. Tailscale 설치 (DEV↔OPS 연결)

```bash
# GUI 앱으로 설치됨 (brew install --cask tailscale)
# 1. 맥북 에어에서 Tailscale 앱 실행 → 로그인
# 2. 맥 스튜디오에서도 Tailscale 설치 + 로그인 (동일 계정)
# 3. 양쪽 연결 확인:
tailscale status   # 맥 스튜디오 IP 확인

# 4. Hub 접속 테스트:
curl http://<맥스튜디오-tailscale-ip>:7788/hub/health

# 5. .zprofile 업데이트:
# export HUB_BASE_URL="http://<맥스튜디오-tailscale-ip>:7788"
```

> Tailscale이 안 되면 SSH 터널 폴백:
> `ssh -L 7788:localhost:7788 -L 5432:localhost:5432 mac-studio -N -f`

---

## 12. SSH 설정 (폴백 + 파일 복사용)

```bash
# SSH 키 생성
ssh-keygen -t ed25519 -C "macbook-air-dev"

# ~/.ssh/config
cat >> ~/.ssh/config << 'EOF'

Host mac-studio
  HostName <맥 스튜디오 IP 또는 Tailscale IP>
  User alexlee
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
  # SSH 터널 (Tailscale 안 될 때 수동 실행)
  # LocalForward 7788 localhost:7788
  # LocalForward 5432 localhost:5432
EOF

# 맥 스튜디오에 공개키 등록
ssh-copy-id mac-studio
```

---

## 13. secrets/config 복사

```bash
# 맥 스튜디오에서 Git 제외 파일 복사 (SSH)
for f in \
  bots/reservation/secrets.json \
  bots/worker/secrets.json \
  bots/investment/config.yaml \
  bots/reservation/config.yaml \
  bots/blog/config.json \
  bots/claude/config.json \
  bots/ska/config.json \

  bots/worker/config.json \
  bots/orchestrator/config.json; do
  scp mac-studio:~/projects/ai-agent-system/$f \
      ~/projects/ai-agent-system/$f
done

# 권한 설정
chmod 600 ~/projects/ai-agent-system/bots/*/secrets.json 2>/dev/null
```

---

## 14. Git 설정

```bash
git config --global user.name "AlexLee00"
git config --global user.email "leejearyong@gmail.com"
git config --global core.autocrlf false
git config --global pull.rebase false

gh auth login
```

---

## 15. tmux 세션 구성

```bash
# OPS와 동일한 세션 구조
tmux new-session -d -s code
tmux new-session -d -s dev
```

---

## 16. 환경 검증

```bash
echo "=== 버전 확인 ==="
node -v && npm -v && python3.12 --version && psql --version && git --version

echo "=== 환경변수 ==="
echo "MODE=$MODE PAPER_MODE=$PAPER_MODE NODE_ENV=$NODE_ENV"

echo "=== 프로젝트 문법 ==="
cd ~/projects/ai-agent-system
node --check packages/core/lib/env.js
node --check packages/core/lib/pg-pool.js

echo "=== env.js 로드 테스트 ==="
node -e "
const env = require('./packages/core/lib/env');
console.log('IS_OPS:', env.IS_OPS);
console.log('IS_DEV:', env.IS_DEV);
console.log('PAPER_MODE:', env.PAPER_MODE);
console.log('HUB_BASE_URL:', env.HUB_BASE_URL);
console.log('USE_HUB:', env.USE_HUB);
"

echo "=== Hub 연결 테스트 ==="
curl -s http://localhost:7788/hub/health 2>/dev/null \
  && echo "Hub OK" || echo "Hub 미연결 (Tailscale/SSH 확인)"

echo "=== DB 연결 테스트 (Hub 경유) ==="
curl -s -X POST http://localhost:7788/hub/pg/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HUB_AUTH_TOKEN" \

  -d '{"sql":"SELECT count(*) as cnt FROM investment.positions","schema":"investment"}' \
  2>/dev/null && echo "DB via Hub OK" || echo "DB 미연결"
```

---

## 17. OPS vs DEV 환경 비교표

| 항목 | 맥 스튜디오 (OPS) | 맥북 에어 (DEV) |
|------|-------------------|-----------------|
| MODE | `ops` | `dev` |
| PAPER_MODE | `false` | `true` |
| NODE_ENV | `production` | `development` |
| PostgreSQL | 서버 운영 (localhost:5432) | Hub 경유 또는 SSH 터널 |
| n8n | 설치 + 운영 (localhost:5678) | 미설치 — Hub 경유 |
| launchd 서비스 | 63개 가동 | 없음 |
| cron 배포 | 5분마다 deploy.sh | 없음 |
| Hub | 포트 7788 | 로컬 런타임 |
| Hub | 서버 (포트 7788) | 클라이언트 (HUB_BASE_URL) |
| 역할 | 24/7 에이전트 실행 | 코드 개발 + git push |
| 배포 흐름 | git pull + 자동 재시작 | git push → OPS가 pull |

---

## 18. DEV 작업 흐름

```
1. 맥북 에어에서 코드 수정
2. git push origin main
3. 맥 스튜디오 cron(5분) 또는 GitHub Actions가 자동 pull
4. 변경된 서비스만 launchd 재시작

DB 조회가 필요하면:
  방법 A: Hub 경유 (읽기 전용, 안전)
    curl -X POST http://<hub>/hub/pg/query -d '{"sql":"SELECT ...","schema":"investment"}'
  방법 B: SSH 직접 접속 (쓰기 가능, 주의)
    ssh mac-studio
    psql -U alexlee -d jay
```

---

## 19. API 키 & 시크릿 관리 전략

DEV에서 OPS의 API 키를 그대로 사용하면 안전 사고가 발생할 수 있다.
키를 4개 티어로 분류하여 관리한다.

### 티어 1: Hub 프록시 — DEV에 키 불필요

| 리소스 | 방식 |
|--------|------|
| PostgreSQL | Hub `/hub/pg/query` (읽기 전용) |
| n8n 웹훅 | Hub `/hub/n8n/webhook/:path` |
| launchd 상태 | Hub `/hub/services/status` |

→ DEV에 DB 비밀번호, n8n 자격증명 불필요. Hub가 OPS에서 대행.

### 티어 2: 공유 가능 — 같은 키 사용

| 키 | 이유 |
|----|------|
| LLM API 키 (Anthropic, Groq, Cerebras, xAI, OpenAI, Gemini) | 종량제 과금, DEV 사용량 미미 |
| Telegram bot_token + chat_id | 같은 봇으로 알림 수신 |
| Google Drive 경로 | 동일 계정 |

→ OPS `config.yaml`에서 그대로 복사해도 안전.

### 티어 3: DEV 전용 오버라이드 — 반드시 다르게

| 키 | OPS 값 | DEV 값 |
|----|--------|--------|
| `trading_mode` | `live` | `paper` |
| `paper_mode` | `false` | `true` |
| `binance.testnet` | `false` | `true` |
| `kis.paper_trading` | context-dependent | `true` |
| `worker_jwt_secret` | OPS 값 | DEV 전용 값 생성 |
| `worker_webhook_secret` | OPS 값 | DEV 전용 값 생성 |

→ `scripts/sync-dev-secrets.sh`가 OPS에서 복사 후 자동으로 DEV 값으로 패치.

### 티어 4: OPS 전용 — DEV에 복사하지 않음

| 키 | 이유 |
|----|------|
| Naver 로그인 (naver_id/pw) | 실서비스 예약 시스템 |
| Pickko 로그인 (pickko_id/pw) | 실서비스 키오스크 |
| DB 암호화 키 (db_encryption_key, db_key_pepper) | OPS DB 전용 |
| 공공데이터 API 키 (datagokr_*) | OPS 스케줄러 전용 |

→ `sync-dev-secrets.sh`가 이 키들을 빈 문자열로 마스킹.

### 동기화 스크립트 사용법

```bash
# 맥북 에어(DEV)에서 실행
bash scripts/sync-dev-secrets.sh

# 수행 내용:
# 1. ssh mac-studio에서 secrets/config 파일 scp
# 2. 티어 3: trading_mode=paper, testnet=true 등 자동 패치
# 3. 티어 4: 민감 키 마스킹 (빈 문자열)
# 4. worker secrets: DEV 전용 JWT/webhook 키 자동 생성
# 5. 결과 검증 출력
```

---

## 참고

- Resource API Hub 설계: `docs/OPUS_SESSION_2_HANDOFF.md`
- Codex 프롬프트: `docs/CODEX_P1_ENV_SPREAD.md`, `docs/CODEX_P2_CICD.md`, `docs/CODEX_P3_RESOURCE_HUB.md`
- 소스코드 분석 노션: `325ff93a809a81899098e3b15401b06f`
- 운영 런북: `docs/OPERATIONS_RUNBOOK.md`
