# 7_AGENTS_OVERVIEW — 클로드팀 8 에이전트 개요

> 최종 업데이트: 2026-04-24
> Phase A/N/D/C/T/I 완료 후 최종 상태

---

## 에이전트 맵

```
claude-commander (팀장)
├── [감지] Dexter
├── [인텔] Archer
├── [복구] Doctor ← Verify Loop
├── [리뷰] Reviewer ← Phase A
├── [보안] Guardian ← Phase A
├── [빌드] Builder  ← Phase A
├── [알림] Codex Plan Notifier ← Phase N ★
└── [자동개발] Auto Dev Orchestrator ← Phase AD ★
```

---

## 1. Dexter (감지)

**파일**: `src/dexter.ts`  
**launchd**: `ai.claude.dexter.plist`, `ai.claude.dexter.quick.plist`, `ai.claude.dexter.daily.plist`  
**주기**: 1분(퀵) / 1시간(풀) / 매일(데일리)

### 22개 체크 모듈

| 모듈 | 설명 |
|------|------|
| code | 코드 품질 |
| database | DB 연결/쿼리 |
| security | 보안 설정 |
| logs | 로그 분석 |
| errorLogs | 에러 로그 |
| bots | 봇 상태 |
| resources | 시스템 리소스 |
| network | 네트워크 연결 |
| ska | 스카팀 상태 |
| heartbeat | 하트비트 |
| hub | Hub(:7788) |
| healthState | 전체 헬스 |
| deps | 의존성 |
| patterns | 코드 패턴 |
| selfDiagnosis | 자기 진단 |
| teamLeads | 팀장 봇 상태 |
| openclaw | OpenClaw 게이트웨이 |
| llmCost | LLM 비용 추적 |
| billing | 청구 현황 |
| workspaceGit | Git 상태 |
| n8n | n8n 워크플로우 |
| botBehavior | 봇 행동 패턴 |

### 이중 모드

- **정상**: 덱스터 → agent_tasks → Doctor (팀장 경유)
- **Emergency**: 덱스터 → Doctor 직접 (3분+ 다운 시)

---

## 2. Archer (인텔리전스)

**파일**: `src/archer.ts`  
**launchd**: `ai.claude.archer.plist`  
**주기**: 매일 1회

- AI/LLM 기술 트렌드 수집
- docs/auto_dev PATCH_REQUEST 오케스트레이터
- 팀 업그레이드 제안 → State Bus

---

## 3. Doctor (복구)

**파일**: `lib/doctor.ts` (929줄)  
**launchd**: `ai.claude.commander.plist` 내 통합

### 복구 레벨

| 레벨 | 설명 | 예시 |
|------|------|------|
| L1 | 서비스 재시작 | launchd restart |
| L2 | 설정 수정 | lock file 제거, git stash |
| L3 | 코드 패치 | npm audit fix, 의존성 업데이트 |

### Verify Loop (Phase D)

```
복구 시도 → verifyRecovery
실패 시 최대 3회 재시도 (5s → 15s → 45s 백오프)
3회 실패 → Telegram 긴급 알림 + DB 기록
```

**검증 케이스**: `restart_launchd_service`, `git_stash`, `clear_lock_file`, `clear_expired_cache`

**DB**: `claude_doctor_recovery_log` (action/params/attempts/success/verified)

---

## 4. Reviewer (코드 리뷰)

**파일**: `src/reviewer.ts` (304줄)  
**launchd**: `ai.claude.reviewer.plist`  
**Kill Switch**: `CLAUDE_REVIEWER_ENABLED=true`

### 기능

| 함수 | 설명 |
|------|------|
| `analyzeChanges` | git diff 변경 파일 + 통계 |
| `testCoverageDelta` | before/after 테스트 비교 |
| `runReview` | 종합 리뷰 실행 (Kill Switch 체크) |
| `reportToTelegram` | 결과 Telegram 발송 |

### 리뷰 항목

1. 변경 파일 목록 + diff 분석
2. TypeScript strict 위반 (tsc --noEmit)
3. 코드 패턴 체크 (skills.codeReview)
4. 테스트 커버리지 변화

---

## 5. Guardian (보안)

**파일**: `src/guardian.ts` (356줄)  
**launchd**: `ai.claude.guardian.plist`  
**Kill Switch**: `CLAUDE_GUARDIAN_ENABLED=true`

### 6계층 보안

