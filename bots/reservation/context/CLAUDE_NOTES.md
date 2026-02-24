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

## 🆕 자연어 예약 등록 / 회원 가입 명령

사장님이 텔레그램으로 예약 등록 또는 회원 가입을 요청하면 스카가 직접 처리한다.

### 예약 등록

| 항목 | 내용 |
|------|------|
| 명령 | `node ~/projects/ai-agent-system/bots/reservation/src/pickko-register.js --date=YYYY-MM-DD --start=HH:MM --end=HH:MM --room=A1\|A2\|B --phone=01000000000 --name=이름` |
| stdout 파싱 | JSON `{ success, message }` |
| 성공 | `success: true` → 텔레그램에 완료 보고 |
| 실패 | `success: false` → 텔레그램에 실패 사유 보고, 사장님 수동 확인 요청 |

### 회원 가입

| 항목 | 내용 |
|------|------|
| 명령 | `node ~/projects/ai-agent-system/bots/reservation/src/pickko-member.js --phone=01000000000 --name=이름` |
| stdout 파싱 | JSON `{ success, isNew, message }` |
| 기존 회원 | `isNew: false` → "기존 회원입니다" 안내 |
| 신규 등록 | `isNew: true` → 텔레그램에 등록 완료 보고 |

### 자연어 → 인자 파싱 규칙

| 입력 | 변환 |
|------|------|
| 오늘, 내일 | YYYY-MM-DD (KST 기준) |
| M월D일 | 해당 월일의 YYYY-MM-DD |
| 오전N시, 오후N시 | HH:MM (24시간, 예: 오후3시 → 15:00) |
| 오전N시M분, 오후N시M분 | HH:MM |
| A룸, A1, B룸 | A1 \| A2 \| B |
| 전화번호 010-XXXX-XXXX | 하이픈 제거 후 그대로 |

### 실행 예시

```
사장님: "3월 5일 오후 3시~5시 A1 010-1234-5678 홍길동 예약해줘"
→ node .../pickko-register.js --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --phone=01012345678 --name=홍길동

사장님: "010-1234-5678 홍길동 회원가입해줘"
→ node .../pickko-member.js --phone=01012345678 --name=홍길동
```

> **주의**: 스크립트 경로는 `~/projects/ai-agent-system/bots/reservation/src/` 기준
> stdout에서 JSON 파싱 후 성공/실패 여부를 사장님께 텔레그램으로 보고할 것

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

### 2026-02-25 — 스카봇 안정화 업데이트 8건

**변경 이유:** 운영 중 발견된 데이터 손실·중복등록·주기 밀림 위험 방어

**변경 내용:**

| # | 파일 | 내용 |
|---|------|------|
| C-1 | `lib/files.js`, `naver-monitor.js saveSeen()` | atomic write (tmp→rename) — 쓰기 도중 프로세스 종료 시 파일 손상 방지 |
| C-2 | `pickko-verify.js markCompleted()` | `name` 필드 누락 수정 — verified 처리 후 이름이 사라지는 버그 수정 |
| C-3 | `pickko-accurate.js` | 시간 슬롯 선택 1회→3회 재시도 — AJAX 갱신 타이밍 미스 대응 |
| H-1 | `naver-monitor.js` | `rollbackProcessingEntries()` 추가 — `process.exit(1)` 4곳 전에 `processing` 항목을 `failed`로 롤백 |
| H-2 | `start-ops.sh` | 로그 파일 관리 추가 — `/tmp/naver-ops-mode.log` 리다이렉션 + 1000줄 로테이션 |
| H-3 | `naver-monitor.js` | `pruneSeenIds()` 추가 — `slice(-500)` 대신 90일 지난 예약 ID 날짜 기준 정리 |
| H-4 | `pickko-register.js` | 등록 성공 후 `naver-seen.json`에 `manual` 항목 기록 — `pickko-daily-audit` 오탐 방지 |
| M-1 | `naver-monitor.js` | `cycleStart` 기반 사이클 타임 관리 — 사이클 소요시간 차감 후 sleep (주기 밀림 방지) |
| M-2 | `ai.ska.pickko-daily-audit.plist` | 22:00 단독 → 22:00 + 23:50 이중 실행 (22~23시 접수 예약 누락 방지) |

**스카 행동 변경 없음** — 내부 안정성 강화, 외부 인터페이스 동일

---

### 2026-02-25 — pickko-verify.js needsVerify() 개선

**변경 이유:** `completed`이지만 `pickkoStatus`가 `paid`/`auto`인 항목을 verified로 올리려면 임시로 `status: 'pending'`으로 바꿔야 했음 → 위험한 우회 방식 제거

**변경 내용:**
- `needsVerify(entry)` 함수 추가
  - `pending` / `failed` → 항상 검증 대상 (기존 동일)
  - `completed` + `pickkoStatus`가 `verified`·`manual`이 **아닌** 것(paid, auto 등) → 검증 대상 (신규)
- 이제 `pickko-register.js`로 등록한 예약(status=completed, pickkoStatus=manual)은 pickko-verify 재검증 대상에서 제외됨

---

### 2026-02-25 — naver-seen.json entry object loss 버그 방어

**변경 이유:** `updateBookingState('completed')` 저장(N건) 직후 `loadSeen()`이 N-1건을 읽는 타이밍 버그 발생 → 방금 등록한 entry 객체가 사라지는 현상

**변경 내용:**
- `_lastSeenDataSnapshot` 모듈 변수 추가
- `updateBookingState()` — `saveSeen()` 직후 스냅샷 저장
- OPS/DEV 코드=0 완료 블록 — `loadSeen()` 대신 스냅샷 우선 사용 후 null 초기화

**한송이 3건 백필** (2026-03-09, 03-23, 03-30 A1룸) — 버그로 유실된 entry 수동 복원 + pickko-verify로 verified 확인 완료

---

### 2026-02-24 — 픽코 3가지 기능 신규 추가

**변경 이유:** 수동 관리가 필요했던 감사/예약등록/회원가입 자동화

**변경 내용:**
- `pickko-daily-audit.js` 신규 — 당일 픽코 등록 예약 사후 감사 (매일 22:00, launchd)
  - 픽코 study/index.html 접수일시 최신순 조회 → 오늘 등록 항목 수집
  - naver-seen.json auto 항목과 비교 → 전화/수동 예약 탐지 → 텔레그램 리포트
  - `run-audit.sh`, `ai.ska.pickko-daily-audit.plist` 함께 생성
- `pickko-register.js` 신규 — 자연어 예약 등록 CLI 래퍼
  - pickko-accurate.js 위임 실행, stdout JSON `{ success, message }` 출력
  - 스카가 자연어 파싱 후 shell 명령으로 호출
- `pickko-member.js` 신규 — 신규 회원 가입 CLI 래퍼
  - 회원 존재 여부 확인 → 기존 회원 안내 OR 신규 등록
  - stdout JSON `{ success, isNew, message }` 출력
- `CLAUDE_NOTES.md` — 자연어 예약/회원가입 행동 지침 추가

---

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
