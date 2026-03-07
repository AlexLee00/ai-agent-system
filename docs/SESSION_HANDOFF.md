# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 이번 세션 완료 내역 (2026-03-08)

### 1. Phase 1 — 루나팀 전환 판단 + LLM 졸업 실전 + 덱스터 팀장봇 연동 (`fbccb1e`, `83b50ea`)

#### 루나팀 Shadow → Confirmation 전환 판단
- `packages/core/lib/shadow-mode.js`: `getTeamMode`/`setTeamMode` 추가 (`team_modes` 테이블, 1분 캐시)
- `scripts/luna-transition-analysis.js` 신규 (30/7/3일 일치율 + 14일 불일치 분석)
- `router.js`: `/luna_confirm`, `/luna_shadow`, `/luna_analysis` 케이스 추가
- **현재 루나 7일 일치율: 96.3% (107건) → READY 상태**

#### LLM 졸업 실전 적용
- `scripts/run-graduation-analysis.js` 신규 (3팀 탐색 + 승인 가이드)
- `weekly-stability-report.js`: `weeklyValidation` 연동 (복귀 항목 알림)
- `router.js`: `/graduation_scan`, `/graduate_start <id>`, `/graduate_approve <id>` 추가
- **현재 졸업 후보: claude-lead `system_issue_triage/monitor` 100% (n=11)**

#### 덱스터 팀장봇 agent_events 이중 경로 Phase 1
- `reporter.js`: `emitDexterEvent` (dexter → claude-lead event bus, 텔레그램 폴백 유지)
- `claude-lead-brain.js`: `processAgentEvent` + `pollAgentEvents` 추가 (payload TEXT 파싱 포함)
- `dexter.js`: `emitDexterEvent` → `evaluateWithClaudeLead` → `pollAgentEvents` 순서 연결

### 2. 버그 수정 2건 (`392d1db`)
- `backup-db.js`: pg_dump 절대경로 (`/opt/homebrew/opt/postgresql@17/bin/pg_dump`) — launchd PATH 미포함
- `pickko-daily-audit.js`: `manualCount` TDZ 버그 수정 (const 선언 블록 순서 교정)

### 3. 진단 2건
- **스카팀 매출 데이터 없음**: 일회성 마이그레이션 타이밍 이슈 (ETL 00:30 이후 정상화), `confirmed=0` 3일치(03-05~07) 마스터 확인 필요
- **포캐스트 학습데이터 0일**: 마이그레이션 직후 빈 테이블 → ETL 실행 후 90일 데이터 정상화

---

## 다음 세션에서 할 것

### 우선순위 1: 루나팀 Confirmation 전환 (READY)
```
루나 7일 일치율 96.3% → READY 기준(90%) 초과
1. /luna_confirm 으로 confirmation 모드 전환 승인
2. 전환 후 모니터링 (불일치 발생 시 /luna_shadow 복귀)
```

### 우선순위 2: claude-lead 졸업 승인
```
system_issue_triage/monitor 100% (n=11) — 후보 등록됨
1. /graduation_scan → id 확인
2. /graduate_start <id> → 2주 검증 시작
3. 2주 후 /graduate_approve <id> → 최종 승인
```

### 우선순위 3: 덱스터 팀장봇 연동 Phase 2
```
- reporter.js: CRITICAL 이중 경로 (escalate 시 텔레그램 + agent_events 동시 발행)
- claude-lead-brain.js: createTask 연동 (독터에게 복구 작업 지시)
- dexter.js: pollAgentEvents 결과 기반 동작 확장
```

### 우선순위 4: unrecognized_intents 데이터 검토
- `/unrec` 명령으로 조회, `/promote` 로 즉시 승격 가능

---

## 현재 시스템 상태 (2026-03-08 기준)

| 팀 | 상태 | 모드 | 비고 |
|----|------|------|------|
| 스카팀 | ✅ OPS | 예약관리 정상 | 앤디·지미 실행 중 |
| 루나팀 크립토 | ✅ OPS | shadow (일치율 96.3%) | READY — 전환 가능 |
| 루나팀 국내/해외 | ✅ DEV | PAPER_MODE=true | 모의투자 |
| 클로드팀 덱스터 | ✅ OPS | 5분+1시간 주기 | ❌ 0건 정상 |
| 제이 OpenClaw | ✅ OPS | 포트 18789 | 423MB (임계 500MB 이하) |
| 제이 오케스트레이터 | ✅ OPS | PID 769 | long-polling 활성 |

## 알려진 이슈
- KI-001~004: KNOWN_ISSUES.md 참조
- `agents.teamLeads` 키가 openclaw.json에서 제거됨 → 다음 업데이트 시 재삽입 금지
- `daily_summary confirmed=0` 3일치(03-05~07) — 마스터 확인 필요 (`/confirm 날짜`)

## 커밋 이력 (이번 세션)
```
efa71c9  chore: 덱스터 체크섬 갱신 + 버그레포트 기록
83b50ea  fix: processAgentEvent payload TEXT 파싱 버그 + 체크섬 갱신
fbccb1e  feat: Phase 1 — 루나팀 전환 판단 + LLM 졸업 실전 + 덱스터 팀장봇 연동
392d1db  fix: backup-db pg_dump 절대경로 + pickko-daily-audit manualCount TDZ 버그
```

## 주의사항
- tmux 세션명: `ska`
- Gemini API: 스카팀 전용 (루나팀 사용 불가)
- OPS 전환은 반드시 마스터 확인 후
- `insertReview(tradeId, review)` — tradeId 첫 번째 인자
- `agent_events.payload` 컬럼은 TEXT → 반드시 `JSON.parse()` 필요
