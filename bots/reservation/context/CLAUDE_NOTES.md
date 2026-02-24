# 클로드 → 스카 유지보수 노트

> **작성자:** 클로드 (Claude Code — AI 개발 파트너)
> **대상:** 스카 (Ska — 스터디카페 예약관리봇)
>
> 이 파일은 클로드가 스카 코드를 수정·유지보수할 때마다 업데이트합니다.
> 스카는 부팅 시 이 파일을 읽고 최신 변경 사항과 행동 지침을 반드시 숙지하세요.

---

## 현재 유효한 행동 지침

| 항목 | 지침 |
|------|------|
| 현재 모델 | `google-gemini-cli/gemini-2.5-flash` (2026-02-24 확정, BOOT.md 기준) |
| 모델 자기 인식 | 모델이 뭔지 물어보면 반드시 "gemini-2.5-flash"라고 답할 것 — 다른 버전(3-pro 등)은 잘못된 정보 |
| 알림 발송 시간 | 09:00~22:00만 텔레그램 즉시 발송 |
| 야간 알림 | 발송하지 않음 — `.pickko-alerts.jsonl`에 `sent: false`로 보류 |
| 야간 보류 처리 | 09:00 첫 Heartbeat 시 `flushPendingAlerts()` 자동 일괄 발송 |
| `.pickko-alerts.jsonl` | 이력 + 발송 상태 로그 파일 (pending 큐가 아님) |
| `sent: false` 항목 | "미발송 대기" 정상 상태 — 사장님께 "대기 중" 안내 금지 |
| `.pickko-alerts.jsonl` `resolved` | error 타입만 `false`, 나머지 `true` (자동 관리) |
| 버그 발견 시 | `node src/bug-report.js --new` 로 등록 후 클로드에게 보고 |

---

## 🐛 버그 리포트 & 유지보수 기록 시스템

### 개요
- 저장소: `~/.openclaw/workspace/bug-tracker.json` (버그 + 유지보수 통합)
- CLI: `~/projects/ai-agent-system/bots/reservation/src/bug-report.js`
- **버그/유지보수 변경 시 `HANDOFF.md`의 이슈·유지보수 섹션이 자동 갱신됨**

### 스카가 버그를 발견했을 때

```bash
# 버그 등록 (반드시 --by ska 명시)
node src/bug-report.js --new \
  --title "문제 요약" \
  --desc "구체적인 현상 설명" \
  --severity high \
  --category stability \
  --by ska \
  --files "src/naver-monitor.js"
```

### 버그 상태 확인

```bash
node src/bug-report.js --list              # 미해결 버그
node src/bug-report.js --list --status all # 전체
node src/bug-report.js --show --id BUG-001 # 상세
node src/bug-report.js --maint-list        # 유지보수 이력
```

### 버그 상태 흐름
```
open → (클로드 조치) → in_progress → (수정 완료) → resolved
```

### severity / category 기준

| severity | 기준 |
|----------|------|
| `critical` | 모니터링 전면 중단, 데이터 손실 위험 |
| `high` | 자동화 오작동, 수동 개입 필요 |
| `medium` | 기능 저하, 운영 가능 |
| `low` | 사소한 개선 |

| category | 예시 |
|----------|------|
| `stability` | 재시작, 크래시 |
| `logic` | 중복 처리, 상태 오류 |
| `reliability` | 픽코 등록 실패, 네트워크 |
| `ux` | 알림 내용, 리포트 형식 |
| `data` | JSON 파일 오염, 파싱 오류 |

---

## 변경 이력

### 2026-02-24 — 버그 추적 & 유지보수 기록 시스템 도입

**변경 이유:** 스카가 발견한 버그를 구조화·추적하고, 유지보수 이력을 HANDOFF.md에 자동 반영

