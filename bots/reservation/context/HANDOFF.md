# 스카 (Ska) - 최신 인수인계

> **스카** = 스터디카페 예약관리봇 | **클로드** = Claude Code (AI 개발 파트너)
> 이 파일은 모델 교체/재시작 시 가장 최근 상태를 빠르게 파악하기 위한 인수인계 문서입니다.
> 새로운 작업이 완료될 때마다 업데이트하세요.

---

## 현재 운영 상태

| 항목 | 내용 |
|------|------|
| 모드 | OPS (운영) |
| 모델 | google-gemini-cli/gemini-2.5-flash |
| 채널 | 텔레그램 (@SCAFE8282_BOT) |
| 모니터 | 자동 재시작 루프 (2시간 주기) |

---

## 🐛 이슈 & 버그 추적

> 자동 관리: `bug-report.js` 실행 시 갱신 | 수동 등록: `node src/bug-report.js --new --title "..." --by ska`

<!-- bug-tracker:issues:start -->
_현재 미해결 이슈 없음_

**최근 해결:**
- ✅ `BUG-003` **알림 파일 resolved 상태 미관리 — 수동 확인 필요 알림 누적**
  재시작 후 '✅ 미해결 알림 없음' 로그 확인 (-45분 전)
- ✅ `BUG-004` **테스트 버그 (삭제 예정)**
  테스트 완료, 삭제 (5분 전)
- ✅ `BUG-002` **completed/manual 예약 재감지 루프 및 code 99 미마킹**
  재시작 후 '신규 후보 없음' 정상 확인 — 3건 기처리 예약 재감지 없음 (25분 전)
<!-- bug-tracker:issues:end -->

---

## 🔧 최근 유지보수 이력

> 자동 관리: `bug-report.js --maintenance` 실행 시 갱신

<!-- bug-tracker:maintenance:start -->
- 🚑 `MAINT-004` [hotfix] **cancelledSeenIds 오감지 취소 키 제거** *(→ BUG-002)*
  2026. 2. 24. 16:00 · claude · `naver-seen.json`
- 🚑 `MAINT-003` [hotfix] **.pickko-alerts.jsonl 초기 누적 항목 정리 (284건→3건)**
  2026. 2. 24. 15:50 · claude · `.pickko-alerts.jsonl`
- ⚙️ `MAINT-002` [config] **모니터링 주기 3분 → 5분 변경 (NAVER_INTERVAL_MS)**
  2026. 2. 24. 15:40 · claude · `src/start-ops.sh`
- 🚑 `MAINT-001` [hotfix] **010-3034-1710 나은애 픽코 수동 등록 완료 처리**
  2026. 2. 24. 15:30 · claude · `naver-seen.json`
<!-- bug-tracker:maintenance:end -->

## 최근 완료 작업 (2026-02-25 오후) — 취소 로직 재작성 + 결제 플로우 개선

### pickko-cancel.js 취소 플로우 완전 재작성

기존 방식(sd_step=-1 라디오 선택)은 잘못된 흐름. 올바른 취소 플로우로 재작성:

**새 취소 흐름 [6~10단계]:**
1. 상세보기 진입 후 결제완료/결제대기 행의 **주문상세** 버튼 클릭
2. 팝업 모달 내 결제항목 **상세보기** 버튼 클릭 (결제완료 상태일 때만 존재)
3. 오른쪽 팝업에서 **환불** 버튼 클릭
4. "처리되었습니다" 확인 팝업 클릭

- ✅ `TARGET_STATUS` = `['결제완료', '결제대기']` — 두 상태 모두 처리 대상
- ✅ `DONE_STATUS` = `['환불완료', '환불성공', '취소완료']` — 중복 처리 방지 자동 감지
- ⚠️ **주의**: 환불 버튼은 결제완료 상태에서만 표시됨. 결제대기 상태는 주문상세 클릭 후 결제하기 버튼만 있음

