# Codex 프롬프트 P4: 맥북 에어 DEV 환경 셋업 자동화

> 목적: 맥북 에어(DEV)에서 실행하여 맥 스튜디오(OPS)와 동일한 개발환경을 자동 구축하는 스크립트 생성.
> 참조: docs/DEV_ENV_SETUP_MACBOOK_AIR.md (전수조사 기반 502줄)
> 전제: 초기화된 macOS + Xcode CLI Tools 설치 완료 + alexlee 계정
> 실행 위치: 맥북 에어

---

## 작업 1: scripts/setup-dev.sh 신규 생성

맥북 에어에서 한 번 실행하면 전체 개발환경이 구축되는 통합 스크립트.

```bash
#!/bin/bash
# scripts/setup-dev.sh — 맥북 에어 DEV 환경 자동 셋업
# 사용법: bash scripts/setup-dev.sh
# 전제: macOS + Xcode CLI Tools 설치 완료 + alexlee 계정

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "\n${BLUE}━━━ [$1] $2 ━━━${NC}"; }
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; }

echo ""
echo "🚀 팀 제이 — 맥북 에어 DEV 환경 셋업"
echo "   맥 스튜디오 OPS 환경을 기준으로 동일 구성합니다."
echo ""

# ─── 현재 환경 확인 ──────────────────────────────────────────────

if [ "$(whoami)" != "alexlee" ]; then
  fail "alexlee 계정에서 실행하세요 (현재: $(whoami))"
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  warn "arm64(Apple Silicon)가 아닙니다: $(uname -m)"
fi

# ─── 1. Homebrew ──────────────────────────────────────────────────

step "1/10" "Homebrew 설치 확인"

if command -v brew &>/dev/null; then
  ok "Homebrew 이미 설치됨: $(brew --version | head -1)"
else
  echo "  Homebrew 설치 중..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  ok "Homebrew 설치 완료"
fi

# ─── 2. Homebrew 패키지 ───────────────────────────────────────────

step "2/10" "Homebrew 패키지 설치"

BREW_FORMULAE="git node postgresql@17 python@3.12 gh tmux htop mosh wget powerlevel10k"
BREW_CASKS="iterm2 visual-studio-code cursor raycast rectangle maccy font-meslo-lg-nerd-font tailscale"

for pkg in $BREW_FORMULAE; do
  if brew list --formula "$pkg" &>/dev/null; then
    ok "$pkg 이미 설치됨"
  else
    echo "  설치 중: $pkg"
    brew install "$pkg"
    ok "$pkg 설치 완료"
  fi
done

for pkg in $BREW_CASKS; do
  if brew list --cask "$pkg" &>/dev/null; then
    ok "$pkg (cask) 이미 설치됨"
  else
    echo "  설치 중: $pkg (cask)"
    brew install --cask "$pkg" || warn "$pkg 설치 실패 (수동 설치 필요할 수 있음)"
  fi
done

# ─── 3. npm 전역 패키지 ───────────────────────────────────────────

step "3/10" "npm 전역 패키지"

if command -v claude &>/dev/null; then
  ok "claude-code 이미 설치됨"
else
  npm install -g @anthropic-ai/claude-code
  ok "claude-code 설치 완료"
fi

if command -v openclaw &>/dev/null; then
  ok "openclaw 이미 설치됨"
else
  npm install -g openclaw
  ok "openclaw 설치 완료"
fi

# ─── 4. 프로젝트 클론 ────────────────────────────────────────────

step "4/10" "프로젝트 클론 및 의존성"

PROJECT_DIR="$HOME/projects/ai-agent-system"

if [ -d "$PROJECT_DIR/.git" ]; then
  ok "프로젝트 이미 클론됨: $PROJECT_DIR"
  cd "$PROJECT_DIR"
  git pull origin main --ff-only || warn "git pull 실패 (수동 확인 필요)"
else
  mkdir -p "$HOME/projects"

  cd "$HOME/projects"
  git clone https://github.com/AlexLee00/ai-agent-system.git
  cd "$PROJECT_DIR"
  ok "프로젝트 클론 완료"
fi

echo "  npm install (루트)..."
cd "$PROJECT_DIR"
npm install 2>/dev/null
ok "루트 의존성 설치"

if [ -d "$PROJECT_DIR/bots/worker/web" ]; then
  echo "  npm install (worker/web)..."
  cd "$PROJECT_DIR/bots/worker/web"
  npm install 2>/dev/null
  ok "워커 웹 의존성 설치"
fi

if [ -d "$PROJECT_DIR/bots/blog" ]; then
  echo "  npm install (blog)..."
  cd "$PROJECT_DIR/bots/blog"
  npm install 2>/dev/null
  ok "블로그 의존성 설치"
fi

cd "$PROJECT_DIR"

# ─── 5. Python 가상환경 (스카팀) ──────────────────────────────────

step "5/10" "Python 가상환경 (스카팀)"

SKA_DIR="$PROJECT_DIR/bots/ska"
if [ -d "$SKA_DIR" ] && [ -f "$SKA_DIR/requirements.txt" ]; then
  if [ -d "$SKA_DIR/venv" ]; then
    ok "ska venv 이미 존재"
  else
    echo "  가상환경 생성 중..."
    python3.12 -m venv "$SKA_DIR/venv"
    source "$SKA_DIR/venv/bin/activate"
    pip install --upgrade pip -q
    pip install -r "$SKA_DIR/requirements.txt" -q
    deactivate
    ok "ska venv 생성 + 패키지 설치 완료"
  fi
else
  warn "bots/ska 디렉토리 또는 requirements.txt 없음"
fi

# ─── 6. .zprofile 설정 ────────────────────────────────────────────

step "6/10" "~/.zprofile 설정"

ZPROFILE="$HOME/.zprofile"
if grep -q "MODE=dev" "$ZPROFILE" 2>/dev/null; then
  ok ".zprofile 이미 Team Jay 설정 포함"
else
  echo "  .zprofile에 DEV 환경변수 추가 중..."
  cat >> "$ZPROFILE" << 'TEAMJAY_ZPROFILE'

# ─── Team Jay 환경변수 (DEV) ───
eval "$(/opt/homebrew/bin/brew shellenv zsh)"
export TELEGRAM_CHAT_ID="665606590"
export N8N_EMAIL="leejearyong@gmail.com"
export GDRIVE_BLOG_DIR="/Users/alexlee/Library/CloudStorage/GoogleDrive-leejearyong@gmail.com/내 드라이브/010_BlogPost"
export GDRIVE_BLOG_IMAGES="${GDRIVE_BLOG_DIR}/images"
export GDRIVE_BLOG_INSTA="${GDRIVE_BLOG_DIR}/insta"
export PAPER_MODE=true
export MODE=dev
export NODE_ENV=development
export HUB_BASE_URL="http://localhost:7788"
export HUB_AUTH_TOKEN=""
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
TEAMJAY_ZPROFILE
  ok ".zprofile 설정 완료"
  warn "HUB_AUTH_TOKEN을 맥 스튜디오와 동일한 값으로 설정하세요"
fi

# ─── 7. .zshrc 설정 ──────────────────────────────────────────────

step "7/10" "~/.zshrc 설정"

ZSHRC="$HOME/.zshrc"
if grep -q "powerlevel10k" "$ZSHRC" 2>/dev/null; then
  ok ".zshrc 이미 설정됨"
else
  cat >> "$ZSHRC" << 'TEAMJAY_ZSHRC'

[[ -f ~/.zprofile ]] && source ~/.zprofile
setopt AUTO_CD AUTO_PUSHD PUSHD_IGNORE_DUPS HIST_IGNORE_DUPS SHARE_HISTORY
HISTFILE=$HOME/.zsh_history
HISTSIZE=50000
SAVEHIST=50000
export CLICOLOR=1
export TERM=xterm-256color
alias ll='ls -lah'
alias gs='git status -sb'
alias gl='git log --oneline --decorate -10'
if command -v compinit >/dev/null 2>&1; then
  autoload -Uz compinit && compinit
fi
source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
TEAMJAY_ZSHRC
  ok ".zshrc 설정 완료"
fi

# ─── 8. SSH 키 + Git 설정 ─────────────────────────────────────────

step "8/10" "SSH 키 + Git 설정"

if [ -f "$HOME/.ssh/id_ed25519" ]; then
  ok "SSH 키 이미 존재"
else
  echo "  SSH 키 생성 중..."
  ssh-keygen -t ed25519 -C "macbook-air-dev" -f "$HOME/.ssh/id_ed25519" -N ""
  ok "SSH 키 생성 완료"
  warn "맥 스튜디오에 공개키 등록 필요: ssh-copy-id mac-studio"
fi

if ! grep -q "mac-studio" "$HOME/.ssh/config" 2>/dev/null; then
  echo "  SSH config에 mac-studio 호스트 추가..."
  mkdir -p "$HOME/.ssh"
  cat >> "$HOME/.ssh/config" << 'SSH_CONFIG'

Host mac-studio
  HostName <맥 스튜디오 IP 또는 Tailscale IP>
  User alexlee
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
SSH_CONFIG
  ok "SSH config 추가 완료"
  warn "HostName을 실제 맥 스튜디오 IP로 수정하세요"
fi

git config --global user.name "AlexLee00" 2>/dev/null
git config --global user.email "leejearyong@gmail.com" 2>/dev/null
git config --global core.autocrlf false 2>/dev/null
git config --global pull.rebase false 2>/dev/null
ok "Git 글로벌 설정 완료"

# ─── 9. 시크릿/설정 동기화 ────────────────────────────────────────

step "9/10" "시크릿/설정 파일 동기화"

echo "  ⚠️  맥 스튜디오(mac-studio)에 SSH 접속 가능해야 합니다."
echo "  sync-dev-secrets.sh 를 실행하면 자동으로:"
echo "    1. OPS에서 secrets/config 파일 복사"
echo "    2. 트레이딩 모드를 paper로 안전 패치"
echo "    3. OPS 전용 키를 마스킹"
echo ""

if [ -f "$PROJECT_DIR/scripts/sync-dev-secrets.sh" ]; then
  read -p "  지금 시크릿 동기화를 실행할까요? (y/N) " SYNC_ANSWER
  if [ "$SYNC_ANSWER" = "y" ] || [ "$SYNC_ANSWER" = "Y" ]; then
    bash "$PROJECT_DIR/scripts/sync-dev-secrets.sh"
  else
    warn "나중에 실행: bash scripts/sync-dev-secrets.sh"
  fi
else
  warn "scripts/sync-dev-secrets.sh 미존재 — 수동 복사 필요"
fi

# ─── 10. 환경 검증 ───────────────────────────────────────────────

step "10/10" "환경 검증"

# 버전 확인
echo "  Node.js: $(node -v 2>/dev/null || echo 'NOT FOUND')"
echo "  npm: $(npm -v 2>/dev/null || echo 'NOT FOUND')"
echo "  Python: $(python3.12 --version 2>/dev/null || echo 'NOT FOUND')"
echo "  psql: $(psql --version 2>/dev/null || echo 'NOT FOUND')"
echo "  Git: $(git --version 2>/dev/null || echo 'NOT FOUND')"
echo ""

# env.js 로드 테스트
echo "  env.js 로드 테스트..."
cd "$PROJECT_DIR"
node -e "
const env = require('./packages/core/lib/env');
if (!env.IS_DEV) { console.log('  ❌ IS_DEV=false — MODE 확인!'); process.exit(1); }
if (!env.PAPER_MODE) { console.log('  ❌ PAPER_MODE=false — 위험!'); process.exit(1); }
console.log('  ✅ IS_DEV=' + env.IS_DEV);
console.log('  ✅ PAPER_MODE=' + env.PAPER_MODE);
console.log('  ✅ HUB_BASE_URL=' + env.HUB_BASE_URL);
" 2>/dev/null && ok "env.js 정상" || fail "env.js 로드 실패"

# tmux 세션
echo "  tmux 세션 생성..."
tmux new-session -d -s code 2>/dev/null || true
tmux new-session -d -s dev 2>/dev/null || true
ok "tmux 세션: code, dev"


# ─── 결과 출력 ────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 팀 제이 DEV 환경 셋업 완료!${NC}"
echo ""
echo "  다음 단계:"
echo "    1. 새 터미널 열기 (환경변수 적용)"
echo "    2. Tailscale 앱 실행 → 로그인"
echo "    3. ~/.ssh/config의 mac-studio HostName 수정"
echo "    4. ssh-copy-id mac-studio (공개키 등록)"
echo "    5. bash scripts/sync-dev-secrets.sh (시크릿 동기화)"
echo "    6. HUB_AUTH_TOKEN 설정 (~/.zprofile)"
echo ""
echo "  참고: docs/DEV_ENV_SETUP_MACBOOK_AIR.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```


