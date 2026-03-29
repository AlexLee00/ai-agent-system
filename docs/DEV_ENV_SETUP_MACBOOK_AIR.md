# 맥북 에어 개발환경 셋업 가이드

> 기준: 맥 스튜디오 M4 Max (운영 머신) 환경 기준  
> 대상: 맥북 에어 15 M3 24GB/1TB (개발 머신)  
> 계정명: `alexlee`  
> 작성일: 2026-03-29

---

## 0. 전제조건

- macOS 최신 업데이트 완료
- Xcode Command Line Tools 설치됨: `xcode-select --install`
- 맥 스튜디오와 같은 Apple ID 로그인 불필요 (독립 개발 환경)
- DB는 SSH 터널로 맥 스튜디오 PostgreSQL 접근 (로컬 DB 불필요)

---

## 1. Homebrew 설치

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
```

---

## 2. Homebrew 패키지 설치

```bash
# 핵심 패키지
brew install git node postgresql@17 pgvector python@3.12

# 개발 도구
brew install gh tmux htop mosh

# 터미널 꾸미기
brew install powerlevel10k font-meslo-lg-nerd-font

# PostgreSQL PATH 등록
echo 'export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >> ~/.zprofile
```

> **참고**: 맥북 에어는 개발 전용이므로 n8n은 맥 스튜디오에서만 운영.  
> 로컬 PostgreSQL 서버 시작 불필요 — SSH 터널로 맥 스튜디오 DB 사용.

---

## 3. Homebrew Cask (GUI 앱)

```bash
brew install --cask \
  iterm2 \
  visual-studio-code \
  cursor \
  raycast \
  rectangle \
  maccy \
  font-meslo-lg-nerd-font
```

> OrbStack은 Docker 사용 시 필요. 현재 미사용이면 생략 가능.

---

## 4. Node.js 버전 확인

```bash
node -v   # v25.x 이상 확인
npm -v    # v11.x 이상 확인
```

버전이 맞지 않으면:
```bash
brew upgrade node
```

---

## 5. 전역 npm 패키지 설치

```bash
npm install -g @anthropic-ai/claude-code@2.1.87
npm install -g openclaw@2026.3.24
```

> `n8n`은 맥 스튜디오 전용 — 맥북 에어에는 설치 불필요.

---

## 6. 프로젝트 클론 및 의존성 설치

```bash
# 프로젝트 클론
mkdir -p ~/projects
cd ~/projects
git clone https://github.com/AlexLee00/ai-agent-system.git
cd ai-agent-system

# 루트 의존성
npm install

# 워커 웹 의존성
cd bots/worker/web
npm install
cd ../../..

# 블로그 의존성
cd bots/blog
npm install
cd ../..
```

---

## 7. Python 가상환경 (스카팀 ska 봇)

```bash
cd ~/projects/ai-agent-system/bots/ska

# Python 3.12 경로 확인
which python3.12  # /opt/homebrew/bin/python3.12

# 가상환경 생성
python3.12 -m venv venv

# 활성화 및 패키지 설치
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate
```

---

## 8. ~/.zprofile 설정

```bash
cat >> ~/.zprofile << 'EOF'

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
EOF
```

> **주의**: 맥북 에어는 개발 환경이므로 `MODE=dev`, `PAPER_MODE=true` 설정.  
> 맥 스튜디오는 `MODE=ops`, `PAPER_MODE=false`.

---

## 9. ~/.zshrc 설정

```bash
cat >> ~/.zshrc << 'EOF'

[[ -f ~/.zprofile ]] && source ~/.zprofile

# ─── zsh 옵션 ───
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

# ─── 별칭 ───
alias ll='ls -lah'
alias la='ls -A'
alias gs='git status -sb'
alias gl='git log --oneline --decorate -10'
alias v='nvim'

