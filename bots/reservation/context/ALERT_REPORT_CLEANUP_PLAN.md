# Ska Alert/Report Cleanup Plan

작성일: 2026-04-11

## 목표

- 스카 예약 알림을 `Hub alarm -> Telegram topic` 단일 경로로 통일한다.
- 개인 채팅으로 새는 직접 Telegram 발송 경로를 제거한다.
- 비슷한 내용을 다른 배치가 반복 발행하는 리포트를 줄여 운영 피로를 낮춘다.
- "즉시 조치 필요"와 "참고용 리포트"를 더 분명하게 구분한다.

## 1. topic-only 정리 현황

완료:

- `bots/reservation/lib/alert-client.legacy.js`
  - `publishReservationAlert()`가 더 이상 `tryTelegramSend()` 개인 DM 폴백을 타지 않음
- `bots/reservation/lib/telegram.legacy.js`
  - `sendTelegram()`은 topic 경유 래퍼만 유지
  - `tryTelegramSend()`는 비활성화
- `bots/reservation/lib/health.legacy.js`
  - 시작/종료 알림을 `publishReservationAlert()`로 전환
- `bots/reservation/manual/reservation/pickko-cancel.legacy.js`
  - 앱/키오스크 PG 환불 후 수동처리 알림을 `publishReservationAlert()`로 전환
- `bots/reservation/scripts/deploy-ops.sh`
  - 배포 실패 알림을 `publishReservationAlert()`로 전환

남은 주의점:

- legacy alarm shim
  - hook 실패 시 `curl` 폴백은 유지
  - 다만 이 폴백도 여전히 `to=group:topic` 대상이라 개인 DM은 아님
- `packages/core/lib/telegram-sender*`, `reporting-hub*`
  - 공용 인프라 레벨의 Telegram 발송 코드가 남아 있음
  - 스카 예약 경로 직접 호출은 아니지만, 향후 공용 정책 정리 시 같이 검토 필요

## 2. 유사 알림/리포트 정리 후보

### A. 오늘 예약/마감 요약 계열

현재:

- `naver-monitor`
  - 일일 마감 요약
- `pickko-daily-summary`
  - 오전 예약 현황
  - 야간 매출/컨펌 요약
  - 미컨펌 리마인드
- `pickko-daily-audit`
  - 당일 접수 기준 감사

정리 방향:

- 오전 `현황`: `pickko-daily-summary` 유지
- 야간 `매출/컨펌`: `pickko-daily-summary` 유지
- 야간 `감지·처리 건수`: `naver-monitor` 요약은 `pickko-daily-summary` 안으로 흡수 검토
- `pickko-daily-audit`: 제목에 `당일 접수 기준`을 명시해 별도 의미 유지

### B. 수동 처리 필요 알림 계열

현재:

- `naver-monitor`
  - 픽코 등록 실패
  - 시간 경과/기존 등록 확인
- `pickko-kiosk-monitor`
  - 차단/해제/취소 실패
- `pickko-pay-scan`
  - 결제 후속 확인 필요
- `pickko-cancel`
  - 앱/키오스크 PG 환불 후 예약 상태 미반영

정리 방향:

- 모두 `alert` 유지
- 문구를 아래 3종으로 통일
  - `수동 처리 필요`
  - `수동 확인 권장`
  - `자동 복구됨`
- 실패 원인/조치 라인을 동일 형식으로 맞춘다

### C. 운영 상태/헬스 계열

현재:

- `health-check`
  - 다운/회복/미로드/비정상 종료
- `naver-monitor heartbeat`
  - 선택적 heartbeat
- `health.legacy`
  - 시작/종료 알림

정리 방향:

- `health-check`는 유지
- `heartbeat`는 기본 off 유지
- 시작/종료 알림은 `SKA_NOTIFY_SHUTDOWN=1`일 때만 유지

## 3. 즉시 적용 권장 순서

1. 완료
   - topic-only 경로로 통일
   - 직접 Telegram 경로 제거

2. 완료
   - `pickko-daily-audit` wording을 `당일 접수 기준`으로 수정

3. 완료
   - `naver-monitor` 일일 마감 요약은 기본 비활성화
   - 메인 야간 요약은 `pickko-daily-summary`로 일원화
   - 필요 시 `SKA_ENABLE_NAVER_DAILY_REPORT=1`일 때만 보조 요약 사용

4. 다음 작업
   - `pickko-kiosk-monitor`와 `naver-monitor`의 수동 처리 알림 템플릿 통일

5. 마지막 작업
   - 공용 `packages/core` 레벨의 Telegram direct helper를 정책 문서 기준으로 정리

## 4. 운영 원칙

- `alert`: 사람이 조치해야 할 때만
- `report`: 숫자/감사/요약
- `health_check`: 다운/회복/상태 이상만
- `heartbeat`: 기본 비활성화

- 개인 채팅 fallback 금지
- topic 라우팅 실패 시에는 조용히 실패 로그만 남기고, 같은 내용을 다른 채널로 재발송하지 않는다
- 같은 날짜/동일 대상/동일 조치 요구 알림은 가능한 한 묶어서 한 번만 보낸다

## 5. 공용 Telegram Helper 점검 메모

### 이미 안전한 경로

- `packages/core/lib/telegram-sender*`
  - `OPS`에서는 이미 `hubAlarmClient.postAlarm()`을 우선 사용한다.
  - `sendDirect()`도 `OPS`에서는 비활성화되어 있다.
  - 즉 현재 운영 서버에서 이 모듈은 기본적으로 topic 라우팅 쪽으로 간다.

- `scripts/api-usage-report.legacy.js`
  - 텔레그램 전송 플래그가 있어도 실제 발송은 `hubAlarmClient.postAlarm()` 사용
  - direct Telegram API 경로가 아님

### 남겨야 하는 direct API

- `packages/core/lib/reporting-hub*`
  - `telegram_api` target이 남아 있다.
  - 이는 특정 대상 채팅/스레드/inline keyboard 같은 특수 전달을 위해 필요하다.
  - 예: worker approval 요청처럼 일반 team topic broadcast와 다른 경우

- `bots/worker/lib/approval.js`
  - 승인 요청은 inline button 상호작용이 핵심이라 일반 report/alert와 완전히 같은 축이 아니다.
  - 이 경로는 `reporting-hub`의 `telegram_api` target 유지가 맞다.

### 다음 정리 원칙

- `topic broadcast` 용도:
  - `postAlarm()` 또는 `telegram-sender`만 사용

- `특정 채팅/특정 thread/inline keyboard` 용도:
  - `reporting-hub telegram_api target` 유지

- `직접 Bot API 호출`이 남아 있어도 아래 조건이면 유지:
  - Hub topic broadcast로 대체 불가
  - callback/approval/특정 대상 direct delivery가 목적

- 반대로 아래는 제거 대상:
  - 단순 알림인데 `chat_id`로 직접 보내는 fallback
  - topic 실패 시 개인 DM으로 우회하는 코드