---

## 작업 2: scripts/sync-dev-secrets.sh 신규 생성

OPS에서 시크릿/설정 파일을 복사하고 DEV에 안전하게 패치하는 스크립트.

**API 키 4티어 전략:**
- 티어 1 (Hub 프록시): DB, n8n → DEV에 키 불필요
- 티어 2 (공유): LLM API 키, Telegram → 그대로 복사
- 티어 3 (DEV 오버라이드): 트레이딩 → paper 모드로 자동 패치
- 티어 4 (OPS 전용): Naver/Pickko 로그인, DB 암호화 키 → 마스킹

```bash
#!/bin/bash
# scripts/sync-dev-secrets.sh
# OPS(맥 스튜디오)에서 DEV(맥북 에어)로 시크릿/설정 파일을 안전하게 동기화
#
# 사용법: bash scripts/sync-dev-secrets.sh
# 전제: mac-studio SSH 호스트 설정 완료 (~/.ssh/config)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }

PROJECT_DIR="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"
OPS_HOST="mac-studio"
OPS_PROJECT="~/projects/ai-agent-system"

echo ""
echo "🔄 팀 제이 — DEV 시크릿 동기화"
echo "   OPS ($OPS_HOST) → DEV (로컬)"
echo ""

# ─── 0. SSH 접속 확인 ────────────────────────────────────────────

echo "[ 0 ] SSH 접속 확인"
if ! ssh -o ConnectTimeout=5 "$OPS_HOST" "echo ok" &>/dev/null; then
  fail "$OPS_HOST 접속 불가 — SSH 설정 또는 Tailscale 확인"
fi
ok "$OPS_HOST 접속 확인"

# ─── 1. 파일 복사 (scp) ──────────────────────────────────────────

echo "[ 1 ] OPS에서 시크릿/설정 파일 복사"

FILES=(
  "bots/reservation/secrets.json"
  "bots/worker/secrets.json"
  "bots/investment/config.yaml"
  "bots/reservation/config.yaml"
  "bots/blog/config.json"
  "bots/claude/config.json"
  "bots/ska/config.json"
  "bots/worker/config.json"
  "bots/orchestrator/config.json"
)

COPIED=0
for f in "${FILES[@]}"; do
  mkdir -p "$PROJECT_DIR/$(dirname "$f")"
  if scp -q "$OPS_HOST:$OPS_PROJECT/$f" "$PROJECT_DIR/$f" 2>/dev/null; then
    ok "복사: $f"
    COPIED=$((COPIED+1))
  else
    warn "복사 실패 (파일 없음?): $f"
  fi
done
echo "  $COPIED/${#FILES[@]} 파일 복사 완료"

# ─── 2. 티어 3: config.yaml 안전 패치 (paper 모드) ───────────────

echo ""
echo "[ 2 ] 투자 설정 DEV 패치 (paper 모드)"

INV_YAML="$PROJECT_DIR/bots/investment/config.yaml"
if [ -f "$INV_YAML" ]; then
  # trading_mode: live → paper
  sed -i '' 's/^trading_mode: live/trading_mode: paper/' "$INV_YAML"
  # paper_mode: false → true
  sed -i '' 's/^paper_mode: false/paper_mode: true/' "$INV_YAML"
  # binance testnet: false → true
  sed -i '' 's/^  testnet: false/  testnet: true/' "$INV_YAML"

  # 검증
  TM=$(grep "^trading_mode:" "$INV_YAML" | head -1)
  PM=$(grep "^paper_mode:" "$INV_YAML" | head -1)
  if echo "$TM" | grep -q "paper" && echo "$PM" | grep -q "true"; then
    ok "config.yaml: $TM, $PM"
  else
    warn "config.yaml 패치 불완전: $TM / $PM"
  fi
else
  warn "config.yaml 없음 — 투자 설정 수동 확인 필요"
fi

# ─── 3. 티어 4: secrets.json 민감 키 마스킹 ──────────────────────

echo ""
echo "[ 3 ] OPS 전용 키 마스킹"

RSV_SECRETS="$PROJECT_DIR/bots/reservation/secrets.json"
if [ -f "$RSV_SECRETS" ]; then
  # node 스크립트로 마스킹 (jq 없어도 동작)
  node -e "
    const fs = require('fs');
    const f = '$RSV_SECRETS';
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));

    // 티어 4: OPS 전용 — 빈 문자열로 마스킹
    const mask = [
      'naver_id', 'naver_pw',
      'pickko_id', 'pickko_pw',
      'naver_url', 'pickko_url',
      'db_encryption_key', 'db_key_pepper',
      'datagokr_holiday_key', 'datagokr_weather_key',
      'datagokr_neis_key', 'datagokr_festival_key',
    ];
    let count = 0;
    for (const k of mask) {
      if (k in d) { d[k] = ''; count++; }
    }

    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    console.log('  마스킹 완료: ' + count + '개 키');
  "
  ok "reservation/secrets.json 마스킹"
else
  warn "reservation/secrets.json 없음"
fi

# worker secrets: DEV 전용 JWT 키 자동 생성
WKR_SECRETS="$PROJECT_DIR/bots/worker/secrets.json"
if [ -f "$WKR_SECRETS" ]; then
  node -e "
    const fs = require('fs');
    const crypto = require('crypto');
    const f = '$WKR_SECRETS';
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.worker_jwt_secret = crypto.randomBytes(32).toString('hex');
    d.worker_webhook_secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, JSON.stringify(d, null, 2));
    console.log('  DEV 전용 JWT/webhook 키 생성 완료');
  "
  ok "worker/secrets.json DEV 키 생성"
else
  warn "worker/secrets.json 없음"
fi

# ─── 4. 파일 권한 설정 ───────────────────────────────────────────

echo ""
echo "[ 4 ] 파일 권한 설정"
find "$PROJECT_DIR/bots" -name "secrets.json" -not -path "*/node_modules/*" \
  -exec chmod 600 {} \; 2>/dev/null
ok "secrets.json → 600"

# ─── 5. 결과 요약 ────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ DEV 시크릿 동기화 완료${NC}"
echo ""
echo "  적용된 전략:"
echo "    티어 1 (Hub 프록시): DB/n8n 키 불필요"
echo "    티어 2 (공유): LLM API 키, Telegram → 그대로 복사"
echo "    티어 3 (DEV 패치): trading_mode=paper, testnet=true"
echo "    티어 4 (마스킹): Naver/Pickko/DB암호화 → 빈값"
echo ""

# 검증 출력
if [ -f "$INV_YAML" ]; then
  echo "  investment/config.yaml:"
  grep -E "^(trading_mode|paper_mode)" "$INV_YAML" | sed 's/^/    /'
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
```