| 레이어 | 설명 |
|--------|------|
| Layer 1 | `.gitignore` 완전성 (secrets.json/.env/*.pem) |
| Layer 2 | 커밋된 시크릿 스캔 (git log 패턴) |
| Layer 3 | 의심 패키지 (xmrig/coinhive 등) |
| Layer 4 | 의존성 취약점 (npm audit) |
| Layer 5 | 파일 권한 (chmod 777/666) |
| Layer 6 | 외부 네트워크 의심 도메인 |

---

## 6. Builder (빌드)

**파일**: `src/builder.ts` (325줄)  
**launchd**: `ai.claude.builder.plist`  
**Kill Switch**: `CLAUDE_BUILDER_ENABLED=true`

### 빌드 대상

| 플랜 ID | 대상 | 빌드 방법 |
|---------|------|-----------|
| worker-web | bots/worker/web/ | Next.js (npm run build) |
| packages-core | packages/core/ | TypeScript (tsc) |
| elixir-team-jay | elixir/team_jay/ | mix compile |
| elixir-investment | bots/investment/elixir/ | mix compile |
| elixir-darwin | bots/darwin/elixir/ | mix compile |
| elixir-sigma | bots/sigma/elixir/ | mix compile |

---

## 7. Codex Plan Notifier (알림) ★

**파일**: `lib/codex-plan-notifier.ts`
**launchd**: `ai.claude.codex-notifier.plist`  
**Kill Switch**: `CLAUDE_CODEX_NOTIFIER_ENABLED=true`

**자세한 내용**: [CODEX_NOTIFIER_GUIDE.md](CODEX_NOTIFIER_GUIDE.md)

---

## 8. Auto Dev Orchestrator (자동개발) ★

**파일**: `lib/auto-dev-pipeline.ts`
**실행기**: `scripts/auto-dev-runner.ts`
**launchd**: `ai.claude.auto-dev.plist`
**Kill Switch**: `CLAUDE_AUTO_DEV_PROFILE=shadow` (기본값 — enabled=false)

### 역할 경계 (불변)

- **전략/설계 채팅** (Meti/Claude Opus): 구현 요청 MD(`docs/auto_dev/*.md`)를 작성하고 inbox에 투입. **코드 직접 수정 절대 금지.**
- **코드작업 채팅** (Codex/Claude Code): `docs/auto_dev/*.md`를 읽고 구현·테스트·커밋. 이 채팅에서만 실제 파일 변경이 일어난다.

### 운영 프로필

| 프로필 | enabled | shadow | execute | 용도 |
|--------|---------|--------|---------|------|
| `shadow` | false | true | false | 기본값 — Kill Switch OFF |
| `supervised_l4` | true | true | false | 드라이런 감시 모드 |
| `autonomous_l5` | true | false | true | 완전 자율 실행 |

프로필 전환: `launchctl setenv CLAUDE_AUTO_DEV_PROFILE supervised_l4`

### 라이프사이클

```
docs/auto_dev/*.md
  → 문서/코드 분석 (content hash로 중복 방지)
  → 구현계획 수립 + 시작 알림
  → Claude Code 구현 (worktree status snapshot)
  → Reviewer + Guardian
  → 실패 시 revise_after_review (1회)
  → Builder + hard tests
  → 실패 시 revise_after_test (1회)
  → 구현 완료 + 종료 알림
```

상태 파일: `~/.openclaw/workspace/claude-auto-dev-state.json`

---

## launchd 서비스 현황 (총 15개)

| 서비스 | 주기 | 상태 |
|--------|------|------|
| ai.claude.commander | 상주 | 운영 중 |
| ai.claude.dexter | 1시간 | 운영 중 |
| ai.claude.dexter.quick | 5분 | 운영 중 |
| ai.claude.dexter.daily | 매일 | 운영 중 |
| ai.claude.archer | 매일 | 운영 중 |
| ai.claude.health-check | 5분 | 운영 중 |
| ai.claude.health-dashboard | 상주 | 운영 중 |
| ai.claude.speed-test | 매일 | 운영 중 |
| ai.claude.reviewer | 30분 | Phase A 신설 |
| ai.claude.guardian | 매일 03:00 | Phase A 신설 |
| ai.claude.builder | 이벤트 기반 | Phase A 신설 |
| ai.claude.codex-notifier | 상주 (5분 주기) | Phase N 신설 ★ |
| ai.claude.auto-dev | 상주 (5분 주기) | Phase AD 신설 ★ |
| ai.claude.daily-report | 매일 06:30 | Phase T 신설 |
| ai.claude.weekly-report | 매주 일요일 19:00 | Phase T 신설 |

---

## 테스트 현황 (67개, 100% 통과)

| 파일 | 테스트 수 |
|------|-----------|
| reviewer.test.ts | 7 |
| guardian.test.ts | 6 |
| builder.test.ts | 7 |
| codex-plan-notifier.test.ts | 16 |
| auto-dev-pipeline.test.ts | 4 |
| doctor-verify-loop.test.ts | 12 |
| commander.test.ts | 11 |
| e2e/full-flow.test.ts | 4 |
| **합계** | **67** |

```bash
# 전체 테스트 실행
node bots/claude/__tests__/reviewer.test.ts
node bots/claude/__tests__/guardian.test.ts
node bots/claude/__tests__/builder.test.ts
node bots/claude/__tests__/codex-plan-notifier.test.ts
node bots/claude/__tests__/auto-dev-pipeline.test.ts
node bots/claude/__tests__/doctor-verify-loop.test.ts
node bots/claude/__tests__/commander.test.ts
node bots/claude/__tests__/e2e/full-flow.test.ts
```
