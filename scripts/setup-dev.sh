#!/bin/bash
# scripts/setup-dev.sh — 맥북 에어 DEV 환경 자동 셋업
# 사용법: bash scripts/setup-dev.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "\n${BLUE}━━━ [$1] $2 ━━━${NC}"; }
ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }

PROJECT_DIR="${PROJECT_ROOT:-$HOME/projects/ai-agent-system}"
ZPROFILE="${HOME}/.zprofile"
ZSHRC="${HOME}/.zshrc"

TEAMJAY_ZPROFILE_BLOCK='
# >>> TEAMJAY DEV START >>>
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
# <<< TEAMJAY DEV END <<<
'

TEAMJAY_ZSHRC_BLOCK='
# >>> TEAMJAY DEV START >>>
[[ -f ~/.zprofile ]] && source ~/.zprofile
setopt AUTO_CD AUTO_PUSHD PUSHD_IGNORE_DUPS HIST_IGNORE_DUPS SHARE_HISTORY
HISTFILE=$HOME/.zsh_history
HISTSIZE=50000
SAVEHIST=50000
export CLICOLOR=1
export TERM=xterm-256color
alias ll="ls -lah"
alias gs="git status -sb"
alias gl="git log --oneline --decorate -10"
if command -v compinit >/dev/null 2>&1; then
  autoload -Uz compinit && compinit
fi
source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
# <<< TEAMJAY DEV END <<<
'

replace_block() {
  local file="$1"
  local block="$2"
  local start_marker="$3"
  local end_marker="$4"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  python3 - "$file" "$block" "$start_marker" "$end_marker" <<'PY'
import sys
from pathlib import Path

file_path = Path(sys.argv[1])
block = sys.argv[2].strip('\n')
start = sys.argv[3]
end = sys.argv[4]
text = file_path.read_text() if file_path.exists() else ''

start_idx = text.find(start)
end_idx = text.find(end)

if start_idx != -1 and end_idx != -1 and end_idx >= start_idx:
    end_idx += len(end)
    new_text = text[:start_idx].rstrip() + '\n\n' + block + '\n'
    tail = text[end_idx:].lstrip('\n')
    if tail:
        new_text += '\n' + tail
else:
    new_text = text.rstrip()
    if new_text:
        new_text += '\n\n'
    new_text += block + '\n'

file_path.write_text(new_text)
PY
}

echo ""
echo "🚀 팀 제이 — 맥북 에어 DEV 환경 셋업"
echo "   맥 스튜디오 OPS 환경을 기준으로 동일 구성합니다."
echo ""

if [ "$(whoami)" != "alexlee" ]; then
  fail "alexlee 계정에서 실행하세요 (현재: $(whoami))"
fi

if [ "$(uname -m)" != "arm64" ]; then
  warn "arm64(Apple Silicon)가 아닙니다: $(uname -m)"
fi

step "1/10" "Homebrew 설치 확인"
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew 이미 설치됨: $(brew --version | head -1)"
else
  echo "  Homebrew 설치 중..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
  ok "Homebrew 설치 완료"
fi

step "2/10" "Homebrew 패키지 설치"
BREW_FORMULAE="git node postgresql@17 python@3.12 gh tmux htop mosh wget"
BREW_CASKS="iterm2 visual-studio-code cursor raycast rectangle maccy font-meslo-lg-nerd-font tailscale"

for pkg in $BREW_FORMULAE; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then
    ok "$pkg 이미 설치됨"
  else
    echo "  설치 중: $pkg"
    brew install "$pkg"
    ok "$pkg 설치 완료"
  fi
done

for pkg in $BREW_CASKS; do
  if brew list --cask "$pkg" >/dev/null 2>&1; then
    ok "$pkg (cask) 이미 설치됨"
  else
    echo "  설치 중: $pkg (cask)"
    brew install --cask "$pkg" || warn "$pkg 설치 실패 (수동 설치 필요할 수 있음)"
  fi
done

step "3/10" "npm 전역 패키지"
if command -v claude >/dev/null 2>&1; then
  ok "claude-code 이미 설치됨"
else
  npm install -g @anthropic-ai/claude-code
  ok "claude-code 설치 완료"
fi

step "4/10" "프로젝트 클론 및 의존성"
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

cd "$PROJECT_DIR"
echo "  npm install (루트)..."
npm install || warn "루트 npm install 실패"
ok "루트 의존성 설치 확인"

if [ -d "$PROJECT_DIR/bots/worker/web" ]; then
  echo "  npm install (worker/web)..."
  (cd "$PROJECT_DIR/bots/worker/web" && npm install) || warn "worker/web npm install 실패"
  ok "워커 웹 의존성 설치 확인"
fi

if [ -d "$PROJECT_DIR/bots/blog" ]; then
  echo "  npm install (blog)..."
  (cd "$PROJECT_DIR/bots/blog" && npm install) || warn "blog npm install 실패"
  ok "블로그 의존성 설치 확인"
fi

step "5/10" "Python 가상환경 (스카팀)"
SKA_DIR="$PROJECT_DIR/bots/ska"
if [ -d "$SKA_DIR" ] && [ -f "$SKA_DIR/requirements.txt" ]; then
  if [ -d "$SKA_DIR/venv" ]; then
    ok "ska venv 이미 존재"
  else
    echo "  가상환경 생성 중..."
    python3.12 -m venv "$SKA_DIR/venv"
    # shellcheck disable=SC1091
    source "$SKA_DIR/venv/bin/activate"
    pip install --upgrade pip
    pip install -r "$SKA_DIR/requirements.txt"
    deactivate
    ok "ska venv 생성 + 패키지 설치 완료"
  fi
