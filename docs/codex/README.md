# docs/codex/ — 코덱스 프롬프트 보관소

> 이 디렉토리는 **로컬 전용**이며 Git에서 추적되지 않습니다.
> 유일하게 이 `README.md` 파일만 예외적으로 Git에 올라갑니다.

## 🎯 디렉토리 목적

메티(claude.ai) ↔ 코덱스(Claude Code) 협업에서 사용되는 **구현 지시서**를 보관.

## ⚠️ 절대 규칙 (위반 시 SEC-005 재발)

### 1. 민감값 평문 금지
- 계좌번호, 지갑 주소, API 키, 토큰, 전화번호, 비밀번호 등
- placeholder 사용: `<KIS_ACCOUNT_NUMBER>`, `<USDT_ADDRESS>`, `<GEMINI_API_KEY>`

### 2. Git 강제 추적 금지
- 이 경로는 `.gitignore`에 등록되어 있음
- 실수로 추적되면: `git rm --cached docs/codex/<파일명>`

### 3. Pre-commit 훅 방어선
- `scripts/pre-commit` 훅에 `docs/codex/` 경로 차단 규칙 있음
- 훅 우회 금지 (`git commit --no-verify` 금지)

## 🔄 협업 플로우

**새 프롬프트 작성 시 (메티)**:
1. `docs/codex/CODEX_<TASK_NAME>.md` 로컬 작성
2. `git check-ignore -v docs/codex/CODEX_<TASK_NAME>.md` 확인 → ignored 메시지 떠야 정상
3. placeholder 엄격 준수
4. 마스터에게 공유

**프롬프트 실행 시 (코덱스)**:
1. 로컬에서 읽기 → 지시사항 구현
2. 프롬프트 파일 자체를 커밋에 포함하지 않기
3. 구현물만 커밋

**검증 시 (메티)**:
1. 커밋 SHA 확인
2. 변경 파일이 프롬프트 체크리스트와 매치하는지
3. 수락 기준 명령어 재현
4. KNOWN_ISSUES.md 상태 업데이트

## 🏷️ 역사

- **2026-04-17**: SEC-005 사고 발생 및 긴급 대응
- **2026-04-17**: 구조적 재발 방지 3중 방어 구축 (gitignore + pre-commit + README)

---
**요약**: 이 디렉토리는 민감한 구현 지시서를 담고, Git에는 오로지 이 README만 올라갑니다.
