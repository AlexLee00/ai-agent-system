# SKA Skill: Kiosk Automation

## 목적
네이버 예약 → 픽코 키오스크 슬롯 자동 차단/해제.
예약 들어오면 해당 시간대 키오스크 좌석을 자동으로 비활성화한다.

## 핵심 플로우
```
네이버 신규 예약 감지
  → KioskBlockFlow.register_block(booking_id, slot_info)
  → KioskAgent.enqueue_block(entry)
  → PickkoPort → Jimmy PortAgent 실행
  → 픽코 관리 페이지에서 슬롯 비활성화
  → KioskBlockFlow.report_blocked(booking_id)
  → SkaBus :kiosk_slots_blocked 브로드캐스트

네이버 예약 취소 감지
  → KioskBlockFlow.request_unblock(booking_id)
  → KioskAgent.enqueue_unblock(entry)
  → Jimmy 실행 → 슬롯 복원
  → KioskBlockFlow.report_available(booking_id)
```

## 핵심 API

### KioskAgent (Elixir GenServer)
- `TeamJay.Ska.Kiosk.KioskAgent.enqueue_block/1` — 차단 명령 큐 추가
- `TeamJay.Ska.Kiosk.KioskAgent.enqueue_unblock/1` — 해제 명령 큐 추가
- `TeamJay.Ska.Kiosk.KioskAgent.enqueue_verify/1` — 검증 명령 큐 추가
- `TeamJay.Ska.Kiosk.KioskAgent.get_status/0` — 큐 상태 + 통계

### KioskBlockFlow (Elixir GenServer)
- `TeamJay.Ska.Kiosk.KioskBlockFlow.register_block/2` — 차단 등록
- `TeamJay.Ska.Kiosk.KioskBlockFlow.report_blocked/1` — 차단 완료
- `TeamJay.Ska.Kiosk.KioskBlockFlow.request_unblock/1` — 해제 요청
- `TeamJay.Ska.Kiosk.KioskBlockFlow.report_available/1` — 해제 완료
- `TeamJay.Ska.Kiosk.KioskBlockFlow.get_block_status/1` — 개별 예약 차단 상태
- `TeamJay.Ska.Kiosk.KioskBlockFlow.get_all_blocks/0` — 전체 차단 현황

### Node.js (pickko-kiosk-monitor.ts)
- `blockSlotOnly(entry)` — 슬롯 차단 실행
- `unblockSlotOnly(entry)` — 슬롯 해제 실행
- `auditToday(dateOverride)` — 오늘 차단 상태 감사
- `verifyBlockStateInFreshPage(...)` — 차단 결과 검증

## 차단 상태 전이
```
:pending → :blocking → :blocked
:blocked → :unblocking → :available
:any → :failed (실패 시)
```

## 고아 차단 감지
- 30분 이상 `:blocking` 상태 → 텔레그램 알림
- 5분마다 orphan_check 실행

## DB 테이블
- `reservation.kiosk_block_attempts` — 차단 시도 이력
- `reservation.kiosk_block_key_v2` — 차단 키 버전 관리

## 운영 규칙
- 명령 큐 최대 50개 (초과 시 드롭 + 경고)
- 차단 실패 → FailureTracker 자동 보고
- 네이버 예약 취소 → 픽코 자동 해제 (연동 플로우)
