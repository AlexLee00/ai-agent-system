# CLAUDE_EVOLUTION_ARCHITECTURE — 클로드팀 완전자율 운영 아키텍처

> 최종 업데이트: 2026-04-24 (auto_dev 인박스 반영)
> 담당: 코덱스 (Claude Code)
> 상위 문서: docs/auto_dev/CODEX_CLAUDE_EVOLUTION.md

---

## 1. 전체 구조

```
┌──────────────────────────────────────────────────────┐
│               Claude Team (통합 지휘관)                │
│                                                      │
│  claude-commander.ts   ←── bot_commands 폴링 (30초)  │
│       │                                              │
│       ├─ 19 핸들러 디스패처                            │
│       │   기존: run_check/run_full/run_fix/           │
│       │         daily_report/run_archer/ask_claude/  │
│       │         analyze_unknown/session_close/       │
│       │         codex_approve/codex_reject           │
│       │   신규: run_review/run_guardian/run_builder/ │
│       │         run_full_quality/test_codex_notifier/│
│       │         show_codex_status/run_auto_dev/      │
│       │         show_auto_dev_status/run_doctor_verify│
│       │                                              │
│  ─────┴──────────────────────────────────────────   │
│                                                      │
│  [감지] Dexter — 22개 체크 모듈 + Emergency 모드      │
│  [인텔] Archer — AI/LLM 트렌드 + auto_dev PATCH_REQUEST │
│  [복구] Doctor — L1/L2/L3 + Verify Loop (3회 재시도) │
│  [리뷰] Reviewer — 코드 리뷰 자동화 (6개 함수)        │
│  [보안] Guardian — 6계층 보안 풀스캔                  │
│  [빌드] Builder — TS+Elixir+Next.js 멀티 빌드        │
│  [알림] Codex Plan Notifier — 구현 계획 브로드캐스터  │
│  [자동개발] Auto Dev — docs/auto_dev 구현 상태머신     │
│                                                      │
│  ─────────────────────────────────────────────────  │
│                                                      │
│  Output:                                             │
│  - Telegram 5채널 (urgent/hourly/daily/weekly/meta)  │
│  - Health Dashboard (:PORT)                          │
│  - claude_doctor_recovery_log (PostgreSQL)           │
│  - Elixir Codex Pipeline (team_jay)                  │
└──────────────────────────────────────────────────────┘
```

---

## 2. 에이전트별 파일 구조

```
bots/claude/
├── src/
│   ├── claude-commander.ts    # 19 핸들러 디스패처
│   ├── dexter.ts              # 22개 체크 모듈 (441줄)
│   ├── archer.ts              # AI/LLM 트렌드 분석
│   ├── reviewer.ts            # 코드 리뷰 자동화 (304줄)
│   ├── guardian.ts            # 6계층 보안 (356줄)
│   └── builder.ts             # 멀티 빌드 (325줄)
├── lib/
│   ├── doctor.ts              # L1/L2/L3 + Verify Loop (929줄)
│   ├── codex-plan-notifier.ts # 구현 계획 알림 ★
│   ├── auto-dev-pipeline.ts   # auto_dev 자동 구현 상태머신 ★
│   ├── telegram-reporter.ts   # 5채널 리포터 (437줄)
│   ├── daily-report.ts        # 일일 보고 (기존)
│   └── config.ts              # 설정
├── scripts/
│   ├── claude-daily-report.ts   # 일일 리포트 실행 (Phase T)
│   ├── claude-weekly-review.ts  # 주간 리뷰 실행 (Phase T)
│   ├── codex-notifier-runner.ts # 코덱스 알림 실행 (Phase N)
│   └── auto-dev-runner.ts       # 자동 구현 실행 (Phase AD)
├── launchd/
│   ├── ai.claude.commander.plist
│   ├── ai.claude.dexter.plist
│   ├── ai.claude.reviewer.plist    # Phase A 신설
│   ├── ai.claude.guardian.plist    # Phase A 신설
│   ├── ai.claude.builder.plist     # Phase A 신설
│   ├── ai.claude.codex-notifier.plist # Phase N 신설 ★
│   ├── ai.claude.auto-dev.plist       # Phase AD 신설 ★
│   ├── ai.claude.daily-report.plist   # Phase T 신설
│   └── ai.claude.weekly-report.plist  # Phase T 신설
├── migrations/
│   └── 004_claude_doctor_recovery_log.sql  # Phase D
├── __tests__/
│   ├── reviewer.test.ts          # 7 테스트
│   ├── guardian.test.ts          # 6 테스트
│   ├── builder.test.ts           # 7 테스트
│   ├── codex-plan-notifier.test.ts # 16 테스트
│   ├── auto-dev-pipeline.test.ts   # 4 테스트
│   ├── doctor-verify-loop.test.ts  # 12 테스트
│   ├── commander.test.ts           # 11 테스트
│   └── e2e/full-flow.test.ts       # 4 시나리오
└── docs/
    ├── CLAUDE_EVOLUTION_ARCHITECTURE.md (이 파일)
    ├── CODEX_NOTIFIER_GUIDE.md
    └── 7_AGENTS_OVERVIEW.md
```

