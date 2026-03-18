# 세션 핸드오프

> 다음 세션은 먼저 [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)를 읽고 이 문서를 보세요.

---

## 1. 현재 시스템 상태 요약

- 공통 알림 / 리포팅
  - 공용 `reporting-hub` notice/report 렌더러가 모바일 친화형으로 축약됐다.
  - 텔레그램 발송 직전에 긴 구분선과 과도한 공백을 정규화하도록 `telegram-sender`가 보강됐다.
  - 루나 실시간 알림/주간 리뷰 메시지도 긴 구분선과 장문 근거를 줄여 모바일 가독성을 높였다.
- 워커
  - 문서 업로드/파싱/OCR/문서 상세/재사용 이력/생성 결과 연결까지 한 사이클이 닫혔다.
  - `/documents`, `/documents/[id]`에서 문서 재사용 성과를 확인할 수 있다.
  - `/admin/monitoring`에서 현재 워커 웹의 LLM API 적용 내용과 기본 provider 선택값을 확인/변경할 수 있다.
- 스카
  - 기존 예측 엔진은 유지되고 있다.
  - `knn-shadow-v1` shadow 비교 모델이 `forecast_results.predictions`에 저장되기 시작했다.
  - 일일/주간 예측 리뷰와 자동화는 shadow 비교를 읽도록 확장됐다.
- 운영 분석
  - `daily-ops-report.js`가 도입됐다.
  - health 입력 실패 시 과장된 장애 진단을 줄이도록 보정됐다.
  - `error-log-daily-review.js`는 `최근 3시간 활성 오류`와 `하루 누적 오류`를 분리해, 이미 종료된 반복 오류를 현재 장애처럼 과장하지 않도록 보정됐다.
- 투자
  - `executionMode=live/paper`, `brokerAccountMode=real/mock` 기준이 코드/리포트/문서에 반영됐다.
  - 실패 원인 저장은 `block_reason + block_code + block_meta` 구조로 확장됐다.
  - `onchain-data.js`에서 `nextFundingTime` 비정상 값 방어가 추가돼 `PEPEUSDT Invalid time value` 로그 노이즈가 줄었다.
  - `runtime_config.luna.fastPathThresholds.minCryptoConfidence = 0.44`가 실제 운영 `config.yaml`에 반영됐다.
  - suggestion log `498d9f9c-4725-460a-a5ea-129e82f3be19`는 `applied` 상태이며, 현재 판단은 `observe`다.
- 제이 / 오케스트레이터
  - OpenClaw gateway 기본 모델과 제이 앱 레벨 커스텀 모델 정책을 분리해서 읽도록 정리됐다.
  - `jay-model-policy.js`가 추가되어 `intent parse`와 `chat fallback` 모델 체인을 한 곳에서 관리한다.
- 클로드/덱스터
  - 저위험 코드 무결성 이슈는 `soft match`로 재해석되어 shadow mismatch 과장 경고가 정리됐다.