# Docker
alias dps='docker ps'
alias dimg='docker images'
alias dlog='docker logs'
alias dexec='docker exec -it'
alias dcu='docker compose up -d'
alias dcd='docker compose down'
alias dcb='docker compose build'
alias dcl='docker compose logs -f'
alias dcps='docker compose ps'

# ─── 자동완성 ───
if command -v compinit >/dev/null 2>&1; then
  autoload -Uz compinit
  compinit
fi

# ─── Powerlevel10k ───
source /opt/homebrew/share/powerlevel10k/powerlevel10k.zsh-theme
[[ -f ~/.p10k.zsh ]] && source ~/.p10k.zsh
EOF
```

---

## 10. SSH 터널 설정 (맥 스튜디오 DB 접근)

개발 중 PostgreSQL 접근은 SSH 터널로 맥 스튜디오 DB를 사용한다.

```bash
# ~/.ssh/config 에 맥 스튜디오 호스트 추가
cat >> ~/.ssh/config << 'EOF'

Host mac-studio
  HostName <맥 스튜디오 IP 또는 mDNS>
  User alexlee
  IdentityFile ~/.ssh/id_ed25519
  ServerAliveInterval 60
EOF

# SSH 키 생성 (없는 경우)
ssh-keygen -t ed25519 -C "macbook-air-dev"

# 맥 스튜디오에 공개키 등록
ssh-copy-id mac-studio
```

터널 시작 (DB 접근 시):
```bash
# 포트 포워딩: 로컬 5432 → 맥 스튜디오 5432
ssh -L 5432:localhost:5432 mac-studio -N -f
```

---

## 11. secrets.json 설정

각 봇의 `secrets.json`은 Git에 포함되지 않으므로 별도 복사 필요.

```bash
# 맥 스튜디오에서 복사 (SSH)
scp mac-studio:~/projects/ai-agent-system/bots/reservation/secrets.json \
    ~/projects/ai-agent-system/bots/reservation/secrets.json

scp mac-studio:~/projects/ai-agent-system/bots/worker/secrets.json \
    ~/projects/ai-agent-system/bots/worker/secrets.json

scp mac-studio:~/projects/ai-agent-system/bots/investment/secrets.json \
    ~/projects/ai-agent-system/bots/investment/secrets.json
    
scp mac-studio:~/projects/ai-agent-system/bots/blog/config.json \
    ~/projects/ai-agent-system/bots/blog/config.json
    
scp mac-studio:~/projects/ai-agent-system/bots/investment/config.yaml \
    ~/projects/ai-agent-system/bots/investment/config.yaml
```

---

## 12. Git 설정

```bash
git config --global user.name "AlexLee00"
git config --global user.email "leejearyong@gmail.com"
git config --global core.autocrlf false
git config --global pull.rebase false

# GitHub CLI 로그인
gh auth login
```

---

## 13. 환경 검증

```bash
# Node.js
node -v && npm -v

# Python
python3.12 --version

# PostgreSQL 클라이언트 (로컬 서버 불필요)
psql --version

# Claude Code
claude --version

# 프로젝트 문법 체크
node --check ~/projects/ai-agent-system/packages/core/lib/pg-pool.js
```

---

## 14. 맥 스튜디오 vs 맥북 에어 차이 정리

| 항목 | 맥 스튜디오 (운영) | 맥북 에어 (개발) |
|------|-------------------|------------------|
| MODE | ops | dev |
| PAPER_MODE | false | true |
| NODE_ENV | production | development |
| PostgreSQL | 서버 운영 중 | SSH 터널 접근 |
| n8n | 설치 + 운영 | 미설치 |
| launchd 서비스 | 전체 가동 | 가동 안 함 |
| 자동 배포 수신 | deploy.sh cron | 없음 |

---

## 참고

- 소스코드 분석 노션: `325ff93a809a81899098e3b15401b06f`
- SESSION_HANDOFF: `docs/SESSION_HANDOFF.md`
- 운영 런북: `docs/OPERATIONS_RUNBOOK.md`
