# SKA Skill: Pickko Management

## 목적
픽코 키오스크 관리 페이지의 주문/결제/회원 데이터 처리.
Jimmy(지미) PortAgent가 Playwright로 픽코 관리 페이지를 조작한다.

## 입력/출력
- 입력: 픽코 관리 페이지 HTML (Playwright 스크래핑)
- 출력: 주문 목록 JSON `{ order_id, member_name, room, date, start_time, amount, payment_method, status }`

## 핵심 API

### PickkoMonitor (Elixir GenServer)
- `TeamJay.Ska.Pickko.PickkoMonitor.get_status/0` — 키오스크 상태 + KPI
- `TeamJay.Ska.Pickko.PickkoMonitor.get_recent_cycles/1` — 최근 사이클 이력
- `TeamJay.Ska.Pickko.PickkoMonitor.report_cycle/1` — 사이클 완료 보고

### PickkoParser (Elixir 순수 함수)
- `TeamJay.Ska.Pickko.PickkoParser.parse_order_list/1` — JSON → 주문 구조체
- `TeamJay.Ska.Pickko.PickkoParser.classify_order_status/1` — 상태 분류
- `TeamJay.Ska.Pickko.PickkoParser.classify_payment/1` — 결제 수단 분류
- `TeamJay.Ska.Pickko.PickkoParser.parse_amount/1` — 금액 문자열 → 정수
- `TeamJay.Ska.Pickko.PickkoParser.filter_paid/1` — 결제 완료 필터
- `TeamJay.Ska.Pickko.PickkoParser.filter_today/1` — 오늘 날짜 필터

### PickkoAudit (Elixir GenServer)
- `TeamJay.Ska.Pickko.PickkoAudit.get_last_audit/0` — 최근 감사 결과
- `TeamJay.Ska.Pickko.PickkoAudit.trigger_audit/0` — 수동 감사 트리거

## 주문 상태
```
결제완료 → :paid
대기     → :pending
취소     → :cancelled
환불     → :refunded
```

## 결제 수단
- `:card` — 신용/체크카드
- `:cash` — 현금
- `:mobile` — 카카오페이, 네이버페이 등
- `:pass` — 이용권/정기권

## DB 테이블
- `reservation.pickko_order_raw` — 픽코 원시 주문 데이터
- `reservation.kiosk_block_attempts` — 차단 시도 이력

## 운영 규칙
- 5분 간격 폴링
- 매일 01:00 일일 감사 자동 실행 (PickkoAudit)
- 결제 금액 불일치 감지 시 즉시 텔레그램 알림
- 픽코 API 변경 시: selector_history 자동 업데이트 (ParsingGuard Level 3)
