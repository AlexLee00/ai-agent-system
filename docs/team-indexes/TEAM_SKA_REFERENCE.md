# 스카 참조 문서

## 역할

- 스터디카페 예약 운영 + 예측 엔진
- 네이버/픽코 모니터, 예측/리뷰, 운영 헬스 포함

## 핵심 기능

- `naver-monitor` / `pickko-kiosk-monitor`
- 예약 등록/취소/재시도
- 매출/예약 예측
- 일일/주간 리뷰

## 핵심 진입점

- [bots/reservation/auto/monitors/naver-monitor.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.ts)
- [bots/reservation/auto/monitors/pickko-kiosk-monitor.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.ts)
- [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
- [bots/ska/src/rebecca.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py)

## 핵심 스크립트

- [bots/reservation/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js)
- [scripts/reviews/ska-sales-forecast-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js)
- [scripts/reviews/ska-sales-forecast-weekly-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js)

## 운영 설정

- [bots/reservation/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/reservation/config.yaml)
- [bots/reservation/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/runtime-config.js)
- [bots/ska/config.json](/Users/alexlee/projects/ai-agent-system/bots/ska/config.json)
- [bots/ska/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/runtime-config.js)
- [bots/ska/src/runtime_config.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/runtime_config.py)

## 브라우저 운영 모드

- 기본 운영값:
  - `PLAYWRIGHT_HEADLESS=true` 또는 미설정
  - 스카 모니터는 headless 백그라운드 실행
- 디버깅/수동 로그인:
  - `PLAYWRIGHT_HEADLESS=false`
  - 또는 [bots/reservation/.playwright-headed](/Users/alexlee/projects/ai-agent-system/bots/reservation/.playwright-headed) 플래그 파일 생성
- 하위 호환:
  - `NAVER_HEADLESS`, `PICKKO_HEADLESS`는 legacy 토글로 유지
  - 새 기준은 `PLAYWRIGHT_HEADLESS`
- 세션 만료 복구 순서:
  1. `touch bots/reservation/.playwright-headed`
  2. `bash bots/reservation/scripts/reload-monitor.sh`
  3. 브라우저에서 수동 로그인
  4. `rm bots/reservation/.playwright-headed`
  5. `bash bots/reservation/scripts/reload-monitor.sh`

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js --days=7
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js --days=28
bash /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/reload-monitor.sh
PLAYWRIGHT_HEADLESS=false node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/src/check-naver.js
```

## 관련 문서

- [bots/reservation/context/DEV_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/DEV_SUMMARY.md)
- [bots/reservation/context/HANDOFF.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/HANDOFF.md)
- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
