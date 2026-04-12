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

### 1. launchd가 직접 `.js`를 실행 중

현재 launchd/plist가 다음 JS 엔트리포인트를 직접 호출한다.

- `bots/reservation/scripts/health-check.js`
- `bots/reservation/scripts/dashboard-server.js`
- `bots/reservation/scripts/backup-db.js`
- `bots/reservation/scripts/log-rotate.js`
- `bots/reservation/auto/scheduled/pickko-daily-summary.js`
- `bots/reservation/auto/scheduled/pickko-daily-audit.js`
- `bots/reservation/auto/scheduled/pickko-pay-scan.js`
- `bots/reservation/manual/admin/pickko-verify.js`
- `bots/reservation/auto/monitors/run-kiosk-monitor.sh` 경유의 JS 호출

관련 파일:
- `bots/reservation/launchd/ai.ska.health-check.plist`
- `bots/reservation/launchd/ai.ska.dashboard.plist`
- `bots/reservation/launchd/ai.ska.db-backup.plist`
- `bots/reservation/launchd/ai.ska.log-rotate.plist`
- `bots/reservation/launchd/ai.ska.pickko-daily-summary.plist`
- `bots/reservation/launchd/ai.ska.pickko-daily-audit.plist`
- `bots/reservation/launchd/ai.ska.pickko-pay-scan.plist`
- `bots/reservation/launchd/ai.ska.pickko-verify.plist`
- `bots/reservation/launchd/ai.ska.kiosk-monitor.plist`
- `bots/reservation/launchd/ai.ska.naver-monitor.plist`

### 2. shell wrapper가 `.js` 경로를 직접 spawn 중

- `bots/reservation/manual/admin/run-verify.sh` -> `pickko-verify.js`
- `bots/reservation/manual/reservation/pickko-cancel-cmd.ts` -> `pickko-cancel.js`
- `bots/reservation/manual/reservation/pickko-register.ts` -> `pickko-accurate.js`, `pickko-kiosk-monitor.js`
- `bots/reservation/manual/reservation/pickko-reregister-batch.ts` -> `pickko-accurate.js`

### 3. 다른 팀 코드가 `.js` import/path를 직접 사용 중

- `bots/blog/lib/blo.ts` -> `bots/reservation/lib/state-bus.js`
- `bots/orchestrator/src/router.ts` -> `bots/reservation/scripts/health-report.js`
- `bots/registry.json` -> `auto/monitors/naver-monitor.js`, `auto/monitors/pickko-kiosk-monitor.js`

## 분류

### A. 즉시 삭제 금지 (실행 엔트리)

아래는 아직 실제 실행 경로로 쓰이므로 유지 필요.

- `auto/monitors/*.js`
- `auto/scheduled/*.js`
- `manual/admin/pickko-verify.js`
- `manual/reservation/pickko-accurate.js`
- `manual/reservation/pickko-cancel.js`
- `manual/reservation/pickko-register.js`
- `manual/reservation/pickko-query.js`
- `scripts/health-check.js`
- `scripts/health-report.js`
- `scripts/dashboard-server.js`
- `scripts/backup-db.js`
- `scripts/log-rotate.js`
- `lib/state-bus.js`

### B. 선행 전환 후 삭제 가능 (호출자 수정 필요)

아래는 직접 호출자가 끊기면 삭제 후보가 된다.

- launchd plist에 연결된 JS wrapper 전체
- `run-verify.sh`가 호출하는 `pickko-verify.js`
- `pickko-register.ts` / `pickko-reregister-batch.ts` / `pickko-cancel-cmd.ts`가 spawn하는 JS 경로
- `bots/blog/lib/blo.ts`의 `state-bus.js` import
- `bots/orchestrator/src/router.ts`의 `health-report.js` path
- `bots/registry.json`의 `naver-monitor.js`, `pickko-kiosk-monitor.js`

### C. 문서/런북/스킬 참조

문서와 스킬에도 `.js` 표기가 다수 남아 있다.
이는 런타임 차단 이슈는 아니지만, 실제 제거 직전에 한 번 정리해야 한다.

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

## 바로 다음 작업 추천

이제 남은 작업은 구현보다 운영 표면 마감에 가깝다.

- 실제 `~/Library/LaunchAgents/ai.ska.*` 동기화 여부 결정
- 문서/런북/README의 `.js` 표기 정리
- 충분히 확인되면 wrapper 삭제 후보 목록 확정

즉 reservation JS 제거 준비는 사실상 메타/운영 마감 단계에 들어왔다.
