# 인수인계: DEV 은퇴 → OPS 직접 개발 (메모리·프로젝트 지식 갱신 잔여)

작성: 메티 / 2026-06-07 / 대상: 새 일반 Claude 채팅(같은 프로젝트)

## 1. 배경 — 운영 원칙 변경
- **2026-06: DEV(맥북 에어 M3) 은퇴.** 개발·운영 모두 **맥 스튜디오(OPS) 단일 머신**에서 직접 진행.
- 기존 "개발/운영 분리 불변 원칙(모든 구현은 DEV에서 / OPS 직접 수정 금지)" → **폐기**, "OPS 직접 개발"로 대체.
- **불변(유지)**: 3역할 절차 — 메티(기획·설계·검증) → 코덱스(구현) → 마스터(승인/커밋). PROTECTED launchd(`ai.{ska,luna,investment,claude,elixir,hub}.*`)·crypto LIVE·스카 매출 무중단.

## 2. 직전 세션(Desktop Commander / OPS)에서 완료
- 레포 정식 문서 3개 갱신: `CLAUDE.md`(하드웨어·구현원칙), `docs/ROLE_PRINCIPLES.md`(개발/운영 구현 원칙 섹션), `README.md`(하드웨어·VPN).
- 코덱스 프롬프트 `docs/codex/CODEX_REFACTORER_PHASE5_AUTOFIX_2026-06-07.md` 제약줄 → OPS 직접. (PHASE3엔 DEV 언급 없었음.)
- **보존(의도적)**: archive/*·과거 핸드오프·리서치 저널(역사 기록). 머신 아닌 별개 안전규칙 유지 — "OPS **데이터** 직접 수정 금지", "팀 경계(State Bus 경유)", "MODE=dev 데이터 격리".

## 3. 남은 작업 (이 새 채팅에서 — 직전 DC 세션은 도구 부재로 불가)
### #1 메모리 갱신 (Claude 메모리 편집 도구 필요)
- 직전 세션은 Desktop Commander 도구뿐이라 메모리 편집 도구가 없었음.
- 갱신: "DEV 맥북 에어 / 모든 구현 DEV / 개발·운영 분리 불변 원칙 / DEV에서만 구현" → **"OPS 직접 개발 (DEV 은퇴, 2026-06)"**.

### #2 프로젝트 지식 갱신 (view 도구 필요 + 프로젝트 UI)
- `team-jay-strategy.md` 등 프로젝트 지식 파일에 DEV 원칙이 박혀 있음.
- 이 파일들은 **디스크에 없음**(맥 스튜디오 전체 mdfind+find 검색 0건) → 프로젝트에만 존재 → **코덱스로 수정 불가**.
- 처리: 파일 내용 읽고 DEV 부분 **교체 텍스트** 생성 → 마스터가 프로젝트 UI에서 편집/재업로드.
- 교체 기준 문구:
  - DEV(맥북 에어) 은퇴 — 개발·운영 모두 OPS(맥 스튜디오) 단일 머신
  - 코드 변경: OPS 직접 → git commit → deploy.sh 5분 cron 자동 push + CI
  - 3역할 절차 · PROTECTED · crypto LIVE · 스카 매출 무중단 유지

## 4. 무관 (이번 작업 범위 아님)
- 리팩터러 Phase 3(verify-only active) · Phase 5(auto-fix): 구현·검증·커밋 완료.
- active/autofix 실행은 OPS 자율 churn + dirty_worktree 가드로 막혀 있어 "dirty_worktree 가드 스코핑(대상 파일/워크스페이스 범위)" 후속 필요 → 레포 코드라 DC 세션(코드·검증 전용)에서 별도 진행.
