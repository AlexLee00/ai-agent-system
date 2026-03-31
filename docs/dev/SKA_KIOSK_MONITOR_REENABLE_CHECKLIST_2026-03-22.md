# 스카 `kiosk-monitor` 재개 체크리스트

> 작성일: 2026-03-22
> 목적: `kiosk-monitor`를 다시 올릴 때 같은 경고 폭주, CDP 연결 실패, 관리자 수동 작업 충돌을 재발시키지 않도록 재개 기준을 고정한다.

## 1. 결론

`kiosk-monitor`는 아래 조건이 맞을 때만 다시 올린다.

- 운영자 수동 관리자 작업 종료
- `naver-monitor` 1~2사이클 이상 정상
- `naver-ops-mode.log`에 detached / session closed / target closed 없음
- 대기 중인 옛 텔레그램 경고 재발송이 진정됨

그 전까지는:

- `naver-monitor`만 유지
- `kiosk-monitor`는 미로드 상태 유지

## 2. 재개 전 확인

### 운영 상태

- [ ] 픽코 관리자 매출 추출 종료
- [ ] 네이버 예약관리 수동 확인 종료
- [ ] 운영자가 같은 관리자 화면을 더 이상 직접 조작하지 않음

### 서비스 상태

- [ ] `node /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js --json`
  - `naver-monitor: 정상`
  - `kiosk-monitor: 미로드`
- [ ] `/tmp/naver-ops-mode.log` 최근 10~15분 기준
  - `확인 #N` 루프 정상
  - `detached Frame` 없음
  - `Session closed` 없음
  - `Target closed` 없음
- [ ] `naver-monitor-ws.txt` / `DevToolsActivePort` 불일치 징후 없음

### 알림 상태

- [ ] 텔레그램 대기큐 재발송이 끝났거나 더 이상 경고가 쏟아지지 않음
- [ ] 성공 완료가 `⚠️ 경고`가 아니라 report/notice 성격으로 보이는지 확인 가능

## 3. 재개 방법

원칙:

- 즉시 kickstart 연쇄는 금지
- launchd 주기 실행만 사용
- 재개 직후에는 로그를 짧게 붙어서 확인

권장 순서:

1. `launchctl bootstrap gui/$(id -u) $HOME/Library/LaunchAgents/ai.ska.kiosk-monitor.plist`
   이미 로드되어 있으면 생략
2. `launchctl kickstart -k gui/$(id -u)/ai.ska.kiosk-monitor`
   단, 운영자 수동 작업이 완전히 끝난 뒤 1회만 수행
3. `/tmp/pickko-kiosk-monitor-YYYY-MM-DD.log`에서 아래를 확인
   - `CDP 연결 성공`
   - `connect ECONNREFUSED` 없음
   - `detached Frame` 없음
   - `WS 파일 없음`이면 즉시 중지 판단

## 4. 재개 직후 중지 조건

아래 중 하나라도 나오면 즉시 다시 내린다.

- `connect ECONNREFUSED`
- `Attempted to use detached Frame`
- `Session closed`
- `Target closed`
- 관리자 수동 작업 재개
- 텔레그램 경고 폭주 재발

## 5. 나중에 확장할 구조

현재는 운영 체크리스트 기반 재개가 맞다.

추후에는 아래 구조로 확장한다.

- `naver-monitor ready` 상태 파일
- `kiosk-monitor allowed` readiness gate
- 사람 세션 / 자동화 세션 분리
- `kiosk-monitor`가 WS 연결 실패 시 자동으로 self-disable 하는 rail guard
