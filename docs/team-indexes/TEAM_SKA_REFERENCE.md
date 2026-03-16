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

- [bots/reservation/auto/monitors/naver-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/naver-monitor.js)
- [bots/reservation/auto/monitors/pickko-kiosk-monitor.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/auto/monitors/pickko-kiosk-monitor.js)
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

## 관련 문서

- [bots/reservation/context/DEV_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/DEV_SUMMARY.md)
- [bots/reservation/context/HANDOFF.md](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/HANDOFF.md)
- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)

