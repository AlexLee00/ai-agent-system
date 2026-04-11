# Ska TS Conversion Plan

작성일: 2026-04-12

## 1. 현재 상태 진단

- 스카팀 실제 소스는 `bots/reservation` 기준으로 운영된다.
- 파일 구조는 이미 `3중 패턴`이 깔려 있다.
  - `.legacy.js` = 실제 운영 원본
  - `.ts` = 현재는 대부분 shim
  - `.js` = `dist/ts-runtime` 우선 + `.legacy.js` 폴백 래퍼

### 계량 결과

- `.legacy.js`: 86개
- `.ts`: 91개
- `.js`: 91개
- `full trio(.legacy.js + .ts + .js)`: 86개
- `ts-only 추가 파일`: 5개

### 가장 중요한 발견

- `.ts` 91개 전부가 아직 `@ts-nocheck + require('./xxx.legacy.js')` 4줄 shim이다.
- 즉 스카팀은 “TS가 이미 많이 됐다”가 아니라 “TS 진입점 껍데기만 마련된 상태”다.
- 따라서 바로 `.legacy.js`를 지우거나 `.ts`를 런타임 진실(source of truth)로 바꾸면 위험하다.

## 2. 다른 팀에서 가져올 원칙

### 블로그팀에서 가져올 것

- `Phase 1 → 2 → 3` 순차 전환
- `__dirname`, 경로, 실행 진입점 먼저 정리
- 핵심 파이프라인을 먼저 옮기고 보조 모듈은 뒤로 미루기
- `.legacy.js`는 안정화 전까지 유지

### 루나팀에서 가져올 것

- `.legacy.js` 원본을 건드리지 않고 `.ts` 실전환으로 채우기
- 전환 전에 `tsconfig`와 baseline을 먼저 세우기
- “파일 수”보다 의존성 순서(shared/core -> pipeline -> scripts)로 움직이기

## 3. 스카팀에 맞는 안전한 전략

스카팀은 실시간 예약 운영 + launchd + Puppeteer + Postgres + 텔레그램 경로가 얽혀 있어서
블로그팀보다 더 보수적으로 가야 한다.

### 핵심 원칙

1. `.legacy.js`는 Phase 3 전까지 유지
2. 런타임은 계속 `.js wrapper -> dist -> legacy fallback`
3. 한 번에 대량 전환하지 않고, “도메인 묶음” 단위로 전환
4. 각 묶음마다
   - typecheck
   - 문법 체크
   - smoke test
   - launchd 영향 확인
   를 반드시 수행

## 4. 작업 범위 분해

### A. 기초 라이브러리

대상: 31개

- `lib/*`
- 공통 유틸, DB, 포맷, 텔레그램, 상태, browser/pickko, command queue

난이도:

- 높음
- 거의 모든 운영 스크립트와 모니터가 의존

우선순위:

- 최우선

### B. 상시 운영 엔진

대상: 5개 핵심

- `auto/monitors/naver-monitor`
- `auto/monitors/pickko-kiosk-monitor`
- `auto/scheduled/pickko-daily-summary`
- `auto/scheduled/pickko-daily-audit`
- `auto/scheduled/pickko-pay-scan`

난이도:

- 최고
- launchd 상시 운영 경로

우선순위:

- lib 안정화 후

### C. 수동 처리 CLI

대상: 17개

- `manual/admin/*`
- `manual/reports/*`
- `manual/reservation/*`

난이도:

- 중간
- 운영상 중요하지만 상시 감시보다 회귀 위험이 낮음

### D. 배치/보조 스크립트

대상: 15개

- `scripts/*`
- `src/*`
- `n8n/*`
- `migrations/*`

난이도:

- 낮음~중간
- smoke test로 빠르게 확인 가능

## 5. 추천 Phase

### Phase 0. 기준선 고정

목표:

- 스카팀 전용 `tsconfig` 추가
- baseline typecheck
- 주요 launchd/운영 smoke test 목록 고정

산출물:

- `bots/reservation/tsconfig.json`
- 현재 문서

### Phase 1. lib 실전환

대상:

- `lib/args`
- `lib/cli`
- `lib/formatting`
- `lib/utils`
- `lib/status`
- `lib/runtime-config`
- `lib/secrets`
- `lib/alert-client` (`mainbot-client`는 호환 alias만 유지)
- `lib/telegram`
- `lib/error-tracker`

이유:

- 상대적으로 작고 테스트 가능
- 운영 전 구간이 이 레일을 탄다

테스트:

- `tsc -p bots/reservation/tsconfig.json --noEmit`
- `node --check` 대상 파일
- 예약 알림 topic 발행 smoke

예상 소요:

- 0.5~1.5일

### Phase 2. DB/브라우저/픽코 핵심 lib

대상:

- `lib/db`
- `lib/browser`
- `lib/pickko`
- `lib/health`
- `lib/ska-command-handlers`
- `lib/ska-command-queue`
- `lib/ska-read-service`

이유:

- 상시 운영 엔진 전환 전 필수 기반

테스트:

- typecheck
- DB helper 호출 smoke
- 스카 커맨더 재기동 확인

예상 소요:

- 1.5~2.5일

### Phase 3. 상시 운영 엔진

대상:

- `naver-monitor`
- `pickko-kiosk-monitor`
- `pickko-daily-summary`
- `pickko-daily-audit`
- `pickko-pay-scan`

이유:

- 운영 영향 최대

테스트:

- 파일별 `node --check`
- launchd kickstart
- 최근 로그 확인
- topic 알림 smoke

예상 소요:

- 2~4일

### Phase 4. 수동 처리/리포트 CLI

대상:

- `pickko-register`
- `pickko-cancel`
- `pickko-accurate`
- `pickko-revenue-confirm`
- `pickko-pay-pending`
- 기타 manual/report/admin scripts

예상 소요:

- 1~2일

### Phase 5. 보조 스크립트와 legacy 정리

대상:

- `scripts/*`
- `src/*`
- `migrations/*`
- `n8n/*`

조건:

- 최소 며칠 안정 운영 후

예상 소요:

- 1일+

## 6. 작업량 추정

안전하게 보면:

- Phase 0: 반나절
- Phase 1: 0.5~1.5일
- Phase 2: 1.5~2.5일
- Phase 3: 2~4일
- Phase 4: 1~2일
- Phase 5: 1일+

## 7. 2026-04-12 진행 현황 업데이트

### 실제 TS 구현으로 전환된 lib 수

- `bots/reservation/lib/*.ts` 기준 실구현 파일: 44개
- 단순 shim이 아니라 helper/service/facade 역할을 하는 TS 파일이 이미 꽤 넓게 올라왔다.

대표 전환 축:

- 알림/발행:
  - `alert-client.ts`
  - `telegram.ts`
  - `reporter.ts`
- 운영 공통:
  - `mode.ts`
  - `runtime-config.ts`
  - `status.ts`
  - `secrets.ts`
  - `state-bus.ts`
- DB/중간층:
  - `db.ts`
  - `browser.ts`
  - `ska-read-service.ts`
  - `error-tracker.ts`
  - `crypto.ts`
  - `validation.ts`
  - `study-room-pricing.ts`
- 예약 모니터 helper/service:
  - `naver-monitor-helpers.ts`
  - `naver-reservation-helpers.ts`
  - `naver-alert-helpers.ts`
  - `naver-monitor-service.ts`
  - `naver-pickko-recovery-service.ts`
  - `naver-pickko-runner-helpers.ts`
  - `naver-pickko-runner-service.ts`
- 키오스크 모니터 helper/service:
  - `kiosk-monitor-helpers.ts`
  - `kiosk-slot-runner-service.ts`
  - `kiosk-audit-service.ts`
- 배치/리포트 helper:
  - `daily-report-helpers.ts`
  - `report-followup-helpers.ts`

### 현재 모니터 본체 상태

- `auto/monitors/naver-monitor.ts`: TS entrypoint 확보
- `auto/monitors/pickko-kiosk-monitor.ts`: TS entrypoint 확보

legacy 본체 라인 수:

- `naver-monitor.legacy.js`: 약 1980 lines
- `pickko-kiosk-monitor.legacy.js`: 약 2671 lines

하지만 핵심 차이는 “라인 수”보다 “무슨 블록이 이미 바깥으로 빠졌는가”다.

#### naver-monitor에서 이미 분리된 것

- monitor helper
- reservation helper
- alert helper
- alert service
- pickko recovery service
- pickko runner helper
- pickko runner service

즉 `runPickkoCancel`, `runPickko`, 미해결 알림/오류 해결/발행 로직은 이미 서비스화됐다.

#### pickko-kiosk-monitor에서 이미 분리된 것

- kiosk helper
- block-slot service
- unblock-slot service
- audit-today service

즉 단독 운영 모드와 일일 검증 배치는 이미 서비스 위임 구조로 전환됐다.

### 남은 큰 legacy 면적

#### naver-monitor

