# CLAUDE.md — Claude Code 세션 규칙

> 이 파일은 Claude Code (CLI)가 세션 시작 시 자동으로 읽는 지시 파일입니다.
> 모든 세션에서 아래 규칙이 최우선 적용됩니다.

---

## PATCH_REQUEST.md 처리 규칙

### 규칙 1: 세션 시작 시 자동 확인
- 세션이 시작될 때 프로젝트 루트에 `PATCH_REQUEST.md`가 존재하는지 확인합니다.
- 파일이 존재하면 반드시 내용을 읽고, 사용자에게 요약하여 알립니다.
- 단, 사용자가 이미 다른 작업을 지시했다면 해당 작업 완료 후 알립니다.

### 규칙 2: 패치 처리 순서
1. `critical` / `high` 보안 취약점 → 즉시 조치 (사용자 확인 후)
2. Breaking 패키지 업데이트 → 사용자 확인 필수 (변경사항 검토)
3. 일반 패키지 업데이트 → 사용자 확인 후 일괄 처리
4. LLM API 변경사항 → 영향받는 코드 파악 후 보고
5. AI 기술 트렌드 → 참고만 (즉각 조치 불필요)

### 규칙 3: 처리 완료 후 파일 처리
- 모든 패치 작업 완료 후 `PATCH_REQUEST.md` 파일을 삭제합니다.
- 단, 미완료 항목이 있으면 해당 항목만 남기고 파일을 업데이트합니다.

### 규칙 4: 자동 처리 금지 항목
- 실제 라이브 서버에 영향을 주는 변경 (반드시 사용자 확인)
- Breaking change가 있는 메이저 버전 업그레이드
- 프로덕션 환경 변수 및 API 키 변경

---

## 팀 버스 (Team Bus) 규칙

### 구조
- DB 위치: `~/.openclaw/workspace/claude-team.db`
- 관리 모듈: `bots/claude/lib/team-bus.js`
- 마이그레이션: `bots/claude/migrations/001_team_bus.js`

### 팀원 상태 확인
```bash
# 클로드팀 전체 상태
node bots/claude/scripts/team-status.js
# 또는
cd bots/claude && npm run status
```

### 패치 현황 확인
```bash
node bots/claude/scripts/patch-status.js
# 또는
cd bots/claude && npm run patch:status
```

---

## 클로드팀 봇 실행 명령

```bash
cd bots/claude

# 덱스터 (시스템 점검)
npm run dexter              # 기본 점검
npm run dexter:full         # 전체 점검 (npm audit 포함)
npm run dexter:fix          # 자동 수정 + 텔레그램 알림
npm run dexter:daily        # 일일 보고 (텔레그램)
npm run dexter:checksums    # 체크섬 갱신 (코드 수정 후)
npm run dexter:quick        # 퀵체크 수동 실행 (5분 주기: ai.claude.dexter.quick)

# 패턴 이력 초기화
node src/dexter.js --clear-patterns --label=<레이블>   # 특정 이슈 이력 삭제
node src/dexter.js --clear-patterns --check=<체크명>    # 특정 체크 모듈 이력 삭제
node src/dexter.js --clear-patterns --all               # 전체 이력 삭제

# 아처 (기술 인텔리전스)
npm run archer              # 데이터 수집 + Claude 분석 (텔레그램 없음)
npm run archer:telegram     # 데이터 수집 + Claude 분석 + 텔레그램
npm run archer:fetch-only   # 데이터 수집만 (디버그)

# 유틸
npm run migrate             # claude-team.db 마이그레이션
npm run status              # 팀 상태 콘솔
npm run patch:status        # 패치 현황 콘솔
```

---

## 절대 규칙 (변경 불가)

- 시스템 기본 언어: **한국어** (코드 주석, 로그, 알림 포함)
- 봇 이름 변경 불가: 클로드, 스카, 루나, 덱스터, 아처 등
- OPS 전환은 반드시 사용자 확인 후에만
- secrets.json, API 키 파일은 절대 Git 커밋 금지
