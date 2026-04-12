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

## 7. 현재 진행 상태

- 핵심 모니터 TS 본체 승격 완료
  - `auto/monitors/naver-monitor.ts`
  - `auto/monitors/pickko-kiosk-monitor.ts`
- 주요 상시 배치 TS 본체 승격 완료
  - `auto/scheduled/pickko-daily-summary.ts`
  - `auto/scheduled/pickko-daily-audit.ts`
  - `auto/scheduled/pickko-pay-scan.ts`
- 수동 처리/리포트/admin TS 본체 승격 완료
  - `manual/reservation/pickko-accurate.ts`
  - `manual/reservation/pickko-cancel.ts`
  - `manual/reservation/pickko-query.ts`
  - `manual/reservation/pickko-register.ts`
  - `manual/reservation/pickko-cancel-cmd.ts`
  - `manual/reservation/pickko-reregister-batch.ts`
  - `manual/reports/pickko-revenue-confirm.ts`
  - `manual/reports/pickko-pay-pending.ts`
  - `manual/reports/pickko-alerts-query.ts`
  - `manual/reports/pickko-alerts-resolve.ts`
  - `manual/reports/occupancy-report.ts`
  - `manual/reports/manual-block-followup-report.ts`
  - `manual/reports/manual-block-followup-resolve.ts`
  - `manual/reports/pickko-stats-cmd.ts`
  - `manual/admin/pickko-member.ts`
  - `manual/admin/pickko-verify.ts`
  - `manual/admin/pickko-ticket.ts`

## 8. 최근 마무리

- `pickko-accurate` 분해/서비스화
  - `pickko-member-service`
  - `pickko-slot-helpers`
  - `pickko-date-service`
  - `pickko-member-selection-service`
  - `pickko-room-slot-service`
  - `pickko-payment-service`
  - `pickko-save-precheck-service`
  - `pickko-finalization-service`
- `pickko-accurate.legacy.js`는 `1814줄 -> 613줄 -> 6줄 wrapper`까지 축소
- `pickko-cancel.legacy.js`, `pickko-query.legacy.js`, `pickko-register.legacy.js`도 `6줄 wrapper`로 정리
- `pickko-pay-pending.legacy.js`, `pickko-ticket.legacy.js`도 `6줄 wrapper`로 정리
- `scripts/health-report.ts`도 실제 TS 본체로 승격
- `scripts/health-report.legacy.js`도 `6줄 wrapper`로 정리
- `lib/pickko-stats.ts`, `lib/manual-reservation.ts`도 실제 TS 본체로 승격
- `lib/pickko-stats.legacy.js`, `lib/manual-reservation.legacy.js`도 `6줄 wrapper`로 정리
- `lib/health.ts`도 실제 TS 본체로 승격
- `lib/health.legacy.js`도 `6줄 wrapper`로 정리
- `lib/pickko.ts`도 실제 TS 본체로 승격
- `lib/pickko.legacy.js`도 `6줄 wrapper`로 정리
- `lib/state-bus.legacy.js`도 `6줄 wrapper`로 정리
- `src/bug-report.ts`도 실제 TS 본체로 승격
- `src/bug-report.legacy.js`도 `6줄 wrapper`로 정리
- `scripts/collect-pickko-order-raw.ts`, `scripts/collect-pickko-order-raw-range.ts`도 실제 TS 본체로 승격
- 두 legacy 스크립트도 `6줄 wrapper`로 정리
- `scripts/dashboard-server.ts`도 실제 TS 본체로 승격
- `scripts/dashboard-server.legacy.js`도 `6줄 wrapper`로 정리
- `scripts/e2e-test.ts`도 실제 TS 본체로 승격
- `scripts/e2e-test.legacy.js`도 `6줄 wrapper`로 정리
- `migrations/001_initial_schema.ts`, `002_daily_summary_columns.ts`도 PostgreSQL 기준선 TS 본체로 정리
- 두 migration legacy도 `6줄 wrapper`로 정리
- `pickko-accurate.ts`는 실제 TS 본체로 승격