### pickko-accurate.js SKIP_PRICE_ZERO=1 결제 플로우 개선

키오스크 시뮬레이션(이용금액 실제 금액 결제) 브랜치:
- ✅ `label[for="pay_type1_2"]` 현금 선택 추가 (`clickCashMouse()` 재활용)
- ✅ `#pay_order` 클릭 후 결제완료 DOM 팝업 확인(확인 버튼 클릭) 추가 [8-5]

### 테스트 예약 현황

| 주문번호 | 날짜 | 시간 | 결제 | 상태 |
|---------|------|------|------|------|
| 928880 | 2026-02-26 | 11:00~12:00 | 카드 0원 | 환불완료 (이전 세션) |
| 928882 | 2026-03-05 | 11:00~12:00 | 카드 0원 | 환불완료 (이전 세션) |
| 928895 | 2026-02-27 | 11:00~11:50 | 현금(대기) | **결제대기** — 취소 테스트용 |

> 928895 취소 테스트: 결제대기 → 결제완료 처리 후 `node src/pickko-cancel.js --phone 01035000586 --date 2026-02-27 --start 11:00 --end 12:00 --room A1` 실행 필요

---

## 최근 완료 작업 (2026-02-25 야간) — 테스트 예약불가 복원 + 임시 파일 전체 정리

### 테스트 예약불가 복원 확인

- `restore-available.js` 작성·실행 → 2026-02-25 테스트로 설정한 예약불가 4건 복원
- 복원 후 스크린샷(`/tmp/feb25-calendar.png`) 확인: `suspended` 클래스 0건 ✅
  - 화면의 A2룸 빨간 버튼은 `soldout(예약가능 0)` — 실제 확정 예약(이재룡) 있는 정상 상태
- 2026-03-02 이승호 B룸 18:00~20:00 예약불가는 실제 예약이므로 **유지**

### 루트 임시 파일 전체 정리

아래 파일 모두 삭제 (디버그·테스트용, 더 이상 불필요):
`add-test-booking.js`, `cancel-jaelyong.js`, `cancel-test-booking.js`, `complete-test-payment.js`,
`finalize-test-payment.js`, `finalize-test-payment2.js`, `inspect-pickko-form.js`,
`naver-browser-stub.js`, `restore-available.js`, `test-naver-parse.js`, `check-feb25.js`

---

## 최근 완료 작업 (2026-02-25 저녁) — 키오스크 모니터 검증 완료 + verifyBlockInGrid 수정

### pickko-kiosk-monitor.js verifyBlockInGrid 버그 수정 + 최종 검증

**수정 내용:**
- `verifyBlockInGrid()` 재작성: 이전 구현은 "예약불가" 필터 탭 텍스트가 페이지에 있으면 무조건 `verified:true` 반환하는 false positive 문제
- 수정 후: `suspended btn-danger-light` 클래스 버튼이 실제로 target 룸 X 범위 + 시작시간 Y 범위에 있는지 DOM 좌표 기반으로 확인
- 예약가능 슬롯 클래스: `avail btn-info-light` / 예약불가 슬롯 클래스: `suspended btn-danger-light`

**API 검증 결과 (CDP 인터셉트):**
```
PATCH https://api-partner.booking.naver.com/v3.1/businesses/596871/biz-items/4134332/schedules
Body: {"startDate":"2026-03-02","endDate":"2026-03-02","startTime":"18:00","endTime":"20:00","status":"OFF","stock":null}
HTTP 200 OK ✅
```

**최종 실행 결과:**
- 이승호 01062290586 | 2026-03-02 18:00~19:50 | 스터디룸B → 네이버 차단 확인
- `suspendedBtn: {cls: "btn btn-xs calendar-btn suspended btn-danger-light", x:643}` ✅
- 텔레그램: "🚫 네이버 예약 차단 완료 이승호 010-6229-0586 2026-03-02 18:00~19:50 스터디룸B" ✅

