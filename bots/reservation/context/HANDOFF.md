# 스카 (Ska) - 최신 인수인계

> 이 파일은 모델 교체/재시작 시 가장 최근 상태를 빠르게 파악하기 위한 인수인계 문서입니다.
> 새로운 작업이 완료될 때마다 업데이트하세요.

---

## 현재 운영 상태

| 항목 | 내용 |
|------|------|
| 모드 | OPS (운영) |
| 모델 | google-gemini-cli/gemini-2.0-flash |
| 채널 | 텔레그램 (@SCAFE8282_BOT) |
| 모니터 | 자동 재시작 루프 (2시간 주기) |

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
bash start-ops.sh >> /tmp/naver-ops-mode.log 2>&1 &
```

## 주의사항

- DEV 테스트 데이터는 절대 OPS로 처리하지 말 것
- 새 기능은 반드시 `MODE=dev`로 테스트 후 OPS 재시작
- `naver-seen.json`에는 실제 완료 예약만 보존
