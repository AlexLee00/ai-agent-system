# 맥미니 이전 스크립트

## 순서

### Step 1 — 맥북프로에서: 파일 전송

```bash
# 맥미니 IP 확인 후
cd ~/projects/ai-agent-system
bash scripts/migrate/01-push.sh 192.168.x.x
```

전송 항목:
- `ai-agent-system/` (node_modules 제외)
- `rag-system/` (.venv 제외)
- `~/.openclaw/` (Chrome 프로필 포함 ~580MB)
- `~/.claude/` 메모리·설정
- launchd plists

### Step 2 — 맥미니에서: 설정

```bash
ssh alexlee@<맥미니-IP>
bash ~/projects/ai-agent-system/scripts/migrate/02-setup.sh
```

설치 항목:
- Homebrew, nvm, Node v24.13.1, Python 3.12
- npm global: openclaw, claude-code
- Node deps: npm install (루트 + reservation)
- Playwright Chromium
- Python venv: ska + rag-system
- launchd plist 수정(TMPDIR, nvm 경로) + 등록

### Step 3 — 맥미니에서: 검증

```bash
bash ~/projects/ai-agent-system/scripts/migrate/03-verify.sh
```

확인 항목:
- 서비스 3종 실행 여부
- DB 파일 무결성 (state.db, ska.duckdb)
- ETL 동작 테스트
- Python import 확인

### Step 4 — 수동 (스크립트 이후)

1. `openclaw auth login google-gemini-cli` — Gemini 재인증
2. 텔레그램으로 스카 응답 확인
3. 맥북프로 서비스 중단: `launchctl unload ~/Library/LaunchAgents/ai.*.plist`

## 주의사항

- `secrets.json`은 AirDrop으로 별도 전송 필요할 수 있음 (01-push.sh에 포함되나 재확인)
- 맥미니 사용자명은 `alexlee`로 동일하게 생성할 것 (경로 하드코딩 때문)
- Chrome 네이버 프로필 로그인 세션 만료 시 재로그인 필요