**주요 발견사항 (debugging):**
- 네이버 캘린더 Y 좌표: 오후 6:00 슬롯은 스크롤 후 Y≈865 (viewport 하단). 이전 check 스크립트가 Y>800 필터로 제외해서 "예약가능" 오판
- `stock:null` 전송 → API 200 OK (null=변경 없음으로 처리됨)
- `page.mouse.click()` vs `element.click()`: React SPA 날짜 피커는 반드시 mouse.click 필요

## 최근 완료 작업 (2026-02-25 낮~오후) — 픽코 키오스크 모니터 완전 구현

### pickko-kiosk-monitor.js — Phase 1~5 전체 완성 및 검증 완료

- ✅ **Phase 1**: 픽코 `이용금액>=1` 필터로 키오스크/전화 예약만 파싱 (네이버 자동 등록=0원 제외)
- ✅ **Phase 2**: `pickko-kiosk-seen.json` 상태 비교 → 신규 예약 감지
- ✅ **Phase 3**: 네이버 booking calendar 자동 차단 (CDP — naver-monitor 세션 재활용)
  - `DatePeriodCalendar__date-info` 클릭 → 2-month picker 팝업
  - 월 헤더 bounding rect 기반 날짜 셀 `page.mouse.click()` (공휴일 셀 startsWith 처리)
  - `BUTTON.form-control` (custom-selectbox) 클릭 → `BUTTON.btn-select` 옵션 선택
  - 종료시간 30분 올림: `roundUpToHalfHour()` (19:50 → 20:00)
  - CDP Frame detach 발생 시 새 탭으로 1회 자동 재시도
  - 예약상태 → 예약불가 선택 → 설정변경 클릭
- ✅ **Phase 4**: 텔레그램 알림 (차단 성공/실패 구분)
- ✅ **Phase 5**: 만료 항목 자동 정리 (date < today)
- ✅ `src/run-kiosk-monitor.sh` — launchd 래퍼 (중복 실행 방지 lock)
- ✅ `ai.ska.kiosk-monitor.plist` — 30분 주기 launchd 로드 완료
  - 로그: `/tmp/pickko-kiosk-monitor.log`
- ✅ `.gitignore` — `pickko-kiosk-seen.json` 추가 (전화번호 포함)

**테스트 결과**: 이승호 01062290586 | 2026-03-02 18:00~19:50 | 스터디룸B → 네이버 차단 완료 (`naverBlocked: true`)

---

## 최근 완료 작업 (2026-02-25 오전)

### 안정화 업데이트 8건 + 신규 스크립트 검증

- ✅ **C-1** `lib/files.js` `saveJson()` 원자적 쓰기 — tmp 파일 + rename (파일 손상 방지)
- ✅ **C-2** `pickko-verify.js` `markCompleted()` name 필드 유실 수정
- ✅ **C-3** `pickko-accurate.js` 시간 슬롯 재시도 1회 → 3회 (+ 1.5초 delay)
- ✅ **H-1** `naver-monitor.js` `rollbackProcessingEntries()` 추가 — exit 전 processing → failed 롤백
- ✅ **H-2** `start-ops.sh` 로그 파일 관리 — `LOG_FILE` 변수 + 1000줄 로테이션
- ✅ **H-3** `naver-monitor.js` `pruneSeenIds()` — seenIds 90일 초과 항목 정리 (기존 slice(-500) 대체)
- ✅ **H-4** `pickko-register.js` 성공 시 naver-seen.json에 `pickkoStatus: 'manual'` 기록
- ✅ **M-1** `naver-monitor.js` 사이클 타임 기반 슬립 조정 — 인터벌 드리프트 방지
- ✅ **M-2** `ai.ska.pickko-daily-audit.plist` 23:50 실행 추가 (22:00+23:50 2회)

### pickko-verify.js needsVerify() 개선