---

## 3. 이중 모드 시스템 (Dexter)

```
정상 모드:
  Dexter → agent_tasks → Doctor (팀장 경유)

Emergency 모드 (자동 전환 조건):
  - Hub control/alarm gateway 3분+ 다운
  - 스카야 텔레그램 봇 3분+ 다운

Emergency 모드:
  Dexter → Doctor 직접 호출 (팀장 무응답 바이패스)
```

---

## 4. Verify Loop 패턴 (Doctor)

```
execute(taskType, params)
  │
  ├─ [시도 1] 복구 실행 → verifyRecovery
  │   ├─ OK → return { success: true, attempts: 1, verified: true }
  │   └─ FAIL → 5초 대기 후 재시도
  │
  ├─ [시도 2] 복구 실행 → verifyRecovery
  │   ├─ OK → return { success: true, attempts: 2, verified: true }
  │   └─ FAIL → 15초 대기 후 재시도
  │
  └─ [시도 3] 복구 실행 → verifyRecovery
      ├─ OK → return { success: true, attempts: 3, verified: true }
      └─ FAIL → postAlarm(긴급) + _logVerifyLoop(fail) + return { verified: false }
```

---

## 5. Kill Switch 목록 (전체)

| 환경변수 | 기본값 | 설명 |
|---------|--------|------|
| CLAUDE_REVIEWER_ENABLED | false | 코드 리뷰 자동화 |
| CLAUDE_GUARDIAN_ENABLED | false | 6계층 보안 스캔 |
| CLAUDE_BUILDER_ENABLED | false | 빌드/배포 자동화 |
| CLAUDE_CODEX_NOTIFIER_ENABLED | false | 코덱스 구현 알림 ★ |
| CLAUDE_AUTO_DEV_ENABLED | false | auto_dev 자동 구현 상태머신 ★ |
| CLAUDE_AUTO_DEV_SHADOW | true | auto_dev 알림 Shadow 모드 |
| CLAUDE_AUTO_DEV_EXECUTE_IMPLEMENTATION | false | Claude Code 실제 구현 호출 |
| CLAUDE_AUTO_DEV_RUN_HARD_TESTS | false | 운영 승격 전에는 하드 테스트 비활성 (승격 후 true 권장) |
| CLAUDE_AUTO_DEV_STATE_FILE | 기본 상태 파일 | 테스트/스모크용 상태 파일 오버라이드 |
| CLAUDE_TELEGRAM_ENHANCED | false | 5채널 Telegram |
| CLAUDE_NOTIFIER_SHADOW | true | 알림 Shadow 모드 |
| CLAUDE_LLM_DAILY_BUDGET_USD | 10 | LLM 일일 비용 상한 |

---

## 6. 데이터 흐름

```
[Dexter 체크] → [Doctor 복구] → [claude_doctor_recovery_log]
                                         ↓
                              [telegram-reporter onDailyReport]
                                         ↓
                              [claude-daily-report.ts 06:30 KST]

[전략/설계 채팅(Meti)] → docs/auto_dev/*.md 생성 (코드 직접 수정 금지)
[코드작업 채팅(Codex)] → 구현/테스트/커밋 (docs/auto_dev/*.md 참조)

[docs/auto_dev 문서 투입] → [auto-dev-pipeline]
  → [문서/코드 분석 + content hash 중복 방지]
  → [구현계획 시작 알림]
  → [Claude Code 구현 (worktree status snapshot)]
  → [Reviewer + Guardian]
  → [revise_after_review (실패 시 1회)]
  → [Builder + hard tests]
  → [revise_after_test (실패 시 1회)]
  → [완료 알림]

[Codex 직접 실행] → [codex-plan-notifier] → [Telegram: 계획/진행/완료 알림]

[Commander 명령] → [run_review] → [Reviewer] → [Guardian] → [Builder]
                                   (reviewer.ts)  (guardian.ts) (builder.ts)
```

---

## 7. 불변 원칙

1. **TS/JS 생태계 유지**: Elixir 전환 금지
2. **Dexter 22체크 보존**: 삭제/변경 금지, 추가만 허용
3. **이중 모드 유지**: 정상/Emergency 전환 로직 불변
4. **Doctor BLACKLIST 엄수**: 기존 블랙리스트 그대로
5. **Codex Pipeline 호환**: team_jay FeedbackLoop 연동 유지
6. **알림 스팸 방지**: dedup 1분 + rate 20건/시간
7. **Kill Switch 기본 OFF**: 모든 신규 에이전트 기본 비활성
8. **launchd 무중단**: 기존 plist 전부 유지 가동, 신규 서비스는 별도 라벨로 추가
