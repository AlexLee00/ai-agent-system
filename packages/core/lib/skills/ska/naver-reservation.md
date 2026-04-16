# SKA Skill: Naver Reservation

## 목적
네이버 스마트플레이스 예약 리스트 파싱, 상태 관리, 자동 승인/취소 처리.
Andy(앤디) PortAgent가 Playwright로 네이버 예약 페이지를 조작한다.

## 입력/출력
- 입력: 네이버 예약 페이지 HTML (Playwright 스크래핑)
- 출력: 예약 목록 JSON `{ booking_id, guest_name, guest_phone, date, host, status }`

## 핵심 API

### NaverMonitor (Elixir GenServer)
- `TeamJay.Ska.Naver.NaverMonitor.get_status/0` — 최근 사이클 성공률/KPI
- `TeamJay.Ska.Naver.NaverMonitor.get_recent_cycles/1` — 최근 N개 사이클 결과
- `TeamJay.Ska.Naver.NaverMonitor.report_cycle/1` — 사이클 결과 보고

### NaverSession (Elixir GenServer)
- `TeamJay.Ska.Naver.NaverSession.get_status/0` — 세션 상태 (:healthy | :expired | :refreshing | :failed)
- `TeamJay.Ska.Naver.NaverSession.report_login_success/1` — 로그인 성공 보고
- `TeamJay.Ska.Naver.NaverSession.report_auth_expired/0` — 세션 만료 보고

### NaverParser (Elixir 순수 함수)
- `TeamJay.Ska.Naver.NaverParser.parse_booking_list/1` — JSON 목록 → 예약 구조체
- `TeamJay.Ska.Naver.NaverParser.classify_status/1` — 상태 문자열 → atom
- `TeamJay.Ska.Naver.NaverParser.filter_new/1` — 신규 예약만 필터
- `TeamJay.Ska.Naver.NaverParser.filter_cancelled/1` — 취소 예약만 필터

### Node.js PortAgent (naver-monitor.ts)
- `monitorBookings()` — 메인 모니터링 루프 (5분 간격)
- `naverLogin(page)` — 세션 로그인
- `scrapeNewestBookingsFromList(page, limit)` — 예약 리스트 스크래핑
- `updateBookingState(bookingId, booking, state)` — DB 상태 업데이트

## 예약 상태 전이
```
신규접수 → :new
  → 확인/승인 → :confirmed
  → 취소 → :cancelled
  → 노쇼 → :no_show
  → 대기 → :pending
```

## DB 테이블
- `reservation.reservations` — 예약 데이터 (booking_id, status, pickko_status 등)
- `reservation.agent_state` — Andy 에이전트 상태

## 운영 규칙
- 5분 간격 폴링 (launchd → SkaSupervisor PortAgent)
- 네이버 봇 탐지 주의: 빠른 반복 클릭 금지, 랜덤 딜레이 적용
- 세션 만료 시 NaverSession → NaverRecovery → 자동 재로그인
- 취소 감지 → KioskBlockFlow.request_unblock 자동 트리거
