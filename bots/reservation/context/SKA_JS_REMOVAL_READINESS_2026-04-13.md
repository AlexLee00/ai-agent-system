# Ska Reservation JS Removal Readiness (2026-04-13)

## 결론

`bots/reservation`는 **TS source of truth** 및 **TS-only typecheck** 상태까지는 완료됐다.
하지만 `.js` / `.legacy.js` 파일은 아직 단순 잔재가 아니라, 실제 런타임 엔트리와 cross-team import 호환 레일로 사용 중이다.

따라서 현재 단계에서 `bots/reservation/**/*.js`를 일괄 삭제하면 안 된다.

## 현재 상태

- `bots/reservation/**/*.ts`: 133개
- `@ts-nocheck`: 0개
- reservation `tsc --noEmit`: 통과
- reservation runtime build: 통과
- source legacy wrapper fallback: 복구 완료

## 아직 `.js`를 유지해야 하는 이유

초기 전환 시점에는 launchd, shell wrapper, cross-team import가 reservation 내부 wrapper `.js`를 직접 사용하고 있었다.
하지만 현재는 대부분 `dist/ts-runtime/.../*.js` 직결로 옮겨졌고, 남은 `.js`는 주로 아래 세 부류로 압축됐다.

### 1. wrapper 자기 자신

남아 있는 source `.js`는 대부분 “실행 주체”라기보다 `dist/ts-runtime`를 호출하는 얇은 호환 wrapper다.
삭제 대상은 현재 코드/운영 표면과 연결이 끊긴 source wrapper부터 순차적으로 진행하면 된다.

### 2. 현재 운영 엔트리로 남아 있는 dist `.js`

launchd, shell wrapper, package script, registry, cross-team caller는 이제 reservation source wrapper가 아니라
대체로 `dist/ts-runtime/.../*.js`를 직접 본다.

즉 지금 단계에서 바로 지워도 되는 대상은 “source wrapper”인지, 아니면 “실제 dist 런타임 파일명”인지 구분해서 봐야 한다.

### 3. 역사/운영 문서 표기

`HANDOFF`, `DEV_SUMMARY`, `CLAUDE_NOTES`, 일부 checklist는 당시 작업명을 그대로 유지하기 위해 `.js` 표기를 계속 담고 있다.
이들은 삭제 blocker라기보다 기록성 잔존이다.

## 분류

### A. 삭제 준비 완료에 가까움 (source wrapper)

아래 source wrapper 1차 배치는 실제 삭제까지 완료했다.

- `scripts/health-check.js`
- `scripts/dashboard-server.js`
- `scripts/backup-db.js`
- `scripts/log-rotate.js`
- `auto/scheduled/pickko-daily-summary.js`

### B. 아직 보류 (남은 현재 코드/운영 참조 있음)

- 일부 `manual/admin`, `manual/reservation`, `scripts`, `lib` source wrapper
  - 삭제보다 “호환 레일 유지” 이득이 아직 있는 것들
- `.legacy.js`
  - source fallback과 CommonJS 호환 레일 역할이 남아 있음

### C. 기록성 `.js` 표기

문서와 checklist의 `.js` 표기는 여전히 많다.
이는 삭제 blocker는 아니지만, “지금도 source wrapper를 운영이 직접 쓴다”는 오해를 만들 수 있으므로 마지막에 정리 가치가 있다.

## 추천 삭제 순서

1. **cross-team import 제거**
   - `bots/blog/lib/blo.ts` -> `dist` 또는 공식 런타임 엔트리로 교체
   - `bots/orchestrator/src/router.ts` -> `dist` 또는 새 런타임 엔트리로 교체
   - `bots/registry.json` 엔트리 정책 정리

2. **shell wrapper 제거**
   - `run-verify.sh`
   - `pickko-register.ts`
   - `pickko-reregister-batch.ts`
   - `pickko-cancel-cmd.ts`

