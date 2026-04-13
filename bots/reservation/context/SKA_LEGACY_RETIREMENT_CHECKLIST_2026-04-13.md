# Ska Legacy Retirement Checklist (2026-04-13)

## 목적

이 문서는 `bots/reservation/**/*.legacy.js`를 실제로 줄이거나 제거할 때 필요한 체크 순서를 고정하기 위한 실무 체크리스트다.

전제:

- `.ts` = source of truth
- `dist/ts-runtime/**/*.js` = 실제 운영 런타임
- `.legacy.js` = fallback / CommonJS compatibility rail

## 삭제 전 공통 확인

- [ ] 대상 `.legacy.js`를 current runtime이 직접 참조하지 않는다.
- [ ] 대상 `.legacy.js`를 cross-team import가 직접 참조하지 않는다.
- [ ] 동일 기능이 `dist/ts-runtime/...` 엔트리로 충분히 검증돼 있다.
- [ ] source mode fallback이 없어도 장애 대응이 가능하다.
- [ ] launchd, shell wrapper, package script, registry가 모두 dist 기준으로 고정돼 있다.

## 확인 명령

```bash
find bots/reservation -name '*.legacy.js' | wc -l
find bots/reservation -name '*.legacy.js' -exec wc -l {} + | sort -n
rg -n '\.legacy\.js|dist/ts-runtime/bots/reservation' bots/reservation docs skills packages
./node_modules/.bin/tsc -p bots/reservation/tsconfig.json --noEmit
node scripts/build-reservation-runtime.mjs
```

## 삭제 순서 권장

1. low-risk helper
2. read-only report helper
3. manual/admin helper
4. monitor/service helper
5. 마지막: `ts-fallback-loader.legacy.js`

## 삭제 후 확인

- [ ] reservation `tsc --noEmit` 통과
- [ ] reservation runtime build 통과
- [ ] 필요한 smoke 대상 통과
  - [ ] `health-report`
  - [ ] `pickko-daily-summary`
  - [ ] `pickko-daily-audit`
  - [ ] `pickko-pay-scan`
  - [ ] `pickko-verify`
  - [ ] `naver-monitor`
  - [ ] `pickko-kiosk-monitor`

## 문서 정리

- [ ] `SKA_JS_REMOVAL_READINESS_2026-04-13.md` 상태 갱신
- [ ] `SKA_TS_CONVERSION_PLAN.md` 상태 갱신
- [ ] 필요 시 `README.md`와 `HANDOFF.md`에 운영 기준 반영

## 중단 조건

아래 중 하나라도 보이면 삭제를 중단하고 `.legacy.js`를 유지한다.

- launchd / shell / registry / package script 중 하나라도 source fallback을 전제
- dist build 없이도 source mode 실행을 보존해야 하는 운영 요구가 존재
- cross-team import가 아직 직접 또는 간접적으로 fallback rail에 기대고 있음
- `ts-fallback-loader.legacy.js`를 대체할 운영 합의가 없음

## 현재 판단

현재 스카팀 reservation은 source wrapper `.js` 제거까지 완료된 상태다.
다음 삭제 프로젝트가 있다면 그 대상은 `.legacy.js` 자체이며, 이 문서 체크를 모두 통과하는 범위에서만 진행한다.