else
  warn "bots/ska 디렉토리 또는 requirements.txt 없음"
fi

step "6/10" "~/.zprofile 설정"
replace_block "$ZPROFILE" "$TEAMJAY_ZPROFILE_BLOCK" "# >>> TEAMJAY DEV START >>>" "# <<< TEAMJAY DEV END <<<"
ok ".zprofile Team Jay DEV 블록 반영"
warn "HUB_AUTH_TOKEN은 OPS와 동일한 값으로 수동 설정하세요"

step "7/10" "~/.zshrc 설정"
replace_block "$ZSHRC" "$TEAMJAY_ZSHRC_BLOCK" "# >>> TEAMJAY DEV START >>>" "# <<< TEAMJAY DEV END <<<"
ok ".zshrc Team Jay DEV 블록 반영"

step "8/10" "SSH 키 + Git 설정"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ -f "$HOME/.ssh/id_ed25519" ]; then
  ok "SSH 키 이미 존재"
else
  echo "  SSH 키 생성 중..."
  ssh-keygen -t ed25519 -C "macbook-air-dev" -f "$HOME/.ssh/id_ed25519" -N ""
  ok "SSH 키 생성 완료"
  warn "맥 스튜디오에 공개키 등록 필요"
fi

if ! grep -q "^Host mac-studio$" "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<'SSH_CONFIG'

Host mac-studio
  HostName <맥 스튜디오 IP 또는 Tailscale IP>
  User alexlee
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
SSH_CONFIG
  ok "SSH config 추가 완료"
  warn "HostName을 실제 맥 스튜디오 IP로 수정하세요"
else
  ok "SSH config에 mac-studio 이미 존재"
fi
chmod 600 "$HOME/.ssh/config" 2>/dev/null || true

git config --global user.name "AlexLee00"
git config --global user.email "leejearyong@gmail.com"
git config --global core.autocrlf false
git config --global pull.rebase false
ok "Git 글로벌 설정 완료"

step "9/10" "시크릿/설정 파일 동기화"
echo "  ⚠️  맥 스튜디오(mac-studio)에 SSH 접속 가능해야 합니다."
echo "  sync-dev-secrets.sh 를 실행하면 자동으로:"
echo "    1. OPS에서 secrets/config 파일 복사"
echo "    2. 트레이딩 모드를 paper/testnet으로 안전 패치"
echo "    3. OPS 전용 키를 마스킹"

if [ -f "$PROJECT_DIR/scripts/sync-dev-secrets.sh" ]; then
  read -r -p "  지금 시크릿 동기화를 실행할까요? (y/N) " SYNC_ANSWER
  if [ "$SYNC_ANSWER" = "y" ] || [ "$SYNC_ANSWER" = "Y" ]; then
    bash "$PROJECT_DIR/scripts/sync-dev-secrets.sh"
  else
    warn "나중에 실행: bash scripts/sync-dev-secrets.sh"
  fi
else
  warn "scripts/sync-dev-secrets.sh 미존재 — 수동 복사 필요"
fi

step "10/10" "환경 검증"
echo "  Node.js: $(node -v 2>/dev/null || echo 'NOT FOUND')"
echo "  npm: $(npm -v 2>/dev/null || echo 'NOT FOUND')"
echo "  Python: $(python3.12 --version 2>/dev/null || echo 'NOT FOUND')"
echo "  psql: $(psql --version 2>/dev/null || echo 'NOT FOUND')"
echo "  Git: $(git --version 2>/dev/null || echo 'NOT FOUND')"
echo ""

echo "  env.js 로드 테스트..."
cd "$PROJECT_DIR"
node -e "
const env = require('./packages/core/lib/env');
if (!env.IS_DEV) { console.log('  ❌ IS_DEV=false — MODE 확인!'); process.exit(1); }
if (!env.PAPER_MODE) { console.log('  ❌ PAPER_MODE=false — 위험!'); process.exit(1); }
console.log('  ✅ IS_DEV=' + env.IS_DEV);
console.log('  ✅ PAPER_MODE=' + env.PAPER_MODE);
console.log('  ✅ HUB_BASE_URL=' + env.HUB_BASE_URL);
" && ok "env.js 정상" || fail "env.js 로드 실패"

tmux new-session -d -s code 2>/dev/null || true
tmux new-session -d -s dev 2>/dev/null || true
ok "tmux 세션: code, dev"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}🎉 팀 제이 DEV 환경 셋업 완료!${NC}"
echo ""
echo "  다음 단계:"
echo "    1. 새 터미널 열기 (환경변수 적용)"
echo "    2. Tailscale 앱 실행 → 로그인"
echo "    3. ~/.ssh/config의 mac-studio HostName 수정"
echo "    4. 공개키를 OPS에 등록"
echo "    5. bash scripts/sync-dev-secrets.sh"
echo "    6. HUB_AUTH_TOKEN 설정 (~/.zprofile)"
echo ""
echo "  참고: docs/DEV_ENV_SETUP_MACBOOK_AIR.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
