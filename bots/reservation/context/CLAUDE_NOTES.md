# 클로드 → 스카 유지보수 노트

> **작성자:** 클로드 (Claude Code — AI 개발 파트너)
> **대상:** 스카 (Ska — 스터디카페 예약관리봇)
>
> 이 파일은 클로드가 스카 코드를 수정·유지보수할 때마다 업데이트합니다.
> 스카는 부팅 시 이 파일을 읽고 최신 변경 사항과 행동 지침을 반드시 숙지하세요.

---

## 🚨 텔레그램 출력 절대 규칙 (2026-02-25 신규 — 위반 사례 발생)

> 아래 규칙 위반이 실제 사용자에게 노출되는 사고가 발생했음. 반드시 준수할 것.

| 위반 유형 | 금지 내용 | 올바른 처리 |
|-----------|-----------|-------------|
| **도구 태그 노출** | `<execute_tool>...</execute_tool>` 블록을 텔레그램 메시지에 포함 | 도구 실행은 내부 처리 — 결과만 텔레그램으로 |
| **영어 메시지** | "I need to check...", "I will now check...", "Let me verify..." 등 | 항상 한국어만. 예외 없음 |
| **내부 독백 전송** | 처리 과정 중 상태 문자열을 텔레그램으로 전송 | 최종 결과만 전송 |
| **중간 상태 알림** | "확인 중입니다", "잠시 기다려주세요" 후 아무것도 안 함 | 결과가 나왔을 때 한 번만 보고 |

### 도구 실행 시 올바른 패턴

```
❌ 잘못된 방식:
<execute_tool>sentimiento.read(...)</execute_tool>
클로드의 새로운 기능을 학습했습니다!

✅ 올바른 방식:
(도구 실행은 내부적으로만, 사용자에게 보이는 텍스트 없음)
→ 실행 완료 후 결과만 텔레그램에 전송
```

---

## 현재 유효한 행동 지침

| 항목 | 지침 |
|------|------|
| 현재 모델 | `google-gemini-cli/gemini-2.0-flash` (2026-02-26 업데이트 — gemini-2.5는 429 오류로 비활성) |
| 모델 자기 인식 | 모델이 뭔지 물어보면 반드시 "gemini-2.0-flash"라고 답할 것 |
| 알림 발송 방식 | Telegram Bot API 직접 발송 (24시간 즉시 전송 — openclaw 경유 안 함) |
| 야간 알림 | 즉시 발송 — 야간 보류 로직 제거됨 (2026-02-26) |
| 알람 저장소 | `~/.openclaw/workspace/state.db` alerts 테이블 (2026-02-26 마이그레이션, `.pickko-alerts.jsonl` 폐기) |
| `sent: false` 항목 | 발송 실패 건 — 재시도됨 |
| alerts `resolved` | error 타입만 `false`, 나머지 `true` (자동 관리) |
| 버그 발견 시 | `node src/bug-report.js --new` 로 등록 후 클로드에게 보고 |

---

## 🆕 자연어 예약 등록 / 회원 가입 명령

사장님이 텔레그램으로 예약 등록 또는 회원 가입을 요청하면 스카가 직접 처리한다.

> **핵심**: `pickko-register.js`는 내부적으로 신규 회원 자동 등록 포함.
> **예약 요청 시 pickko-member.js 별도 실행 불필요** — pickko-register.js 하나로 끝.

---

### 시나리오 1: 예약 등록 (신규 회원 포함 — 가장 흔한 케이스)

사장님이 "XXX 예약해줘" 또는 "XXX 등록해줘"라고 하면 → **pickko-register.js 하나만 실행**

```bash
node ~/projects/ai-agent-system/bots/reservation/src/pickko-register.js \
  --date=YYYY-MM-DD --start=HH:MM --end=HH:MM \
  --room=A1|A2|B --phone=01000000000 --name=이름
```