## 9. 호환 레일 상태

- `manual/**/*.ts` 기준 shim 전용 파일은 정리 완료
- reservation runtime build와 reservation 전용 typecheck는 계속 녹색
- 최근 추가 helper의 `.legacy.js` fallback은 더 이상 `.ts`를 직접 `require(...)`하지 않는다
- 대신 `ts-fallback-loader.legacy.js`를 사용해 source 모드에서도 CommonJS 호환 fallback이 가능하도록 보강했다

## 10. 다음 우선순위

1. 진행 문서/변경 범위 최종 점검
2. wrapper 예외 파일(`ts-fallback-loader.legacy.js`) 유지 정책 명시
3. 커밋 단위 정리 및 최종 리뷰

현재 잔여 예외:

- `lib/ts-fallback-loader.legacy.js`만 호환 레일 자체로 유지
- 나머지 운영/배치/수동/command 계층 legacy는 wrapper 수준으로 정리 완료

## 7. 2026-04-12 진행 현황 업데이트

### 실제 TS 구현으로 전환된 lib 상태

- `bots/reservation/**/*.legacy.js` 총 수: 129개
- 그중 `20줄 이하 wrapper`: 128개
- `20줄 초과 legacy`: 1개 (`ts-fallback-loader.legacy.js`)
- 즉 실질적인 큰 legacy 본체는 정리 완료 상태

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
  - `naver-list-scrape-service.ts`
  - `naver-session-service.ts`
  - `naver-cycle-report-service.ts`
  - `naver-booking-state-service.ts`
  - `naver-candidate-service.ts`
  - `naver-future-cancel-service.ts`
  - `naver-cancel-detection-service.ts`
  - `naver-confirmed-cycle-service.ts`
  - `naver-monitor-cycle-service.ts`
  - `naver-browser-session-service.ts`
  - `naver-detached-recovery-service.ts`
  - `naver-pickko-recovery-service.ts`
  - `naver-pickko-runner-helpers.ts`
  - `naver-pickko-runner-service.ts`
- 키오스크 모니터 helper/service:
  - `kiosk-monitor-helpers.ts`
  - `kiosk-panel-service.ts`
  - `kiosk-calendar-service.ts`
  - `kiosk-slot-calendar-service.ts`
  - `kiosk-block-flow-service.ts`
  - `kiosk-pickko-cycle-service.ts`
  - `kiosk-naver-phase-service.ts`
  - `kiosk-runtime-service.ts`
  - `kiosk-slot-runner-service.ts`
  - `kiosk-audit-service.ts`
  - `kiosk-verify-service.ts`
- 배치/리포트 helper:
- `daily-report-helpers.ts`
- `report-followup-helpers.ts`
- `pickko-stats.ts`
- `manual-reservation.ts`
- `health.ts`
- `pickko.ts`

### 실제 TS 본체 entrypoint로 승격된 상시/배치 스크립트

- `auto/monitors/naver-monitor.ts`
- `auto/monitors/pickko-kiosk-monitor.ts`
- `auto/scheduled/pickko-daily-summary.ts`
- `auto/scheduled/pickko-daily-audit.ts`
- `auto/scheduled/pickko-pay-scan.ts`
- `manual/reports/pickko-revenue-confirm.ts`
- `manual/reports/pickko-pay-pending.ts`
- `manual/reports/pickko-alerts-query.ts`
- `manual/reports/pickko-alerts-resolve.ts`
- `manual/reports/occupancy-report.ts`
- `manual/reports/manual-block-followup-report.ts`
- `manual/reports/manual-block-followup-resolve.ts`
- `manual/reports/pickko-stats-cmd.ts`
- `manual/reservation/pickko-cancel.ts`
- `manual/reservation/pickko-accurate.ts`
- `manual/reservation/pickko-query.ts`
- `manual/reservation/pickko-register.ts`
- `manual/admin/pickko-member.ts`
- `manual/admin/pickko-verify.ts`
- `manual/admin/pickko-ticket.ts`
- `lib/db.ts`
- `lib/vip.ts`
- `lib/pickko-member-service.ts`
- `lib/pickko-slot-helpers.ts`
- `lib/pickko-payment-service.ts`
- `lib/pickko-date-service.ts`
- `lib/pickko-member-selection-service.ts`
- `lib/pickko-room-slot-service.ts`
- `lib/pickko-finalization-service.ts`
- `lib/pickko-save-precheck-service.ts`