**변경 내용:**
- `bug-tracker.json` 신규 생성 (`~/.openclaw/workspace/`) — 버그+유지보수 통합 저장
- `bug-report.js` 신규 생성 (`src/`) — 스카·클로드 공용 CLI
- `HANDOFF.md` — 🐛 이슈 / 🔧 유지보수 마커 섹션 추가 (자동 갱신)
- 오늘 처리한 BUG-001(불안정성), BUG-002(재감지 루프), BUG-003(알림 관리) + MAINT-001~004 초기 등록

### 2026-02-24 — naver-monitor.js 알림 resolved 상태 관리 (BUG-003)

**변경 내용:**
- `sendAlert()` — `resolved`/`resolvedAt` 필드 추가 (`type:error` → `false`, 나머지 → `true`)
- `sendAlert()` — `start` 파라미터 추가 (오류 알림 매칭용)
- `resolveAlertsByBooking(phone, date, start)` 신규 함수 — 픽코 성공/수동처리 시 자동 해결 마킹
- `cleanupOldAlerts()` 개선 — `resolved:false` 7일, `resolved:true` 48h 차등 보존
- `reportUnresolvedAlerts()` 신규 함수 — 시작 시 미해결 알림 텔레그램 발송

### 2026-02-24 — naver-monitor.js 상태 관리 로직 개선 (BUG-002)

**변경 내용:**
- **Fix A**: 루프 시작 시 `completed`/`manual` 건 `seenIds` 사전 마킹 (재감지 루프 방지)
- **Fix B**: `runPickko()` `code 99` (MAX_RETRIES 초과) 시 `seenIds` 마킹 (재감지 차단)
- **Fix**: `confirmedCount` 블록 스코프 오류 수정 → 루프 스코프로 격상 (`let confirmedCount = 0`)

### 2026-02-24 — naver-monitor.js 불안정성 수정 (BUG-001)

**변경 내용:**
- `lastHeartbeatTime = Date.now()` 초기화 (시작 직후 0분 Heartbeat 방지)
- `detachRetryCount` 추가 — detached Frame 3회 재시도 + 페이지 재생성 (즉시 exit 방지)
- `start-ops.sh` Chrome cleanup `sleep 3→5`초 증가

### 2026-02-24 — 취소 감지 1 글리치 방어

**변경 내용:**
- `confirmedCount === 0` 이면 취소 감지 1 스킵 (페이지 로딩 글리치 오취소 방지)

---

### 2026-02-24 — 클로드↔봇 전달 채널 시스템 구축

**변경 이유:** 클로드가 코드를 수정했을 때 봇이 변경 내용을 인지할 수 있는 전용 채널 필요

**변경 내용:**
- `CLAUDE_NOTES.md` 신규 생성 — 클로드가 스카에게 전달하는 전용 파일
- `registry.json` openclaw 파일 목록에 추가 → 배포 시 자동 포함
- BOOT.md 읽기 순서 5번에 `CLAUDE_NOTES.md` 추가
- `deploy-context.js` — `updateSystemStatus()` 추가 (배포 시 클로드 메모리에 시스템 현황 자동 갱신)

---

### 2026-02-24 — sendAlert() 야간 알림 차단

**변경 이유:** 22:00~09:00 사이 텔레그램 알림을 받지 않겠다는 운영 정책 반영

**변경 내용:**
- `sendAlert()` — 09:00~22:00 외에는 텔레그램 발송 차단
  - 야간: `sent: false`로 파일에만 기록
  - 주간: `sent: true`로 즉시 발송 (기존 동일)
- `flushPendingAlerts()` 함수 신규 추가
  - `sent: false` 항목 모아서 요약 메시지 한 번에 발송
  - 발송 후 `sent: true`로 업데이트
- Heartbeat 블록에 오전 flush 트리거 추가
  - 09:00 이후 첫 Heartbeat 시 자동 실행 (당일 1회)

---

## 클로드 작성 규칙 (참고)

- 행동 지침 테이블은 "현재 유효한 것"만 유지 (오래된 것은 삭제)
- 변경 이력은 최신 순 (날짜 역순) 으로 기록
- 스카가 오해하기 쉬운 파일/변수/동작은 반드시 여기에 명시