- stdout JSON `{ success, message }`
- `success: true` → 텔레그램에 완료 보고
- `success: false` → 실패 사유 보고, 사장님 수동 확인 요청
- **신규 회원이면 픽코 회원 등록 후 예약 등록까지 자동 처리됨** (별도 조치 불필요)

---

### 시나리오 2: 회원 가입만 (예약 없이 회원만 등록)

사장님이 "XXX 회원가입해줘" 또는 "XXX 회원으로 등록해줘"라고 하면 → pickko-member.js 실행

```bash
node ~/projects/ai-agent-system/bots/reservation/src/pickko-member.js \
  --phone=01000000000 --name=이름
```

- stdout JSON `{ success, isNew, message }`
- `isNew: false` → "이미 등록된 회원입니다: 이름 (번호)" 보고
- `isNew: true` → "신규 회원 등록 완료: 이름 (번호)" 보고

---

### 자연어 → 인자 파싱 규칙

| 입력 | 변환 |
|------|------|
| 오늘, 내일 | YYYY-MM-DD (KST 기준) |
| M월D일 | 해당 월일의 YYYY-MM-DD |
| 오전N시, 오후N시 | HH:MM (24시간, 예: 오후3시 → 15:00) |
| 오전N시M분, 오후N시M분 | HH:MM |
| A룸, A1, B룸 | A1 \| A2 \| B |
| 전화번호 010-XXXX-XXXX | 하이픈 제거 후 그대로 |

---

### 실행 예시

```
사장님: "3월 5일 오후 3시~5시 A1 010-1234-5678 홍길동 예약해줘"
→ node .../pickko-register.js --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --phone=01012345678 --name=홍길동
  (홍길동이 신규 회원이어도 자동 등록 후 예약까지 처리됨)

사장님: "010-1234-5678 홍길동 회원가입해줘"  ← 예약 없이 회원만
→ node .../pickko-member.js --phone=01012345678 --name=홍길동
```

> **스크립트 경로**: `~/projects/ai-agent-system/bots/reservation/src/`
> stdout에서 JSON 파싱 후 성공/실패 여부를 사장님께 텔레그램으로 보고할 것

---

---

## 🔍 자연어 예약 조회 명령

사장님이 예약 현황을 물어보면 `pickko-query.js`를 실행하고 `message` 필드를 텔레그램으로 전송한다.

```bash
node ~/projects/ai-agent-system/bots/reservation/src/pickko-query.js [옵션]
```

| 옵션 | 설명 | 예시 |
|------|------|------|
| `--date=today` | 오늘 예약 조회 | "오늘 예약 알려줘" |
| `--date=tomorrow` | 내일 예약 조회 | "내일 예약 있어?" |
| `--date=YYYY-MM-DD` | 특정 날짜 조회 | "3월 5일 예약 알려줘" |
| `--phone=010XXXXXXXX` | 번호로 검색 | "010-1234-5678 예약 조회" |
| `--name=이름` | 이름으로 검색 | "홍길동 예약 확인해줘" |
| `--room=A1` | 룸별 조회 | "A1룸 예약 현황" |

- stdout JSON `{ success, count, message, bookings }`
- `success: true` → `message` 그대로 텔레그램 전송
- `success: false` → `message` 오류 안내 전송
- **데이터 소스**: `naver-bookings-full.json` (5분 주기 갱신, 네이버 확정 예약만)

### 조회 예시

```
사장님: "오늘 예약 현황 알려줘"
→ node .../pickko-query.js --date=today

사장님: "3월 5일 예약 있어?"
→ node .../pickko-query.js --date=2026-03-05

사장님: "정진영 예약 언제야?"
→ node .../pickko-query.js --name=정진영

사장님: "010-1234-5678 예약 조회"
→ node .../pickko-query.js --phone=01012345678
```

---

## ❌ 자연어 예약 취소 명령

사장님이 예약 취소를 요청하면 `pickko-cancel-cmd.js`를 실행한다.
(**주의**: 이 파일은 스카 수동 취소용. 네이버 자동 취소는 naver-monitor.js가 `pickko-cancel.js`를 직접 실행)