---

## 완료 기준

```bash
# 1. 파일 존재 확인
ls scripts/setup-dev.sh
ls scripts/sync-dev-secrets.sh

# 2. 문법 확인
bash -n scripts/setup-dev.sh && echo "setup-dev OK"
bash -n scripts/sync-dev-secrets.sh && echo "sync-dev-secrets OK"

# 3. setup-dev.sh 실행 권한
chmod +x scripts/setup-dev.sh
chmod +x scripts/sync-dev-secrets.sh

# 4. DEV 모드 확인 (setup-dev.sh 실행 후)
MODE=dev node -e "
const env = require('./packages/core/lib/env');
console.assert(env.IS_DEV, 'IS_DEV must be true');
console.assert(env.PAPER_MODE, 'PAPER_MODE must be true');
console.log('✅ DEV 환경 정상');
"

# 5. sync-dev-secrets.sh 패치 검증 (실행 후)
grep "^trading_mode: paper" bots/investment/config.yaml && echo "✅ paper 모드"
```

---

## 커밋 메시지

```
feat(dev): 맥북 에어 DEV 환경 자동 셋업 + 시크릿 안전 동기화

- scripts/setup-dev.sh: DEV 원클릭 셋업 (10단계)
  Homebrew, Node.js, npm 전역, 프로젝트 클론, Python venv,
  .zprofile/.zshrc 자동 설정, SSH 키, 환경 검증

- scripts/sync-dev-secrets.sh: OPS→DEV 시크릿 안전 동기화
  API 키 4티어 전략:
  티어 1: Hub 프록시 — DEV에 키 불필요 (DB, n8n)
  티어 2: 공유 — LLM API 키, Telegram 그대로 복사
  티어 3: DEV 오버라이드 — trading_mode=paper, testnet=true 자동 패치
  티어 4: OPS 전용 — Naver/Pickko/DB암호화 키 마스킹
  worker JWT/webhook 키 DEV 전용 랜덤 생성
```