3. **launchd plist 전환**
   - 먼저 저위험 스크립트부터
     - `health-check`
     - `dashboard-server`
     - `backup-db`
     - `log-rotate`
   - 그 다음 예약 배치/모니터
     - `pickko-daily-summary`
     - `pickko-daily-audit`
     - `pickko-pay-scan`
     - `pickko-verify`
     - `naver-monitor`
     - `pickko-kiosk-monitor`

4. **마지막에 wrapper 제거**
   - `.js`
   - `.legacy.js`
   - 단, `ts-fallback-loader.legacy.js`는 마지막 호환 레일까지 끝난 뒤 판단

## live LaunchAgents 동기화 완료

아래 실제 `~/Library/LaunchAgents` 4개도 repo 템플릿과 동일하게 동기화했다.

- `ai.ska.health-check.plist`
- `ai.ska.dashboard.plist`
- `ai.ska.db-backup.plist`
- `ai.ska.log-rotate.plist`

검증:
- plist lint 통과
- live LaunchAgent 파일이 `dist/ts-runtime` 경로를 직접 가리킴
- 아직 `launchctl bootout/load` 재적용은 하지 않음

## 1차 전환 완료

아래 repo launchd 템플릿 4개는 wrapper `.js`가 아니라 `dist/ts-runtime`를 직접 보도록 전환했다.

- `bots/reservation/launchd/ai.ska.health-check.plist`
- `bots/reservation/launchd/ai.ska.dashboard.plist`
- `bots/reservation/launchd/ai.ska.db-backup.plist`
- `bots/reservation/launchd/ai.ska.log-rotate.plist`

검증:
- plist lint 통과
- dist runtime 경로 반영 확인

## 2차 전환 완료

아래 운영 배치 shell wrapper 4개는 wrapper `.js`가 아니라 `dist/ts-runtime`를 직접 보도록 전환했다.

- `bots/reservation/auto/scheduled/run-daily-summary.sh`
- `bots/reservation/auto/scheduled/run-audit.sh`
- `bots/reservation/auto/scheduled/run-pay-scan.sh`
- `bots/reservation/manual/admin/run-verify.sh`

검증:
- shell syntax check 통과
- dist runtime 경로 반영 확인

## 3차 전환 완료

아래 cross-team direct reference 2개는 reservation wrapper `.js`가 아니라 `dist/ts-runtime`를 직접 보도록 전환했다.

- `bots/blog/lib/blo.ts` -> `dist/ts-runtime/bots/reservation/lib/state-bus.js`
- `bots/orchestrator/src/router.ts` -> `dist/ts-runtime/bots/reservation/scripts/health-report.js`

검증:
- `bots/blog` 타입체크 통과
- `bots/orchestrator/src/router.ts` syntax check 통과

## 4차 전환 완료

아래 reservation 내부 실행 경로 4개는 monitor/runtime wrapper `.js` 대신 `dist/ts-runtime`를 직접 보도록 전환했다.

- `bots/reservation/scripts/reload-monitor.sh`
- `bots/reservation/auto/monitors/start-ops.sh`
- `bots/reservation/scripts/manual-batch-reserve.ts`
- `bots/reservation/manual/reservation/pickko-register.ts`

검증:
- shell syntax check 통과
- reservation 타입체크 통과
- dist runtime 경로 반영 확인

## 5차 전환 완료

모니터 실행 레일까지 `dist/ts-runtime` 직결로 정리됐다.

- `bots/reservation/auto/monitors/start-ops.sh` -> `dist/ts-runtime/.../naver-monitor.js`
- `bots/reservation/auto/monitors/run-kiosk-monitor.sh` -> `dist/ts-runtime/.../pickko-kiosk-monitor.js`

검증:
- shell syntax check 통과
- dist monitor runtime 경로 반영 확인

## 6차 전환 완료

메타/레지스트리 계층도 현재 런타임 구조에 맞게 정리했다.

