# 개발 로그

> 목적: 세션 단위로 작업 맥락, 변경 파일, 핵심 결정, 테스트 결과를 기록한다.

---

## 2026-03-18 Session Summary

### 작업한 기능

- 스카 매출 예측 엔진에 `knn-shadow-v1` shadow 비교 모델 추가
- 스카 일일/주간 리뷰 및 자동화가 `primary vs shadow` 비교를 읽도록 확장
- 워커 문서 재사용 흐름을 `문서 상세 → 업무 전달 → 재사용 이력 → 실제 생성 결과 연결 → 성과 집계`까지 확장
- `daily-ops-report.js`를 추가해 일일 운영 분석 리포트의 입력 구조를 보수적으로 정리
- 구현 추적 문서를 `PLATFORM_IMPLEMENTATION_TRACKER.md`로 이름 변경하고 세션/팀 문서 링크를 정리
- 세션 지속성 강화를 위한 문서 체계 정리
  - `DOCUMENTATION_SYSTEM.md`
  - `DEV_LOG.md`
  - `DEV_VLOG.md`

### 변경된 파일 목록

- 스카
  - [bots/ska/config.json](/Users/alexlee/projects/ai-agent-system/bots/ska/config.json)
  - [bots/ska/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/runtime-config.js)
  - [bots/ska/src/runtime_config.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/runtime_config.py)
  - [bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
  - [scripts/reviews/ska-sales-forecast-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js)
  - [scripts/reviews/ska-sales-forecast-weekly-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js)
- 워커
  - [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
  - [bots/worker/web/app/documents/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/documents/page.js)
  - [bots/worker/web/app/documents/[id]/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/documents/[id]/page.js)
- 운영 분석
  - [scripts/reviews/daily-ops-report.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/daily-ops-report.js)
- 문서
  - [README.md](/Users/alexlee/projects/ai-agent-system/README.md)
  - [docs/DOCUMENTATION_SYSTEM.md](/Users/alexlee/projects/ai-agent-system/docs/DOCUMENTATION_SYSTEM.md)
  - [docs/SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
  - [docs/SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
  - [docs/PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
  - [docs/CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
  - [docs/WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
  - [docs/TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
  - [docs/KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
  - [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)

### 핵심 변경 사항

- 스카 예측은 기존 엔진을 유지한 채 shadow 예측을 별도 저장하는 구조로 확장했다.
- 워커 문서 재사용은 단순 프롬프트 복사를 넘어서 실제 생성 결과와 성과 집계까지 추적 가능하게 만들었다.
- 운영 분석 리포트는 `health-report` 실패를 장애처럼 과장하지 않도록 입력 구조를 보수화했다.
- 문서 체계는 `세션 시작 문서 / 구조 문서 / 현재 상태 문서 / 팀 참조 문서 / 기록 문서`로 역할을 분리했다.

### 해결한 문제

- 스카 예측 엔진의 “다른 계열 모델 비교 부재” 문제
- 문서 재사용 이후 실제 업무 생성까지 이어지는 추적선 부재
- 일일 운영 분석 리포트의 fallback 과장 진단 문제
- `improvement-ideas.md`라는 이름이 실제 역할과 맞지 않던 문제

### 발생한 이슈

- 자동화 런타임에서 일부 `health-report.js`가 직접 실패해 `fallback_probe_unavailable`이 자주 발생함
- 스카 shadow 비교는 저장은 시작됐지만 아직 actual 누적으로 인한 비교 일수는 부족함
- 프로젝트 문서 수가 많아 세션 시작 시 무엇을 읽어야 하는지 혼란이 있었음

### 왜 이 작업을 했는가

- 스카는 모델을 바로 바꾸기보다 안전하게 비교 가능한 구조가 먼저 필요했다.
- 워커는 문서 파싱이 끝난 뒤 실제 업무 재사용/추적까지 이어져야 AI Ops Platform답게 운영 데이터가 남는다.
- 문서체계는 세션이 끊길 때마다 손실되는 컨텍스트를 줄이기 위해서다.

### 의사결정 이유

- 스카 shadow 모델은 `기존 엔진 대체`가 아니라 `운영형 shadow 비교`로 시작해야 리스크가 낮다.
- 워커 문서 흐름은 새 엔진을 만들기보다 기존 문서 저장/업무 confirm 흐름을 확장하는 것이 맞다.
- 문서체계는 문서를 더 많이 만드는 것보다 문서의 역할을 분리하는 쪽이 유지보수에 유리하다.

### 테스트 결과

- `python3 -m py_compile /Users/alexlee/projects/ai-agent-system/bots/ska/src/runtime_config.py /Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py`
- `node --check /Users/alexlee/projects/ai-agent-system/scripts/reviews/daily-ops-report.js`
- `node --check /Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js`
- `node --check /Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js`
- `cd /Users/alexlee/projects/ai-agent-system/bots/worker/web && npm run build`
- 스카 예측 실행 및 `forecast_results.predictions`에 shadow 필드 저장 확인