- 문서 체계
  - 구현 추적 문서는 [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)로 이름이 바뀌었다.
  - 세션 지속성용 문서 체계는 기존 문서 중심으로 정리됐다.
    - [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
    - [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
    - [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

---

## 2. 현재 진행 Phase

### 플랫폼 관점

- `운영 데이터 신뢰성 강화 + 모바일 알림 최적화 + 관찰 단계 전환` 단계

### 워커 관점

- `문서 파싱 → 문서 재사용 → 실제 업무 생성 결과 추적 → 품질/효율 분석 → 개선 후보 리뷰` 단계까지 확장
- 다음은 실제 후보 데이터가 쌓이는지 관찰하는 단계

### 스카 관점

- `기존 엔진 유지 + shadow 비교 모델 관찰` 단계
- 현재 `shadowDecision.stage = collecting`
- 다음은 `primary vs shadow` actual 비교 누적 관찰 단계

---

## 3. 다음 작업 목표

1. 투자 실험 3~7일 관찰
   - 적용값: `runtime_config.luna.fastPathThresholds.minCryptoConfidence = 0.44`
   - 확인 항목: `binance BUY / executed / failed`, `nemesis_error`, `legacy_executor_failed`, health warnCount
2. 스카 shadow 비교 actual 누적 관찰
   - 현재 `availableDays = 0`
   - 일일 최소 3일 / 주간 최소 5일 누적이 필요
   - `availableDays > 0`가 생기기 시작하면 `collecting -> observe` 진입 여부 판단
3. 워커 문서 효율 후보 관찰
   - 개선 후보 문서 / 템플릿 후보 / OCR 재검토 후보가 실제로 생기는지 확인
4. 남은 자동화 확정
   - 스카 shadow 일일/주간
   - 워커 문서 효율 일일/주간
   - 투자 설정 제안 일일/주간

---

## 4. 현재 열린 이슈

- 스카 shadow 비교는 저장은 정상이나 아직 actual 누적이 부족해서 비교 일수는 `0`
- 스카 일일/주간 리뷰는 이제 `shadowDecision`으로 현재 단계(`collecting / observe / promotion_candidate / primary_hold`)를 명시
- 자동화 런타임에서 일부 `health-report.js`가 직접 실패하는 경향이 있어 `fallback_probe_unavailable`이 남을 수 있음
- 워커 문서 재사용은 품질/효율 지표와 개선 후보 리뷰까지 붙었지만, 현재 `company_id=1` 기준 실제 문서 표본은 아직 없음
- 워커 모니터링의 LLM API 선택 변경 이력과 note 저장은 이미 반영됐고, 다음은 더 긴 추세 보기와 운영 비교 고도화
- 투자 실험은 실제 적용까지 들어갔지만, 아직 표본이 부족해 `observe` 상태다
- OpenClaw gateway 기본 primary는 아직 `google-gemini-cli/gemini-2.5-flash`이고, 제이 명령 해석은 `gpt-5-mini`라 운영자 입장에서 모델 체계 혼선이 남아 있다

자세한 상태는 [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)를 함께 보세요.

---

## 5. 중요 설계 포인트

- 스카 새 모델은 `교체`가 아니라 `shadow 비교`로만 시작한다.
- 워커 문서 흐름은 새 레이어를 만들기보다 기존 confirm/result 흐름을 확장한다.
- 워커 LLM API 모니터링은 기존 `llm_mode` 정책을 깨지 않고, 관리자 분석 경로의 기본 provider만 별도 축으로 제어한다.
- 투자팀의 자산/계좌 해석은 `executionMode`와 `brokerAccountMode`를 분리해 읽는다.
- 투자 설정 변경은 자동 적용보다 `suggestion -> review -> apply -> validate -> observe` 불변식을 유지한다.
- 운영 리포트는 `근거 약한 추론`보다 `보수적 hold`가 우선이다.
- 제이의 모델 체계는 하나가 아니라 `OpenClaw 기본 모델 / intent parse 모델 / chat fallback 체인`으로 분리해 읽어야 한다.
- 문서 체계는 `정책 / 인덱스 / 구조 / 현재 상태 / 팀 참조 / 로그 / 브이로그 / handoff`로 역할을 분리한다.
- 다만 같은 성격의 기록은 새 파일을 만들지 않고 기존 문서에 흡수한다.

---

## 6. 이어서 작업할 때 필요한 최소 컨텍스트

### 반드시 먼저 읽기

1. [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
2. [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
3. [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
4. [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
5. [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

### 이어서 볼 문서

- 워커 문서 흐름
  - [TEAM_WORKER_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_WORKER_REFERENCE.md)
- 스카 예측
  - [TEAM_SKA_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_SKA_REFERENCE.md)
  - [scripts/reviews/README.md](/Users/alexlee/projects/ai-agent-system/scripts/reviews/README.md)
- 운영 설정
  - [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
  - [TEAM_ORCHESTRATOR_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_ORCHESTRATOR_REFERENCE.md)

### 핵심 코드 진입점

- 스카 예측
  - [/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast.py)
  - [/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js)
  - [/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-weekly-review.js)
- 워커 문서 흐름
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/documents/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/documents/page.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/documents/[id]/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/documents/[id]/page.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/monitoring/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/monitoring/page.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/llm-api-monitoring.js)
- 투자 실행/리포트
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
  - [/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)
- 운영 분석
  - [/Users/alexlee/projects/ai-agent-system/scripts/reviews/daily-ops-report.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/daily-ops-report.js)
  - [/Users/alexlee/projects/ai-agent-system/scripts/reviews/error-log-daily-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/error-log-daily-review.js)
- 제이 모델 정책
  - [/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/jay-model-policy.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/jay-model-policy.js)
  - [/Users/alexlee/.openclaw/openclaw.json](/Users/alexlee/.openclaw/openclaw.json)