여전히 본체에 큰 비중으로 남은 것:

- `naverLogin`
- `closePopupsIfPresent`
- `monitorBookings`
- `scrapeExpandedCancelled`
- `scrapeNewestBookingsFromList`
- `updateBookingState`
- `rollbackProcessingEntries`
- `ragSaveReservation`

판단:

- 이제 이 파일은 “픽코 실행/알림”보다 “브라우저 상호작용 + 모니터링 사이클” 중심으로 남아 있다.
- 다음 TS 본체 후보는 `monitorBookings` 보조 루프 분리 또는 `scrape*` 계열 추출이다.

#### pickko-kiosk-monitor

여전히 본체에 큰 비중으로 남은 것:

- `naverBookingLogin`
- `blockNaverSlot`
- `unblockNaverSlot`
- `selectBookingDate`
- `clickRoomAvailableSlot`
- `clickRoomSuspendedSlot`
- `fillUnavailablePopup`
- `fillAvailablePopup`
- `selectUnavailableStatus`
- `selectAvailableStatus`
- `verifyBlockInGrid`
- `main`
- `verifyBlockStateInFreshPage`
- `verifySlotOnly`

판단:

- 이 파일은 이제 “네이버 캘린더 조작 DSL”과 “상시 루프 orchestration”이 남은 상태다.
- 다음 TS 본체 후보는 `verifyBlockStateInFreshPage` + `verifySlotOnly`를 먼저 옮기고, 그다음 `main()`과 캘린더 조작 함수군을 별도 service로 나누는 것이다.

## 8. 다음 권장 순서

### 추천 A. 본체 service 추가 분해

1. `naver-monitor`의 `scrapeExpandedCancelled` / `scrapeNewestBookingsFromList` 추출
2. `kiosk-monitor`의 `verifyBlockStateInFreshPage` / `verifySlotOnly` 추출
3. 이후 각 모니터의 `main loop` 또는 `monitorBookings`를 service로 감싸기

장점:

- 현재 만든 helper/service 자산을 가장 잘 재사용함
- 운영 리스크가 낮음
- 실제 legacy 면적 감소가 눈에 띄게 진행됨

### 추천 B. TS 본체 승격 준비

1. monitor `.ts` entry에서 의존성 wiring 전담
2. legacy 본체는 점점 pure service 조립체로 축소
3. 최종적으로 `.legacy.js`는 얇은 호환 레이어로만 남기기

장점:

- 루나팀/블로그팀 구조와 가장 비슷해짐

## 9. 현재 기준 소요 재산정

초기 추정보다 진행이 빨랐던 이유:

- helper/service 단위로 자르면서 상시 운영 코드도 안전하게 눌러갈 수 있었음
- `tsconfig + reservation runtime build` 레일이 빨리 안정화됨

현재 남은 체감 소요:

- 모니터 본체 추가 service 분해: 1~2일
- 수동 처리/CLI 계열 정리: 1~2일
- 최종 legacy 축소와 진입점 정리: 1일+

즉 “스카팀을 루나/블로그팀과 유사한 운영 구조로 맞추는 일”은 이미 중반을 넘겼고,
이제부터는 helper 전환보다 본체 orchestration 재배치가 중심이 된다.

### 총 추정

- 빠른 최단: 6일 전후
- 운영 안정 포함 현실치: 7~10일

## 7. 테스트 레일

각 Phase 공통:

1. `./node_modules/.bin/tsc -p bots/reservation/tsconfig.json --noEmit`
2. 수정 파일 `node --check`
3. 관련 launchd 재기동
4. 최근 로그 tail 확인
5. 스카 topic 알림 smoke

### 운영 핵심 smoke 대상

- `ai.ska.commander`
- `ai.ska.naver-monitor`
- `ai.ska.kiosk-monitor`
- `ai.ska.pickko-daily-summary`
- `ai.ska.pickko-daily-audit`
- `ai.ska.pickko-pay-scan`

### 기능 smoke 대상

- 예약 알림 topic 발행
- 매출 확정 리포트
- 수동 처리 알림
- 오늘 예약 조회

## 8. 바로 다음 액션

추천 시작점:

1. Phase 0 기준선 확정
2. Phase 1에서 `lib`의 작은 파일부터 실전환
3. `alert-client`, `telegram`, `formatting`, `utils`부터 시작

이유:

- 최근 우리가 직접 만진 파일이라 동작을 이미 파악하고 있음
- 알림/리포트/포맷 영향이 커서 전환 효과를 바로 확인 가능
- 실패해도 rollback 범위가 좁음
