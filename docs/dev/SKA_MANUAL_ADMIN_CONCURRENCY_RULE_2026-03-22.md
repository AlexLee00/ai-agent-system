# 스카 관리자 수동 작업 충돌 방지 규칙

> 작성일: 2026-03-22
> 목적: 픽코/네이버 관리자 화면을 사람이 직접 사용하는 동안 자동화가 같은 세션·브라우저 자원을 건드려 false warning, CDP 연결 실패, detached frame 오류를 일으키는 것을 방지한다.

## 1. 결론

현재 스카 운영에서는 아래를 기본 원칙으로 둔다.

- 운영자가 픽코 관리자 또는 네이버 예약관리 화면을 직접 사용하는 동안에는 `kiosk-monitor`를 내린다.
- `naver-monitor`는 감시 전용으로 유지하되, 브라우저 세션을 사람이 직접 건드리지 않는다.
- 수동 매출 추출, 수동 차단 확인, 수동 취소 정리처럼 관리자 화면을 오래 점유하는 작업이 끝난 뒤에만 `kiosk-monitor` 재개를 검토한다.

## 2. 왜 필요한가

최근 운영에서 아래 증상이 함께 관찰됐다.

- `Runtime.callFunctionOn timed out`
- `Target closed`
- `Session closed`
- `Attempted to use detached Frame`
- `connect ECONNREFUSED`

이 패턴은 보통 아래 조건이 겹칠 때 잘 생긴다.

- 자동화가 CDP로 브라우저/탭을 제어
- 운영자가 같은 관리자 화면 또는 같은 세션을 수동 조작
- 재기동 직후 자동화가 곧바로 같은 브라우저 자원에 재접속

즉 현재 구조에서는 “사람이 쓰는 관리자 화면”과 “자동화가 붙는 세션”이 완전히 분리돼 있지 않기 때문에, 수동 작업 시간대에는 충돌 가능성이 높다.

## 3. 지금 당장 필요한 구조

### 3-1. 기본 운영 규칙

- `naver-monitor`: 유지
- `kiosk-monitor`: 수동 관리자 작업 중에는 중지
- 텔레그램 경고가 폭주하면 먼저 `kiosk-monitor`를 내려 알림 경로를 끊고, 그 다음 `naver-monitor` 상태를 본다

### 3-2. 적용 시점

아래 작업을 할 때는 `kiosk-monitor`를 먼저 내린다.

- 픽코 관리자에서 매출 추출
- 네이버 예약관리에서 수동 차단/해제 확인
- 대량 예약 조회/정리
- 운영자가 장시간 관리자 화면을 직접 만지는 점검

### 3-3. 재개 조건

아래 조건이 맞을 때만 `kiosk-monitor` 재개를 검토한다.

- 운영자 수동 작업 종료
- `naver-monitor`가 1~2 사이클 연속 정상
- `naver-ops-mode.log`에 detached / target closed / session closed가 없음
- `health-report.js --json` 기준 `naver-monitor 정상`

## 4. 나중에 확장할 구조

현재는 운영 규칙으로 충돌을 피하는 단계다.

추후 SaaS 확장을 고려하면 아래 구조가 필요하다.

- `naver-monitor` 전용 브라우저 세션
- `kiosk-monitor` 전용 브라우저 세션
- 운영자 수동 확인 전용 세션
- 사람 세션과 자동화 세션을 다른 `userDataDir` 또는 다른 브라우저 인스턴스로 분리
- `naver-monitor ready -> kiosk-monitor allowed` 형태의 readiness gate

## 5. 현재 기준점

- `pickko-kiosk-monitor.js`
  - 성공한 차단/해제 완료는 이제 `event_type=report`, `alert_level=1`
- `naver-monitor.js`
  - `DevToolsActivePort` 기준으로 WS endpoint를 기록
- `start-ops.sh`
  - `kiosk-monitor` 즉시 kickstart 비활성화

즉 현재 기준으로는

- 감시 레일(`naver-monitor`)은 유지
- 차단 레일(`kiosk-monitor`)은 필요 시 수동으로 내리고 다시 올리는 보수적 운영

이 내부 MVP 단계에서 가장 안전하다.