### 현재 모니터 본체 상태

- `auto/monitors/naver-monitor.ts`: 실제 TS 본체 entrypoint 확보
- `auto/monitors/pickko-kiosk-monitor.ts`: 실제 TS 본체 entrypoint 확보

legacy 본체 라인 수:

- `naver-monitor.legacy.js`: 6 lines
- `pickko-kiosk-monitor.legacy.js`: 6 lines

TS 본체 라인 수:

- `naver-monitor.ts`: 614 lines
- `pickko-kiosk-monitor.ts`: 475 lines

### 현재 배치 본체 상태

TS 본체 라인 수:

- `pickko-daily-summary.ts`: 216 lines
- `pickko-daily-audit.ts`: 172 lines
- `pickko-pay-scan.ts`: 192 lines

### 현재 수동 리포트 본체 상태

TS 본체 라인 수:

- `pickko-revenue-confirm.ts`: 60 lines
- `pickko-pay-pending.ts`: 388 lines
- `pickko-pay-pending.legacy.js`: 6 lines
- `pickko-alerts-query.ts`: 실제 TS 본체 entrypoint 확보
- `pickko-alerts-resolve.ts`: 실제 TS 본체 entrypoint 확보
- `occupancy-report.ts`: 실제 TS 본체 entrypoint 확보

### 현재 수동 처리 본체 상태

TS 본체 라인 수:

- `pickko-cancel.ts`: 414 lines
- `pickko-accurate.ts`: 548 lines

legacy 잔여 대형 파일:

- `pickko-accurate.legacy.js`: 6 lines

manual/admin 잔여 shim:

- 대형 admin 진입점은 `pickko-member / pickko-verify / pickko-ticket`까지 TS 본체 entrypoint 확보
- `pickko-ticket.legacy.js`: 6 lines

### 현재 scripts 본체 상태

- `health-report.ts`: 497 lines
- `health-report.legacy.js`: 6 lines
- `health-check.ts`, `log-rotate.ts`, `backup-db.ts`, `migrate.ts`, `preflight.ts`도 실제 TS 본체 승격 완료
- `show-auth.ts`도 실제 TS 본체 승격 완료

### DB 기준선 상태

- `db.ts`: 실제 TS source of truth로 승격 완료
- `db.legacy.js`: 6 lines
- reservation 코드 기준 `getDb()` 참조 제거 완료
- `vip.ts`: async Postgres 조회 기반으로 전환 완료

최근 분리 완료:

- `pickko-member-service.ts`
  - `notifyMemberNameMismatch`
  - `registerNewMember`
- `pickko-slot-helpers.ts`
  - `timeToSlots`
  - `buildSlotCandidates`
  - `adjustEffectiveTimeSlots`
- `pickko-payment-service.ts`
  - 결제 모달 입력/검증/제출/확인
- `pickko-date-service.ts`
  - 날짜 설정/검증
- `pickko-member-selection-service.ts`
  - 회원 검색
  - 회원 선택/검증
  - 신규 회원 등록 후 재검색
- `pickko-room-slot-service.ts`
  - 룸 탭 선택
  - 스케줄 준비 대기
  - 시간표 스크롤
  - 슬롯 후보 순차 선택
  - 동일 고객 기존 등록 감지
- `pickko-finalization-service.ts`
  - 저장 직후 예약 정보 추출
  - 회원/룸/날짜 비교 검증
  - 최종 완료 상태 판독
