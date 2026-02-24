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

## 최근 완료 작업 (2026-02-25 낮)

### 픽코 키오스크 모니터 신규 (pickko-kiosk-monitor.js)

- ✅ **신규** `src/pickko-kiosk-monitor.js` — 픽코 키오스크/전화 예약 감지 → 네이버 예약 불가 자동 차단
  - 이용금액 >= 1 필터로 키오스크 예약만 분리 (네이버 자동 등록 = 0원)
  - `pickko-kiosk-seen.json` 상태 파일 관리 (원자적 쓰기 + 만료 항목 자동 정리)
  - 네이버 booking calendar 자동화: DatePeriodCalendar 날짜선택 → 예약가능 슬롯 클릭 → 팝업 설정 → 설정변경
  - 차단 확인: 설정변경 후 시간박스에서 예약불가 텍스트 최종 확인
  - 실패 시 스크린샷 자동 저장 (`/tmp/naver-block-*.png`) + 텔레그램 수동 처리 요청
  - naver-monitor.js 세션 충돌 방지: `naver-booking-profile` 별도 프로파일 사용
- ✅ **신규** `src/run-kiosk-monitor.sh` — launchd 래퍼 (중복 실행 방지 lock)
- ✅ **신규** `ai.ska.kiosk-monitor.plist` — 30분 주기 launchd 등록 완료
  - 등록: `launchctl load ~/Library/LaunchAgents/ai.ska.kiosk-monitor.plist`
  - 로그: `/tmp/pickko-kiosk-monitor.log`
- ✅ `.gitignore` — `pickko-kiosk-seen.json` 추가 (전화번호 포함)

**다음 작업**: 수동 테스트 — `node src/pickko-kiosk-monitor.js` 실행 후 셀렉터 검증

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

### 🔜 다음 작업 (2026-02-26 예정)

**픽코 예약 → 네이버 예약 불가 처리**

픽코에서 직접 예약(전화/현장)이 들어왔을 때, 네이버 스마트플레이스 해당 시간대를 자동으로 예약 불가 처리하는 기능.

```
[픽코 어드민] 신규 예약 감지 (주기적 폴링 또는 감지)
        ↓
[naver-monitor or 신규 스크립트] 네이버 스마트플레이스 접속
        ↓
해당 날짜·시간·룸 → 예약 불가(블록) 처리
        ↓
[텔레그램] 처리 완료 알림
```

**핵심 고려사항:**
- 픽코 신규 예약 감지 방법: pickko-daily-audit.js 방식(폴링) vs 픽코 webhook(있다면)
- 네이버 예약 불가 처리 UI: 스마트플레이스 관리자 → 예약 설정 → 특정 시간 차단
- 중복 처리 방지: 이미 네이버에서 들어온 예약은 스킵 (naver-seen.json 확인)
- 대상: pickko-daily-audit이 감지한 manual/전화 예약만 (auto 제외)

---

| 순서 | 기능 | 설명 | 우선순위 |
|------|------|------|---------|
| 1 | **픽코→네이버 예약 불가** | 픽코 직접 예약 감지 → 네이버 해당 시간 차단 | **🔜 다음** |
| 2 | 일일 예약 요약 자동 전송 | 매일 지정 시각에 예약 현황 요약 메시지 → 텔레그램 | 중간 |
| 3 | 예약 중복 감지 알림 | 동일 시간대 중복 예약 발생 시 즉시 경고 | 중간 |
| 4 | IS-001 홈화면 복귀 이슈 | session/cookie 만료 처리 개선 | 낮음 |
| 5 | Playwright → 네이버 API | UI 변경 취약점 근본 해결 (장기) | 장기 |
| 6 | 맥미니 이전 | M4 Pro 구매 후 전체 시스템 이전 | Phase 3 |

---

## 주의사항

- DEV 테스트 데이터는 절대 OPS로 처리하지 말 것
- 새 기능은 반드시 `MODE=dev`로 테스트 후 OPS 재시작
- `naver-seen.json`에는 실제 완료 예약만 보존