- `bots/registry.json`
  - `andy.file` -> `dist/ts-runtime/bots/reservation/auto/monitors/naver-monitor.js`
  - `jimmy.file` -> `dist/ts-runtime/bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - `ops.startScript` -> 실제 경로인 `bots/reservation/auto/monitors/start-ops.sh`

검증:
- `bots/registry.json` JSON validation 통과
- dist runtime / startScript 경로 반영 확인

## 현재 추천 단계

이제 남은 작업은 “전환”보다 “삭제 배치 설계”에 가깝다.

1. 저위험 source wrapper 1차 삭제 후보 확정
   - `scripts/health-check.js`
   - `scripts/dashboard-server.js`
   - `scripts/backup-db.js`
   - `scripts/log-rotate.js`
   - `auto/scheduled/pickko-daily-summary.js`
2. 운영 민감 wrapper는 별도 배치로 유지
   - `manual/admin/*.js`
   - `auto/monitors/*.js`
3. 역사 문서 `.js` 표기는 필요 시 후속 정리

즉 reservation JS 제거 준비는 이제 “삭제 가능한 wrapper를 실제로 어떤 순서로 걷을지”만 남은 상태에 가깝다.

## 1차 삭제 완료

다음 source wrapper 5개는 실제로 제거했다.

- `bots/reservation/scripts/health-check.js`
- `bots/reservation/scripts/dashboard-server.js`
- `bots/reservation/scripts/backup-db.js`
- `bots/reservation/scripts/log-rotate.js`
- `bots/reservation/auto/scheduled/pickko-daily-summary.js`

검증:
- reservation `tsc --noEmit` 통과
- reservation runtime build 통과
- 현재 참조는 주로 `dist/ts-runtime/...` 또는 역사 문서 표기로 압축됨

## 모니터 runtime blocker 추가 정리

모니터 wrapper 삭제를 막던 shell runtime 2곳도 `dist/ts-runtime` 직결로 정리했다.

- `bots/reservation/auto/monitors/start-ops.sh`
- `bots/reservation/auto/monitors/run-today-audit.sh`

정리 내용:
- `start-ops.sh`는 더 이상 상대경로 `naver-monitor.js`를 실행하지 않고
  `dist/ts-runtime/.../naver-monitor.js`를 직접 실행한다.
- `run-today-audit.sh`도 더 이상 `pickko-kiosk-monitor.js` wrapper를 직접 호출하지 않고
  `dist/ts-runtime/.../pickko-kiosk-monitor.js --audit-today`를 직접 실행한다.

## 2차 삭제 완료

다음 source wrapper 3개도 실제로 제거했다.

- `bots/reservation/manual/admin/pickko-verify.js`
- `bots/reservation/auto/monitors/naver-monitor.js`
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`

정리 배경:
- `run-verify.sh`, startup verify, registry, package script, monitor shell runner, launchd template이 모두
  source wrapper 대신 `dist/ts-runtime/...`를 직접 보도록 정리된 뒤 삭제했다.

## 3차 삭제 완료

다음 `manual/reports` source wrapper 8개도 실제로 제거했다.

- `bots/reservation/manual/reports/manual-block-followup-report.js`
- `bots/reservation/manual/reports/manual-block-followup-resolve.js`
- `bots/reservation/manual/reports/occupancy-report.js`
- `bots/reservation/manual/reports/pickko-alerts-query.js`
- `bots/reservation/manual/reports/pickko-alerts-resolve.js`
- `bots/reservation/manual/reports/pickko-pay-pending.js`
- `bots/reservation/manual/reports/pickko-revenue-confirm.js`
- `bots/reservation/manual/reports/pickko-stats-cmd.js`

정리 배경:
- `bots/orchestrator/src/router.ts`
- `bots/reservation/auto/scheduled/pickko-pay-scan.ts`
- `bots/reservation/manual/reservation/pickko-accurate.ts`
- `bots/reservation/src/test-nlp-e2e.ts`

위 현재 코드 경로들이 모두 source wrapper 대신 `dist/ts-runtime/...`를 직접 보도록 정리된 뒤 삭제했다.

## 4차 삭제 완료

다음 `manual/admin` source wrapper 2개도 실제로 제거했다.

- `bots/reservation/manual/admin/pickko-member.js`
- `bots/reservation/manual/admin/pickko-ticket.js`

정리 배경:
- operator/docs 표면과 도움말 문자열을 `dist/ts-runtime/...` 또는 `.ts` source of truth 기준으로 정리한 뒤 삭제했다.

## 5차 삭제 완료

다음 `manual/reservation` source wrapper 6개도 실제로 제거했다.

- `bots/reservation/manual/reservation/pickko-accurate.js`
- `bots/reservation/manual/reservation/pickko-cancel-cmd.js`
- `bots/reservation/manual/reservation/pickko-cancel.js`
- `bots/reservation/manual/reservation/pickko-query.js`
- `bots/reservation/manual/reservation/pickko-register.js`
- `bots/reservation/manual/reservation/pickko-reregister-batch.js`

정리 배경:
- `bots/reservation/lib/manual-reservation.ts`
- `bots/reservation/lib/manual-cancellation.ts`
- `bots/reservation/manual/reservation/pickko-register.ts`
- `bots/reservation/manual/reservation/pickko-cancel-cmd.ts`
- `bots/reservation/manual/reservation/pickko-reregister-batch.ts`
- `bots/reservation/manual/admin/pickko-verify.ts`

위 현재 코드 경로들이 모두 source wrapper 대신 `dist/ts-runtime/...`를 직접 보도록 정리된 뒤 삭제했다.

## 6차 삭제 완료

다음 `scripts` source wrapper 5개도 실제로 제거했다.

- `bots/reservation/scripts/health-report.js`
- `bots/reservation/scripts/preflight.js`
- `bots/reservation/scripts/e2e-test.js`
- `bots/reservation/scripts/collect-pickko-order-raw.js`
- `bots/reservation/scripts/collect-pickko-order-raw-range.js`

정리 배경:
- `scripts/reviews/daily-ops-report.ts`
- `bots/reservation/auto/monitors/start-ops.sh`
- `bots/reservation/scripts/deploy-ops.sh`
- `bots/reservation/scripts/collect-pickko-order-raw-range.ts`

위 현재 코드 경로들이 모두 source wrapper 대신 `dist/ts-runtime/...`를 직접 보도록 정리된 뒤 삭제했다.

## 7차 삭제 완료

다음 `auto/scheduled` source wrapper 2개도 실제로 제거했다.

- `bots/reservation/auto/scheduled/pickko-daily-audit.js`
- `bots/reservation/auto/scheduled/pickko-pay-scan.js`

정리 배경:
- 예약 배치 실행은 이미 `run-audit.sh`, `run-pay-scan.sh`, launchd 템플릿에서
  source wrapper 대신 `dist/ts-runtime/...`를 직접 보도록 정리돼 있었다.

## 8차 삭제 완료

다음 `lib` 유틸 source wrapper 11개도 실제로 제거했다.

- `bots/reservation/lib/args.js`
- `bots/reservation/lib/cli.js`
- `bots/reservation/lib/files.js`
- `bots/reservation/lib/formatting.js`
- `bots/reservation/lib/mode.js`
- `bots/reservation/lib/reservation-key.js`
- `bots/reservation/lib/runtime-config.js`
- `bots/reservation/lib/status.js`
- `bots/reservation/lib/study-room-pricing.js`
- `bots/reservation/lib/utils.js`
- `bots/reservation/lib/validation.js`

정리 배경:
- 현재 코드 기준 직접 실행/직접 참조는 대부분 `dist/ts-runtime/...` 또는 `.legacy.js` fallback 레일로 이동한 상태였고,
  남아 있던 source `.js`는 얇은 dist passthrough wrapper 역할만 하고 있었다.

## 9차 삭제 완료

다음 `migrations`/`n8n` source wrapper 10개도 실제로 제거했다.

- `bots/reservation/migrations/001_initial_schema.js`
- `bots/reservation/migrations/002_daily_summary_columns.js`
- `bots/reservation/migrations/003_agent_state.js`
- `bots/reservation/migrations/004_agent_events_tasks.js`
- `bots/reservation/migrations/005_pickko_order_raw.js`
- `bots/reservation/migrations/006_kiosk_block_attempts.js`
- `bots/reservation/migrations/007_kiosk_block_key_v2.js`
- `bots/reservation/migrations/008_pickko_order_raw_cleanup.js`
- `bots/reservation/migrations/009_daily_summary_remove_pickko_total.js`
- `bots/reservation/n8n/setup-ska-command-workflow.js`

정리 배경:
- reservation migration 실행은 이미 `scripts/migrate.ts`와 `dist/ts-runtime/.../migrations/*.js` 기준으로 동작하고 있었다.
- reservation n8n setup 실행도 이미 `package.json`과 운영 문서에서 `dist/ts-runtime/.../setup-ska-command-workflow.js`를 직접 보도록 정리돼 있었다.

## 10차 삭제 완료

다음 `scripts` source wrapper 8개도 실제로 제거했다.

- `bots/reservation/scripts/audit-duplicate-slots.js`
- `bots/reservation/scripts/audit-pickko-general-direct.js`
- `bots/reservation/scripts/check-n8n-command-path.js`
- `bots/reservation/scripts/export-ska-sales-csv.js`
- `bots/reservation/scripts/manual-batch-reserve.js`
- `bots/reservation/scripts/migrate.js`
- `bots/reservation/scripts/pickko-revenue-backfill.js`
- `bots/reservation/scripts/test-kiosk-block-key-v2.js`

정리 배경:
- 현재 package/skill/operator 경로는 이미 `dist/ts-runtime/...`를 직접 보도록 정리돼 있었다.
- 남아 있던 source `.js`는 얇은 dist passthrough wrapper 역할만 하고 있었다.

## 11차 삭제 완료

다음 `src`/top-level 진단 source wrapper 9개도 실제로 제거했다.

- `bots/reservation/src/analyze-booking-page.js`
- `bots/reservation/src/backfill-study-room.js`
- `bots/reservation/src/check-naver.js`
- `bots/reservation/src/get-naver-html.js`
- `bots/reservation/src/init-naver-booking-session.js`
- `bots/reservation/src/inspect-naver.js`
- `bots/reservation/src/test-kiosk-register.js`
- `bots/reservation/src/test-nlp-e2e.js`
- `bots/reservation/show-auth.js`

정리 배경:
- 현재 실행 예시와 운영 레퍼런스는 `dist/ts-runtime/...`를 직접 보도록 정리돼 있었다.
- `ska.js`와 `bug-report.js`는 현재 실행 경로가 남아 있어 이번 배치에서 제외했다.

## 12차 삭제 완료

다음 현재 runtime wrapper 2개도 실제로 제거했다.

- `bots/reservation/src/bug-report.js`
- `bots/reservation/src/ska.js`

정리 배경:
- `naver-monitor.ts`의 bug-report 실행 경로를 `dist/ts-runtime/.../src/bug-report.js`로 전환했다.
- `ai.ska.commander` launchd 템플릿과 live LaunchAgent를 `dist/ts-runtime/.../src/ska.js` 기준으로 정리했다.

## 다음 삭제 후보 메모

`manual/reports/*.js`는 대부분 얇은 source wrapper로 남아 있지만,
현재 코드 기준 직접 호출은 아래 두 경로가 핵심이었다.

- `bots/orchestrator/src/router.ts` -> `pickko-alerts-resolve.js`
- `bots/reservation/manual/reservation/pickko-accurate.ts` -> `pickko-pay-pending.js`

이 두 경로도 이제 `dist/ts-runtime/...`를 직접 보도록 정리했다.

## 추가 정리 (orchestrator collector)

- `bots/orchestrator/lib/write/report-aggregator.legacy.js`의 스카 daily summary 수집 경로를
  `bots/reservation/auto/scheduled/pickko-daily-summary.js`에서
  `dist/ts-runtime/bots/reservation/auto/scheduled/pickko-daily-summary.js`로 전환했다.

검증:
- `report-aggregator.legacy.js` syntax check 통과
- dist 경로 반영 확인
