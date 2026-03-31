# Codex 프롬프트: 맥북 에어 개발환경 셋업

> 메티가 Codex에 위임하는 실행 프롬프트  
> 대상 머신: 맥북 에어 15 M3 24GB/1TB (계정명: alexlee)

---

## 프롬프트

```
당신은 팀 제이(Team Jay) ai-agent-system의 개발 환경 셋업을 담당합니다.

## 목표

맥 스튜디오 M4 Max(운영 머신)와 동일한 개발 도구 환경을
맥북 에어 M3(개발 머신)에 구성합니다.

## 작업 순서

아래 순서를 그대로 따라 실행하세요.
각 단계에서 오류가 발생하면 멈추고 보고하세요.
이미 설치된 항목은 건너뜁니다.

---

### 1단계: Xcode CLI 도구 확인

```bash
xcode-select -p || xcode-select --install
```

---

### 2단계: Homebrew 설치 및 업데이트

```bash
# 미설치 시에만
if ! command -v brew &>/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

eval "$(/opt/homebrew/bin/brew shellenv)"
brew update
```

---

### 3단계: Homebrew 패키지 설치

```bash
brew install \
  git \
  node \
  postgresql@17 \
  pgvector \
  python@3.12 \
  gh \
  tmux \
  htop \
  mosh \
  powerlevel10k

brew install --cask \
  iterm2 \
  visual-studio-code \
  cursor \
  raycast \
  rectangle \
  maccy \
  font-meslo-lg-nerd-font
```

---

### 4단계: Node.js 전역 패키지 설치

```bash
npm install -g @anthropic-ai/claude-code@2.1.87
npm install -g openclaw@2026.3.24
```

---

### 5단계: ~/.zprofile 작성

파일이 없거나 Team Jay 설정이 없는 경우에만 추가합니다.

```bash
if ! grep -q "Team Jay 환경변수" ~/.zprofile 2>/dev/null; then
cat >> ~/.zprofile << 'ZPROFILE_EOF'

eval "$(/opt/homebrew/bin/brew shellenv zsh)"

# ─── Team Jay 환경변수 ───
export TELEGRAM_CHAT_ID="665606590"
export N8N_EMAIL="leejearyong@gmail.com"
export GDRIVE_BLOG_DIR="/Users/alexlee/Library/CloudStorage/GoogleDrive-leejearyong@gmail.com/내 드라이브/010_BlogPost"
export GDRIVE_BLOG_IMAGES="${GDRIVE_BLOG_DIR}/images"
export GDRIVE_BLOG_INSTA="${GDRIVE_BLOG_DIR}/insta"

# ─── 개발 환경 설정 (dev) ───
export PAPER_MODE=true
export MODE=dev
export NODE_ENV=development

# PostgreSQL@17 PATH
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

ZPROFILE_EOF
fi
```

**주의**: 맥북 에어는 개발 머신이므로 반드시 `MODE=dev`, `PAPER_MODE=true`로 설정합니다.
운영 머신(맥 스튜디오)의 `MODE=ops`와 혼동하지 마세요.

---

### 6단계: ~/.zshrc 작성

```bash
if ! grep -q "Team Jay" ~/.zshrc 2>/dev/null; then
cat >> ~/.zshrc << 'ZSHRC_EOF'

[[ -f ~/.zprofile ]] && source ~/.zprofile

setopt AUTO_CD
setopt AUTO_PUSHD
setopt PUSHD_IGNORE_DUPS
setopt HIST_IGNORE_DUPS
setopt SHARE_HISTORY
setopt INTERACTIVE_COMMENTS

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
alias v='nvim'
alias dps='docker ps'
alias dimg='docker images'
alias dlog='docker logs'
alias dexec='docker exec -it'
alias dcu='docker compose up -d'
alias dcd='docker compose down'
alias dcb='docker compose build'
alias dcl='docker compose logs -f'
alias dcps='docker compose ps'

if command -v compinit >/dev/null 2>&1; then
  autoload -Uz compinit
  compinit
fi

source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh

ZSHRC_EOF
fi
```

---

### 7단계: 프로젝트 클론

```bash
mkdir -p ~/projects
cd ~/projects

if [ ! -d "ai-agent-system" ]; then
  git clone https://github.com/AlexLee00/ai-agent-system.git
fi

cd ai-agent-system
```

---

### 8단계: npm 의존성 설치

```bash
cd ~/projects/ai-agent-system

# 루트
npm install

# 워커 웹 (Next.js 14)
cd bots/worker/web && npm install && cd ../../..

# 블로그
cd bots/blog && npm install && cd ../..
```

---

### 9단계: Python 가상환경 (스카팀)

```bash
cd ~/projects/ai-agent-system/bots/ska

if [ ! -d "venv" ]; then
  python3.12 -m venv venv
fi

source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate
```

---

### 10단계: Git 전역 설정

```bash
git config --global user.name "AlexLee00"
git config --global user.email "leejearyong@gmail.com"
git config --global core.autocrlf false
git config --global pull.rebase false
```

---

### 11단계: SSH 설정 (맥 스튜디오 DB 터널용)

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# SSH 키 생성 (없는 경우)
if [ ! -f ~/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -C "macbook-air-dev" -f ~/.ssh/id_ed25519 -N ""
fi

# ~/.ssh/config에 맥 스튜디오 호스트 추가
if ! grep -q "Host mac-studio" ~/.ssh/config 2>/dev/null; then
cat >> ~/.ssh/config << 'SSH_EOF'

Host mac-studio
  HostName <맥_스튜디오_IP>
  User alexlee
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
  ServerAliveCountMax 3

SSH_EOF
fi

chmod 600 ~/.ssh/config
```

**주의**: `<맥_스튜디오_IP>` 자리에 실제 맥 스튜디오 IP 또는 `.local` mDNS 주소를 입력하세요.
설치 후 `ssh mac-studio` 로 연결 테스트, 연결되면 `ssh-copy-id mac-studio` 실행.

---

### 12단계: 환경 검증

아래 항목을 순서대로 확인하고 결과를 보고하세요.

```bash
echo "=== Node.js ===" && node -v
echo "=== npm ===" && npm -v
echo "=== Python ===" && python3.12 --version
echo "=== PostgreSQL 클라이언트 ===" && psql --version
echo "=== Claude Code ===" && claude --version
echo "=== OpenClaw ===" && openclaw --version 2>/dev/null || echo "openclaw 확인 필요"
echo "=== Git ===" && git --version && git config --list --global
echo "=== ska venv ===" && ls ~/projects/ai-agent-system/bots/ska/venv/bin/python
echo "=== 프로젝트 문법 체크 ===" && node --check ~/projects/ai-agent-system/packages/core/lib/pg-pool.js
```

---

## 완료 후 수동 처리 항목 (Codex 범위 외)

다음 항목은 보안 정보가 포함되므로 Jay(메티)가 직접 처리합니다:

1. **secrets.json 복사**: 각 봇의 `secrets.json`을 맥 스튜디오에서 SCP로 복사
2. **SSH 공개키 등록**: 맥 스튜디오에서 `authorized_keys`에 추가
3. **SSH 터널 확인**: `ssh -L 5432:localhost:5432 mac-studio -N` 연결 테스트
4. **GitHub CLI 인증**: `gh auth login` 실행

---

## 참고 문서

- 상세 가이드: `docs/DEV_ENV_SETUP_MACBOOK_AIR.md`
- 소스코드 분석: 노션 `325ff93a809a81899098e3b15401b06f`
- SESSION_HANDOFF: `docs/SESSION_HANDOFF.md`
```
