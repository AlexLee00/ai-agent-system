# CODEX_NOTIFIER_GUIDE — 코덱스 구현 계획 알림 시스템 가이드

> 마스터 핵심 요구: "구현할 때 구현계획에 대한 알람이라도 주면 좋겠는데!!"

---

## 개요

코덱스(Claude Code)가 자율 실행될 때 **마스터가 터미널 없이** 진행 상황을 파악할 수 있도록  
Telegram 알림을 자동 전송하는 시스템.

`docs/auto_dev/*.md` 신규 문서의 실제 자동 구현은 `Auto Dev Orchestrator`가 담당한다. 이 알림기는 사람이 직접 실행한 Claude/Codex 프로세스의 계획/진행/완료 브로드캐스트를 계속 맡는다.

```
마스터 → 코덱스 프롬프트 복붙
         ↓
Codex Watcher 자동 감지 (5분 주기)
         ↓
[시작] 📋 "Phase A 시작, 2~3일 예상"
         ↓
[진행] ⏳ "50% 완료, 최신 커밋 abc1234"
         ↓
[완료] ✅ "Phase A 완료 (7개 테스트, 0 failures)"
```

---

## 파일 위치

| 파일 | 역할 |
|------|------|
| `bots/claude/lib/codex-plan-notifier.ts` | 핵심 로직 |
| `bots/claude/scripts/codex-notifier-runner.ts` | launchd 실행 진입점 |
| `bots/claude/launchd/ai.claude.codex-notifier.plist` | launchd 데몬 설정 |
| `bots/claude/lib/auto-dev-pipeline.ts` | `docs/auto_dev` 자동 구현 상태머신 |
| `bots/claude/launchd/ai.claude.auto-dev.plist` | auto_dev 인박스 상주 감시 |

---

## 활성화 방법

```bash
# 1. Kill Switch ON
launchctl setenv CLAUDE_CODEX_NOTIFIER_ENABLED true

# 2. Shadow 모드 해제 (실제 발송)
launchctl setenv CLAUDE_NOTIFIER_SHADOW false

# 3. 서비스 재시작
launchctl unload ~/Library/LaunchAgents/ai.claude.codex-notifier.plist
launchctl load ~/Library/LaunchAgents/ai.claude.codex-notifier.plist
```

---

## 동작 흐름

### 1. 프로세스 감지

```
ps aux | grep -E 'claude.*CODEX|claude.*--print'
```

- `claude` CLI 프로세스 + `CODEX_*_EVOLUTION` 키워드 감지
- PID + 시작 시각 추출

### 2. Phase 파싱

프롬프트 파일(`docs/auto_dev/CODEX_*.md`)만 읽어:

```regex
## 📋 Phase ([A-Z0-9]+) \(([^)]+)\) — (\S+)
```

패턴으로 Phase 목록 + 예상 소요 + 파일 목록 추출.

### 3. 알림 이벤트

| 이벤트 | 조건 | 메시지 |
|--------|------|--------|
| 시작 | 새 PID 감지 | 📋 Phase X 시작 + 계획 상세 |
| 진행 | 커밋 변화 감지 | ⏳ X% 완료 + 최신 커밋 |
| Phase 전환 | git tag `pre-phase-*` | 📋 다음 Phase 시작 |
| Phase 완료 | 커밋 메시지 `Phase X 완료` | ✅ 완료 + 테스트 결과 |
| 정체 | 30분 이상 커밋 없음 | ⚠️ 정체 감지 + 수동 개입 요청 |
| 종료 | PID 사라짐 | 🏁 프로세스 종료 |

### 4. 중복 알림 방지

- Dedup 윈도우: 1분 (동일 메시지 재발송 차단)
- Rate Limit: 20건/시간
- 상태 파일: Claude runtime notifier state store

---

## 알림 포맷 예시

### 시작 알림

```
📋 코덱스 A Phase 시작

🎯 Agents — 3개 스켈레톤 완전 구현
⏰ 예상 소요: 2~3일
🧬 대장정: docs/auto_dev/CODEX_CLAUDE_EVOLUTION.md

📁 예상 변경 파일:
  • bots/claude/src/reviewer.ts
  • bots/claude/src/guardian.ts
  • bots/claude/src/builder.ts

🔐 Kill Switch:
  • CLAUDE_REVIEWER_ENABLED (기본 OFF)

🔄 롤백 포인트: pre-phase-a-claude-evolution
PID: 12345
시작: 2026-04-18T01:00:00.000Z
```

### 완료 알림

```
✅ 코덱스 A Phase 완료

🎯 Agents — 3개 스켈레톤 완전 구현
⏰ 소요 시간: 2시간 30분

📊 최종 상태:
- 테스트: 20개, 0 failures
- 최신 커밋: abc1234

🔄 다음 Phase: Notifier — 구현 계획 알림 시스템
```

---

## 수동 테스트

```bash
# Commander로 수동 실행 (Telegram 채널에 메시지 전송)
# bot_commands 테이블에 삽입:
# { "command": "test_codex_notifier", "args": {} }

# 또는 직접 실행 (Shadow 모드 = 로그만):
CLAUDE_CODEX_NOTIFIER_ENABLED=true \
CLAUDE_NOTIFIER_SHADOW=true \
node bots/claude/scripts/codex-notifier-runner.ts
```

---

## Shadow 모드 3일 검증 절차

1. `CLAUDE_NOTIFIER_SHADOW=true`로 시작 (기본값)
2. 3일간 로그 확인: `/tmp/claude-codex-notifier.log`
3. 오탐/오발 없으면 → `CLAUDE_NOTIFIER_SHADOW=false` 전환
4. 마스터 승인 후 실제 발송 활성화

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 알림 안 옴 | Kill Switch OFF | `CLAUDE_CODEX_NOTIFIER_ENABLED=true` |
| Shadow 로그만 나옴 | SHADOW=true | `CLAUDE_NOTIFIER_SHADOW=false` |
| 프로세스 감지 안 됨 | 명령줄 패턴 불일치 | `ps aux`로 프로세스 형태 확인 후 감지 정규식 조정 |
| 중복 알림 | dedup 오동작 | Claude runtime notifier state 초기화 |
| 서비스 시작 안 됨 | Kill Switch OFF 상태 | 서비스는 자동 재실행 (KeepAlive=true), 30초 대기 후 종료 |
| auto_dev 문서가 구현되지 않음 | Auto Dev Kill Switch OFF | `CLAUDE_AUTO_DEV_ENABLED=true` 및 `ai.claude.auto-dev` 상태 확인 |