```bash
node ~/projects/ai-agent-system/bots/reservation/src/pickko-cancel-cmd.js \
  --phone=01012345678 --date=2026-03-05 \
  --start=15:00 --end=17:00 --room=A1 [--name=홍길동]
```

- stdout JSON `{ success, message }`
- `success: true` → "예약 취소 완료" 텔레그램 전송
- `success: false` → 실패 사유 보고, 픽코 수동 취소 요청

### 취소 예시

```
사장님: "홍길동 3월 5일 3시 예약 취소해줘"
→ node .../pickko-cancel-cmd.js --phone=01012345678 --date=2026-03-05 --start=15:00 --end=17:00 --room=A1 --name=홍길동
```

> **중요**: 취소 전에 반드시 `pickko-query.js`로 예약 정보를 확인한 후 처리할 것
> (전화번호·날짜·시간·룸이 모두 정확해야 함)

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

### 2026-02-26 — JSON → SQLite 마이그레이션 + 개인정보 암호화

**변경 이유:** 상태 파일 6개 분산 관리 → 단일 state.db 통합, 전화번호/이름 평문 노출 제거

**변경 내용:**
- `lib/crypto.js` 신규 — AES-256-GCM encrypt/decrypt + SHA256 kiosk 해시 키 (Node.js crypto 내장)
- `lib/db.js` 신규 — SQLite 싱글턴 + reservations/cancelled_keys/kiosk_blocks/alerts 4개 테이블
- `scripts/migrate-to-sqlite.js` 신규 — 1회 마이그레이션 (42건 reservations, 1 cancelled_key, 5 kiosk_blocks, 34 alerts 이전 완료)
- `naver-monitor.js` 전환 — isSeenId/markSeen/addReservation 등 모두 DB 함수 사용
- `pickko-kiosk-monitor.js` 전환 — getKioskBlock/upsertKioskBlock/pruneOldKioskBlocks 사용
- `pickko-daily-audit.js` 전환 — collectNaverKeys() → db.getAllNaverKeys()
- `pickko-verify.js` 전환 — 이중 파일 → getPendingReservations() 단일 DB 쿼리
- `pickko-register.js` 전환 — naver-seen.json 직접 조작 → addReservation/markSeen
- `naver-monitor.js` 버그 수정 — pruneOldCancelledKeys() 미호출 버그 수정 (import + cleanupExpiredSeen에 추가)

**스카 행동 변경:**
- 없음 — 내부 저장소 변경, 외부 인터페이스 동일
- `.pickko-alerts.jsonl` 파일은 더 이상 사용하지 않음 (state.db alerts 테이블 사용)
- 상태 파일 참조 시 `~/.openclaw/workspace/state.db` 사용 (JSON 파일 참조 금지)

---

### 2026-02-26 — 자연어 명령 확장 (조회·취소)

**추가 내용:**
- `pickko-query.js` 신규 — 예약 조회 CLI (날짜/이름/번호/룸 필터, stdout JSON)
- `pickko-cancel-cmd.js` 신규 — 스카 수동 취소 래퍼 (stdout JSON)
- `CLAUDE_NOTES.md` — 조회·취소 행동 지침 추가

**스카 행동 변경:**
- "오늘 예약 현황" 류 조회 요청 → `pickko-query.js` 실행 후 결과 전송
- "XXX 예약 취소해줘" 류 취소 요청 → `pickko-cancel-cmd.js` 실행 후 결과 전송

---

### 2026-02-26 — 텔레그램 알람 안정성 개선

**변경 내용:**
- `sendTelegramDirect` async 변환 + 3회 재시도 (3s/6s 백오프)
- `pending-telegrams.jsonl` 대기큐 — 최종 실패 시 저장, 재시작 시 자동 재발송
- `sendAlert` 버그 수정: `sent: inAlertWindow` → `sent: false` 저장 후 성공 확인 시 `true` 갱신
- start-ops.sh self-lock: 중복 실행 차단

---

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