- `pickko-save-precheck-service.ts`
  - 저장 직전 시간/금액 sanity check
  - 작성하기 제출/fallback

하지만 핵심 차이는 “라인 수”보다 “무슨 블록이 이미 바깥으로 빠졌는가”다.

#### naver-monitor에서 이미 분리된 것

- monitor helper
- reservation helper
- alert helper
- alert service
- list scrape service
- session service
- cycle report service
- booking state service
- candidate service
- future cancel service
- cancel detection service
- confirmed cycle service
- monitor cycle service
- browser session service
- detached recovery service
- pickko recovery service
- pickko runner helper
- pickko runner service

즉 `naver-monitor`는 이미 “알림/취소감지/복구/픽코 실행/사이클 처리” 대부분이 서비스화됐다.

#### pickko-kiosk-monitor에서 이미 분리된 것

- kiosk helper
- panel service
- calendar service
- slot calendar service
- block flow service
- pickko cycle service
- naver phase service
- runtime service
- block-slot service
- unblock-slot service
- audit-today service
- verify service

즉 `kiosk-monitor`는 “캘린더 조작 + 차단/해제 상위 흐름 + 단독 운영 모드 + 검증 배치”가 거의 전부 서비스 위임 구조다.

### 남은 큰 legacy 면적

#### naver-monitor

여전히 legacy 본체에 남은 것:

- 호환 wrapper
- 기존 실행 진입 호환 레일

판단:

- 이제 실질 본체는 `naver-monitor.ts`로 올라왔다.
- 다음 단계는 legacy 본체를 더 얇은 호환 wrapper 수준으로 줄이고, launchd/운영 smoke를 붙여 안정성을 확인하는 일이다.

#### pickko-kiosk-monitor

여전히 legacy 본체에 남은 것:

- 호환 wrapper
- 기존 실행 진입 호환 레일

판단:

- 이제 실질 본체는 `pickko-kiosk-monitor.ts`로 올라왔다.
- 다음 단계는 legacy 본체를 더 얇은 호환 wrapper 수준으로 줄이고, launchd/운영 smoke를 붙여 안정성을 확인하는 일이다.

## 8. 다음 권장 순서

### 추천 A. 본체 승격 이후 정리

1. 두 모니터의 legacy 본체를 더 얇은 호환 wrapper 수준으로 축소
2. launchd kickstart + 최근 로그 확인으로 운영 smoke를 추가
3. 이후 마지막 대형 수동 처리 CLI인 `pickko-accurate`를 단계 분리 후 실제 TS 본체 승격

장점:

- 현재 만든 helper/service 자산을 가장 잘 재사용함
- 상시 운영 축 2개를 같은 구조로 맞춘 뒤 배치 축으로 넘어갈 수 있음
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

- 모니터 본체 TS 승격 마무리: 0.5~1.5일
- 수동 처리/CLI 계열 정리: 1~2일
- 최종 legacy 축소와 진입점 정리: 1일+

즉 “스카팀을 루나/블로그팀과 유사한 운영 구조로 맞추는 일”은 이미 중반을 넘겼고,
지금은 helper 전환보다 “얇은 legacy orchestrator를 TS 본체로 승격”하는 단계가 중심이다.

### 총 추정

- 빠른 최단: 4~6일
- 운영 안정 포함 현실치: 5~8일

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

## 10. 바로 다음 액션

추천 시작점:

1. `pickko-kiosk-monitor`의 `verifyBlockStateInFreshPage` / `verifySlotOnly` 추출
2. `naver-monitor`의 `monitorBookings` TS 본체 승격 범위 결정
3. 그다음 모니터 둘의 legacy 본체를 300줄 이하 wrapper 수준으로 축소

이유:

- 지금까지 쌓은 service/helper 자산을 가장 잘 활용할 수 있음
- 운영 경로를 끊지 않으면서 “실질 TS 전환율”을 빠르게 끌어올릴 수 있음
- 이제는 작은 helper보다 본체 승격이 전환 체감에 더 크게 기여함