- ✅ `needsVerify()` 신규 — `completed + paid/auto` 항목도 검증 대상으로 처리
- 기존 임시 `status: 'pending'` 변경 우회 방식 완전 폐기
- 한송이 3건 backfill(1166777081/64/41) → `verified` 전환 완료

### 신규 스크립트 테스트 통과

- ✅ `pickko-daily-audit.js` — DOM 파싱·헤더 추출 정상 (당일 0건)
- ✅ `pickko-register.js` — 이재룡 01035000586 A1 예약 등록 성공 (`/study/view/928851.html`)
- ✅ `pickko-member.js` — 기존회원 감지 + 신규 회원 가입 모두 정상
  - ⚠️ 테스트 회원 `테스트 / 010-1234-1234` 픽코 admin에서 수동 삭제 필요

### OPS 시작 커맨드 업데이트

- `start-ops.sh` 내부에서 로그 리디렉션 처리 → 외부 `>>` 불필요
- 재시작 방법: `kill -9 <start-ops.sh PID>` 후 `nohup bash start-ops.sh > /dev/null 2>&1 &`

---

## 최근 완료 작업 (2026-02-24 오후)

- ✅ **모델 교체** — gemini-2.0-flash(deprecated) → `gemini-2.5-flash`
  - OpenClaw primary 모델 변경 + 게이트웨이 재시작 완료
  - Fallback: claude-haiku-4-5 → qwen2.5:7b 순 (openclaw.json 실제 설정 기준)

## 최근 완료 작업 (2026-02-24 낮)

- ✅ **야간 알림 차단** — `sendAlert()` 09:00~22:00 외 텔레그램 발송 차단
  - 야간: `.pickko-alerts.jsonl`에 `sent: false`로 파일에만 기록
  - `flushPendingAlerts()` 신규 — 09:00 첫 Heartbeat 시 보류 알림 일괄 발송
  - `morningFlushDone` 플래그 — 당일 1회만 실행
- ✅ **클로드↔봇 전달 채널 구축** — `CLAUDE_NOTES.md` 시스템
  - `context/CLAUDE_NOTES.md` 신규 생성 (클로드→스카 전용 채널 파일)
  - `registry.json` — openclaw 배포 파일 목록에 추가
  - BOOT.md 자동 재생성 (5. `CLAUDE_NOTES.md` 추가)
- ✅ **클로드 부팅 참조 시스템** — `SYSTEM_STATUS.md` 자동 생성
  - `deploy-context.js` — `updateSystemStatus()` 함수 추가
  - 봇 배포 시마다 모든 봇 상태·로그인방식·배포이력 자동 갱신
- ✅ **역할 정의 메모리 등록** — 클로드/스카 명칭 전체 문서에 기록

## 최근 완료 작업 (2026-02-24 오전)

- ✅ **공유 라이브러리 리팩토링** — lib/ 7개 신규 모듈 추출
  - `lib/utils.js` → delay, log
  - `lib/secrets.js` → loadSecrets()
  - `lib/formatting.js` → toKoreanTime, pickkoEndTime, formatPhone
  - `lib/files.js` → loadJson, saveJson
  - `lib/args.js` → parseArgs()
  - `lib/browser.js` → getPickkoLaunchOptions, setupDialogHandler
  - `lib/pickko.js` → loginToPickko()
- ✅ 4개 src 파일 중복 코드 제거 (node --check 전체 통과, 봇 재시작 확인)
- ✅ pickko-verify.js — pending/failed 예약 재검증 스크립트 신규 완성
- ✅ 개발문서 전체 업데이트 (README, DEV_SUMMARY, HANDOFF, IMPLEMENTATION_CHECKLIST)

## 최근 완료 작업 (2026-02-24 새벽)

- ✅ 취소 감지 방식 → `previousConfirmedList` 리스트 비교 (카운터 비교 폐기)
- ✅ 보안인증 대기 30분 + 텔레그램 알림 (원격 인증 처리 지원)
- ✅ 모니터링 주기 3분 (`NAVER_INTERVAL_MS=180000`)
- ✅ 새로고침 버튼 → `btn_refresh` selector 방식으로 수정
- ✅ `updateBookingState()`에 `name` 필드 추가
- ✅ Heartbeat 추가 (1시간 주기, 09:00~22:00만, `sendTelegramDirect`)
- ✅ `log-report.sh` 신규 생성 + launchd `ai.ska.log-report` 등록 (3시간 주기)

## 최근 완료 작업 (2026-02-23)

- ✅ `process.exit(0)` 버그 수정 - 픽코 성공 시 exit code가 1로 오인되던 문제
- ✅ `maxSlotsToTry` 미정의 변수 수정
- ✅ `OBSERVE_ONLY=0` OPS 시작 커맨드에 고정
- ✅ DEV/OPS 데이터 파일 분리 (`naver-seen-dev.json` / `naver-seen.json`)
- ✅ `start-ops.sh` 자동 재시작 루프 추가 (2시간 후 자동 재시작)
- ✅ `start-ops.sh` `cleanup_old()` 추가 - 재시작 시 구 프로세스 자동 종료
- ✅ `naver-monitor.js` 락 로직 개선 - 신규 시작 시 구 프로세스 SIGTERM→SIGKILL 처리
- ✅ 컨텍스트 관리 시스템 구축 (`registry.json` + `deploy-context.js`)
- ✅ `deploy-context.js` claude-code 타입 지원 추가
- ✅ MEMORY.md Heartbeat 모니터 생존 체크 지시 추가
- ✅ `nightly-sync.sh` + launchd 자정 자동 보존 시스템 구축
- ✅ BOOT.md 모델 변경 자동 컨텍스트 보존 - 게이트웨이 재시작 시 `deploy-context.js --sync` 1단계 자동 실행 (테스트 완료)
- ✅ detached Frame 버그 수정 - `runPickko()` 내 `naveraPage.close()` 제거 (픽코 실행 후 네이버 페이지 무효화 근본 해결)
- ✅ 수동 등록 예약 2건 seen 처리 완료
  - 010-2745-9103 (2026-02-26 14:30~16:30 A2) → completed/manual
  - 010-5681-7477 (2026-02-24 04:00~09:00 A1) → completed/manual

## 실제 등록 완료 예약

| 예약ID | 고객번호 | 날짜 | 시간 | 룸 | 상태 |
|--------|----------|------|------|-----|------|
| 1165071422 | 010-4214-0104 | 2026-02-28 | 16:00~18:00 | A1 | completed (auto) |

## OPS 시작 커맨드

```bash
cd ~/projects/ai-agent-system/bots/reservation/src
nohup bash start-ops.sh > /dev/null 2>&1 &
# 로그: /tmp/naver-ops-mode.log (start-ops.sh 내부에서 자동 리디렉션 + 1000줄 로테이션)
```

## 🗂️ 스카봇 기능 대기 목록 (다음 개발 예정)

### 🔜 다음 작업

| 순서 | 기능 | 설명 | 우선순위 |
|------|------|------|---------|
| 1 | 일일 예약 요약 자동 전송 | 매일 지정 시각에 예약 현황 요약 메시지 → 텔레그램 | 중간 |
| 2 | 예약 중복 감지 알림 | 동일 시간대 중복 예약 발생 시 즉시 경고 | 중간 |
| 3 | IS-001 홈화면 복귀 이슈 | session/cookie 만료 처리 개선 | 낮음 |
| 4 | Playwright → 네이버 API | UI 변경 취약점 근본 해결 (장기) | 장기 |
| 5 | 맥미니 이전 | M4 Pro 구매 후 전체 시스템 이전 | Phase 3 |

---

## 주의사항

- DEV 테스트 데이터는 절대 OPS로 처리하지 말 것
- 새 기능은 반드시 `MODE=dev`로 테스트 후 OPS 재시작
- `naver-seen.json`에는 실제 완료 예약만 보존
