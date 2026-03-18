# Changelog

All notable changes to ai-agent-system will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/).

## 12주차 (2026-03-19) — 재부팅 절차를 문서/핸드오프 게이트로 고도화

### 변경 사항 (changed)
- `scripts/pre-reboot.sh`를 승인 대기형 절차로 재설계
  - 기본 실행은 `준비/대기`만 수행
  - 실제 ai-agent-system 서비스 정지는 `--drain-now`에서만 수행
  - 스크립트가 OS 종료/재시작을 직접 실행하지 않도록 정리
- 재부팅 전 필수 문서 최신성 게이트 추가
  - `SESSION_HANDOFF.md`
  - `WORK_HISTORY.md`
  - `CHANGELOG.md`
  - `TEST_RESULTS.md`
  - `PLATFORM_IMPLEMENTATION_TRACKER.md`
  - 위 문서 상태가 기준을 통과하지 않으면 `pre-reboot.sh --drain-now`가 중단되도록 보강
- `scripts/post-reboot.sh`를 현재 운영 구조 기준 전사 점검형으로 확장
  - orchestrator / OpenClaw / n8n
  - worker web / nextjs / lead / task-runner
  - investment commander / markets / reporter / argos / alerts / prescreen
  - blog node-server / daily / health-check
  - claude commander / dexter / archer / health-dashboard
  - ska monitors
  를 재부팅 후 점검 대상에 포함
- 재부팅 후 문서/세션 후속 체크리스트 추가
  - `/tmp/post-reboot-followup.txt`에 재부팅 후 갱신해야 할 문서와 핸드오프 규칙을 기록
  - post-reboot 텔레그램 보고에도 문서 갱신 필요 조건을 함께 남기도록 보강
- `docs/OPERATIONS_RUNBOOK.md`에 노트북 재부팅 표준 절차 추가
  - 준비 단계
  - 문서/핸드오프 게이트
  - 재부팅 직전 정리 단계
  - 사용자 직접 재시작
  - 부팅 후 자동 점검
  - 수동 후속 검증

## 12주차 (2026-03-19) — 루나 퍼널 계측 강화 + 재점검 Phase 준비

### 신규 기능 (feat)
- 루나 `decision 퍼널 병목` 계측 고도화
  - `pipeline-decision-runner.js`가 `pipeline_runs.meta`에 `buy_decisions / sell_decisions / hold_decisions`를 함께 저장하도록 확장
  - `trading-journal.js`, `weekly-trade-review.js`가 시장별 `decision / BUY / SELL / HOLD / executed / weak / risk / saved`를 직접 보여주도록 확장
- 루나 재점검 Phase 문서 추가
  - `docs/LUNA_RESET_AUDIT_PLAN_2026-03-19.md`
  - `docs/LUNA_RESET_AUDIT_CODEX_PROMPT_2026-03-19.md`

### 변경 사항 (changed)
- 바이낸스 수익 파이프라인 다변화 목표에 맞춰 crypto 종목 선정/판단 기준을 완화
  - `screening.crypto.max_dynamic: 7 -> 12`
  - `screening.crypto.min_volume_usdt: 1000000 -> 750000`
  - `runtime_config.luna.minConfidence.live.binance: 0.50 -> 0.44`
  - `runtime_config.luna.minConfidence.paper.binance: 0.45 -> 0.40`
  - `runtime_config.luna.debateThresholds.crypto: 0.64/0.32 -> 0.56/0.18`
  - `runtime_config.luna.fastPathThresholds.minAverageConfidence: 0.42 -> 0.34`
  - `runtime_config.luna.fastPathThresholds.minAbsScore: 0.25 -> 0.16`
  - `runtime_config.luna.fastPathThresholds.minCryptoConfidence: 0.44 -> 0.40`
- `luna.js` crypto 프롬프트에 분산 진입, HOLD 남발 억제, 재진입 가능한 추세 종목 선호를 명시
- 바이낸스는 최종 signal 저장 전 confidence 기준을 `timeMode.minSignalScore`보다 runtime crypto 기준이 더 낮을 경우 runtime 기준을 우선 사용하도록 정리
- `pipeline-decision-runner.js`도 동일한 바이낸스 confidence gating 규칙으로 맞췄다

## 12주차 (2026-03-16 ~ 2026-03-18) — 운영 변수 외부화 + 분석 자동화 정리

### 신규 기능 (feat)
- 워커 웹 `마스터` 메뉴 아래 `LLM API 현황`, `블로그 URL 입력` 운영 콘솔 추가
  - `블로그 URL 입력`에서 최근 블로그 글의 실제 네이버 URL을 canonical 형태로 기록 가능
  - 테스트 글 `34`, `36`, `38` 제외
  - `published + naver_url 없음`과 `ready + naver_url 없음`을 분리해 표시
- 워커 `LLM API 현황`을 전사 LLM 운영 콘솔로 재구성
  - `ai-agent-system 전체 에이전트 리스트` 추가
  - Jay / Worker / Claude / Blog / Investment의 primary / fallback / 미적용 상태를 한 화면에서 조회 가능
  - selector별 `primary / fallback` 역할 선택 후 `provider -> model` 2단계로 직접 변경 가능
  - 역할 선택 시 현재 적용된 provider / model 값으로 자동 동기화
- 워커 `LLM API 현황`에 `속도 테스트` 운영 카드 추가
  - 속도 테스트 실행 버튼
  - API 대상 목록
  - 최신 측정 결과(TTFT / 총 응답시간 / 성공/실패)
  - 최근 7일 review 요약
- 제이에 `/llm-selectors` 운영 조회 명령 추가
  - 공용 selector의 `primary/fallback chain`과 최근 speed-test 스냅샷을 텔레그램/자연어 질의로 바로 조회 가능
- 워커 `/admin/monitoring`에 selector 상태 카드 추가
  - `worker.ai.fallback`, `worker.chat.task_intake`의 primary/fallback chain을 관리자 화면에서 바로 조회 가능
- 워커 `/admin/monitoring`에 전 팀 selector 개요 추가
  - Jay / Worker / Claude / Blog / Investment의 primary/fallback chain과 최근 speed-test 스냅샷을 한 화면에서 조회 가능
- `llm-selector-advisor.js` 추가
  - 최근 speed-test 스냅샷 기준으로 selector별 `hold / compare / switch_candidate / observe` 추천을 생성
  - `llm-selector-report.js` 텍스트/JSON 출력에 `advice` 포함
- 워커 `/admin/monitoring`에 selector advisor 표시 추가
  - worker 개별 chain과 전 팀 selector 개요에 `hold / compare / switch_candidate / observe` 판단과 근거를 함께 노출
- `llm-selector-override-suggestions.js` 추가
  - selector advisor 결과를 `runtime_config` override 후보 추천으로 변환
  - config 파일 / path / suggested chain을 함께 출력
- 제이 `/llm-selectors`와 워커 `/admin/monitoring`에 override 추천 노출 추가
  - 스크립트 실행 없이 운영자가 추천 후보를 바로 확인 가능
- 워커 웹 관리자 메뉴에 `워커 모니터링` 추가
  - `/admin/monitoring`에서 현재 적용 LLM API 경로와 기본 provider 선택 가능
  - `worker.system_preferences` 테이블로 선택값 저장
  - 최근 24시간 호출 통계와 기본 API 변경 이력까지 확인 가능
  - provider별/경로별 성공률과 평균 응답시간까지 확인 가능
  - provider 변경 사유(note)까지 이력에 함께 저장 가능
  - 최근 변경 전후 12시간 기준 성공률/응답시간 비교 가능
- 팀별 `runtime_config` / `config.json` / `config.yaml` 외부화 체계 추가
  - investment / reservation / ska / worker / orchestrator / claude / blog
- 팀별 운영 설정 조회 스크립트 추가
  - `scripts/show-runtime-configs.js`
- 팀 운영 설정 가이드 문서 추가
  - `docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md`
- 스카 매출 예측 일일/주간 리뷰 스크립트 운영 기준 외부화
- 워커 웹 프론트 timeout/runtime 설정 외부화
  - auth timeout / release buffer / ws reconnect delay
- 스카 예측 shadow 비교 모델 추가
  - `knn-shadow-v1`를 `forecast_results.predictions`에 별도 저장
  - 기존 예측 엔진과 독립 비교 가능한 shadow 관찰 구조 추가
- 워커 문서 재사용 추적 고도화
  - `/documents`, `/documents/[id]` 상세
  - 문서 재사용 이벤트 저장
  - 업무 생성 결과 연결 및 문서별 재사용 성과 집계
  - 문서 목록/상세에서 OCR 품질, 추출 실패, 짧은 텍스트 기반 품질 신호 표시
  - 문서 목록에서 품질 상태와 전환율 기준 정렬/필터 지원
  - 문서 상세에서 무수정 확정률과 평균 수정 필드 수 기반 재사용 효율 표시
  - 문서 품질/전환율/무수정 확정률/수정량을 묶은 종합 효율 점수와 `효율 높은 순` 정렬 추가
  - `document-efficiency-review.js`로 개선 우선 문서 / 템플릿 후보 / OCR 재검토 후보 리뷰 추가
- 투자 runtime_config 제안 리포트 추가
  - 최근 14일 신호/실행/실패 코드 기준 `current -> suggested` 제안 출력
  - `adjust / hold / confidence / reason` 형식으로 운영 검토용 후보 제공
  - `--write` 옵션으로 제안 스냅샷을 `investment.runtime_config_suggestion_log`에 저장 가능
  - `review-runtime-config-suggestion.js`로 저장된 제안의 `pending / hold / approved / rejected / applied` 상태 갱신 가능
  - `apply-runtime-config-suggestion.js`로 승인된 제안을 `config.yaml`에 반영하고 `applied_at`까지 자동 기록 가능
  - `validate-runtime-config-apply.js`로 적용 직후 suggestion 상태, health, 최근 실행 흐름을 함께 검증 가능
- 알림 UX 실발송 검증 경로 정리
  - 개인 채팅 / 그룹 채팅 / 루나 토픽 15 직접 전송이 모두 `ok=true`로 확인됐다
  - 실제 수신 화면 기준으로 모바일 구분선/헤더 포맷을 검증할 수 있는 상태로 정리됐다

### 변경 사항 (changed)
- 워커 웹 사이드바를 `관리자` / `마스터` 그룹으로 재정리하고, 시스템 전체 모니터링성 메뉴를 마스터 그룹으로 이동
- 워커 `LLM API 현황`의 전역 selector payload 생성을 외부 report 스크립트 호출 대신 서버 내부 직접 조합 방식으로 안정화
- `LLM API 현황` 화면에서 중복되던 워커 특화 카드와 중복 설명 문구를 정리하고, 전체 에이전트 리스트 중심 구조로 재배치
- 공용 텔레그램 알림 포맷을 모바일 기준으로 재정리
  - 긴 구분선은 모두 `───────────────` 15자 규칙으로 정규화
  - queued notice 알림은 `headline` 우선 제목 구조로 바뀌어 `ℹ️ 안내 / ℹ️ luna 알림 / 요약:` 중복이 줄었다
- 투자 장전 스크리닝 / 장 마감 매매일지 본문을 모바일형으로 압축
  - 심볼 목록은 최대 개수까지만 보여주고 `외 N개`로 축약
  - 투자 성향 / 매매 내역 / 보유 포지션 / 신호 요약 줄 수를 줄여 한 화면 가독성을 높였다
- 자동화 리포트 출력을 운영 액션 중심으로 보강
  - `jay-gateway-experiment-daily.js`는 스냅샷 저장 실패 시에도 기존 누적 스냅샷 기준 리뷰를 계속 출력하도록 강인성을 높였다
  - `log-jay-gateway-experiment.js` / `jay-gateway-experiment-daily.js`는 `~/.openclaw/workspace` 쓰기 실패 시 repo 내부 `tmp/jay-gateway-experiments.jsonl` fallback 저장으로 기록을 유지한다
  - `daily-ops-report.js`는 `health_report_failed_probe_unavailable`와 실제 `healthError`를 함께 노출해 입력 실패 원인을 더 명확히 구분한다
  - `daily-ops-report.js`는 `현재 활성 이슈 / 누적 반복 이슈 / 입력 실패`를 분리해 시스템 문제와 리포트 입력 실패를 구분해서 본다
  - `ska-sales-forecast-daily-review.js`는 `actionItems`를 추가해 `bias_tuning / weekday_tuning / manual_review / shadow_readiness`를 바로 읽을 수 있게 정리했다
  - `ska-sales-forecast-weekly-review.js`도 `requestedDays / effectiveDays`와 `actionItems`를 추가해 일일/주간 리포트 판단 포맷을 통일했다
  - `trading-journal.js`는 거래 없음 대비 분석 비용이 큰 경우 `no-trade high-cost` 경고를 추가하도록 보강했다
  - `weekly-trade-review.js`는 종료 거래가 없어도 미결 포지션/주간 usage/다음 조치를 남기며, `date_kst::date` 비교로 주간 usage 0 버그를 수정했다
  - `jay-llm-daily-review.js`는 DB 접근 실패 시 `dbStatsStatus=partial`, `dbSourceErrors`, `session_usage_fallback` 기반 모델별 사용량을 함께 보여준다
- `speed-test.js`가 최신 측정 결과를 `~/.openclaw/workspace/llm-speed-test-latest.json`에 저장하도록 확장
- `llm-selector-report.js`가 공용 selector의 `primary/fallback chain`과 최근 speed-test 스냅샷을 함께 출력하도록 확장
- 투자팀 운영 모드 용어 정리
  - `executionMode = live/paper`
  - `brokerAccountMode = real/mock`
  - 암호화폐는 `brokerAccountMode=real`만 사용하도록 기준 고정
- 루나팀 실행 모드 / `[PAPER]` 태그 / 브로커 표현을 공용 헬퍼 기준으로 통합
  - 암호화폐와 국내외장은 분리 유지하되 한 곳에서 관리
- 국내/해외장 로그 문구를 실제 KIS 모의투자 상태 기준으로 정리
- 자동매매 일지와 주간 리뷰에 `암호화폐 / 국내장 / 해외장` 섹션 강제 분리
- 블로그 생성 임계치와 maestro 관련 timeout/cooldown을 설정 파일에서 조정 가능하게 변경
- 스카 일일/주간 예측 리뷰가 `primary vs shadow` 비교와 promotion 판단을 읽도록 확장
- 스카 일일/주간 예측 리뷰에 `shadowDecision` 추가
  - `데이터 수집 / 비교 관찰 / 앙상블 후보 / 기존 유지` 단계 명시
  - `availableDays`, `requiredDays`, `gapThreshold`, `reason` 함께 출력
- 일일 운영 분석 리포트 입력 스크립트를 `daily-ops-report.js` 기준으로 정리
- 구현 추적 문서 이름을 `PLATFORM_IMPLEMENTATION_TRACKER.md`로 정리하고 세션 인덱스/팀 문서 링크를 갱신
- 세션 문서 체계를 기존 문서 중심으로 재정리
  - `SESSION_CONTEXT_INDEX.md`
  - `WORK_HISTORY.md`
  - `RESEARCH_JOURNAL.md`
- 제이 모델 정책을 `orchestrator/config.json > runtime_config.jayModels`와 연결
  - OpenClaw 기본 모델과 제이 앱 커스텀 모델을 운영 설정 문맥에서도 분리
  - `/jay-models`와 자연어 질의로 현재 모델 체계를 바로 조회 가능하게 추가
  - `check-jay-gateway-primary.js`로 `runtime_config`와 실제 `openclaw.json` primary 정합성 점검 가능하게 추가
  - gateway primary 후보 프로필과 현재 권장 판단(hold/sync_first)까지 운영 스크립트에서 바로 확인 가능하게 추가
  - gateway 전환 실험 기준을 `hold / compare / switch` 3단계로 문서화
  - `log-jay-gateway-experiment.js`로 gateway 로그 / 제이 usage / health-report를 함께 기록하는 실험 스냅샷 경로 추가
  - `jay-gateway-experiment-review.js`로 누적 스냅샷 기반 권장 판단 리뷰 경로 추가
  - `jay-gateway-experiment-daily.js`로 스냅샷 기록과 리뷰를 한 번에 실행하는 자동화 진입점 추가
  - `jay-gateway-change-compare.js`로 실제 primary 전환 시점의 전후 비교 리포트 경로 추가
  - `prepare-jay-gateway-switch.js`로 후보 모델 전환 사전 계획과 롤백 기준 출력 경로 추가

### 버그 수정 (fix)
- 투자 실패 원인 저장 구조 확장
  - `block_reason` + `block_code` + `block_meta`
  - `backfill-signal-block-reasons.js`로 과거 `legacy_*` 실패 이력까지 구조화 백필
  - 자동매매 일지에 시장별 `실패 코드 요약` 추가
- 주간 자동매매 리뷰 입력 강인성 보강
  - 보조 입력 실패 시 전체 리포트 중단 대신 가능한 범위에서 계속 진행
- 덱스터 shadow mismatch 완화
  - 저위험 코드 무결성 이슈(`git 상태`, `git 변경사항`, `체크섬`)의 `monitor ↔ ignore`는 `soft match`로 재해석
- KIS 국내/해외장 주문 금액 단위 보정
  - 국내는 `KRW`, 해외는 `USD` 기준으로 clamp
- 국내/해외 모의투자 경로에서 장외 시간/최소 주문 수량 검증 흐름 점검
- 덱스터 false positive 완화
  - `고아 Node` 판정 오탐 축소
  - `Swap` 경고 기준 현실화
  - `forecast_results` 누락을 필수 오류에서 분리
- 덱스터 AI 진단 문구를 낮은 심각도 이슈에 과장되지 않도록 보수화
- 일일 운영 분석 리포트가 `fallback_probe_unavailable`을 장애처럼 다루지 않도록 보정
- 모바일 텔레그램 알림 줄바꿈 이슈 보정
  - 긴 `━/═/─/-` 구분선이 2줄로 꺾이던 문제를 공용 sender 직전 정규화로 회복
- 메인봇 큐 notice 알림 헤더 중복 보정
  - 동일 메시지 안에서 `안내`와 `bot 알림`이 반복되던 구조를 headline 우선 포맷으로 정리
- 장전/장마감 투자 알림 과도한 본문 길이 보정
  - 긴 심볼 나열, 상세 투자 성향, 매매/포지션 장문 나열을 요약형으로 축소
- 제이 Gateway 자동화 일일 러너 강인성 보강
  - `~/.openclaw/workspace` 쓰기 실패가 나더라도 기존 스냅샷 리뷰는 계속 생성되도록 불변식을 회복했다
- 일일 운영 분석 입력 실패 해석 보강
  - 단순 `hold`만 남기지 않고 어떤 팀 health-report 입력이 실패했는지 `healthError`로 함께 표시한다

### 문서 (docs)
- 개발계획에 `OpenClaw`를 `LLM API 현황` 조회 전용 그룹으로 추가하는 후속 작업을 내일 진행할 항목으로 기록
- 워커 팀 참조 문서에 `LLM API 현황`, `블로그 URL 입력`, 속도 테스트 콘솔 반영
- 워커 모니터링 진입점과 투자 실행 모드 기준을 세션 문서/팀 문서에 반영
- 워커 모니터링 운영 지표와 `018-monitoring-history`, `019-monitoring-change-notes` 마이그레이션 경로를 팀 참조 문서/구현 추적 문서에 반영
- 투자팀 참조 문서에 `legacy_order_rejected`, `legacy_executor_failed` 코드와 백필 스크립트 경로 반영
- 제이 모델 정책 확인 순서를 런북/세션 인덱스/팀 참조 문서에 반영
- 팀 운영 변수 관리 체계 문서화
- 운영 중 조정 가능한 값과 추가 개발 후보 정리
- 세션 인덱스/팀 참조 문서/구현 추적 문서 이름 정리 및 참조 링크 갱신
- 세션 문서 역할 재정리 및 링크 정합성 갱신

### 추가 개발 후보
- `runtime_config` 변경 후보를 일일/주간으로 제안하는 자동화 고도화
- `worker`, `orchestrator`, `claude` 운영 설정 변경 이력 추적
- 제이/전체 운영 분석 리포트와 설정 튜닝 제안의 통합 정리
- 스카 shadow 비교 데이터 누적 후 `ensemble experiment` 승격 여부 판단

---

## 10~11주차 (2026-03-11 ~ 2026-03-15) — 228 커밋

### 신규 기능 (feat)
- KST 시간 유틸리티 (packages/core/lib/kst.js) + 전 팀 적용
- 소스코드 접근 제한 (file-guard.js + autofix 범위 제한)
- 루나 노드화 파이프라인 (L10~L34 스캐폴딩)
- 루나 매매일지 자동 리뷰 + 엑스커전 메트릭
- 루나 장외시간 리서치 모드 + 워치리스트
- 스카 예측 캘리브레이션 + 피처스토어 + 모멘텀
- 워커 WebSocket 실시간 채팅 + 태스크 큐 + 승인
- 제이 인텐트 자동 프로모션 + 롤백 + 감사 추적
- 통합 OPS 헬스 대시보드 (전체 팀 현황)
- 팀별 헬스 리포트 (루나/스카/클로드/워커/블로)

### 버그 수정 (fix)
- KNOWN ISSUES 5개 (mini 폴백 + screening DB + XSS + gemini maxTokens)
- launchd plist UTC→KST 로컬 시간 수정 (블로그 Hour=21→6)
- 루나 스크리닝 폴백 + 신선도 체크
- 스카 예측 정합성 + 정확도 중복 제거
- 제이 인텐트 스키마 정합 + 팀간 안정화
- 워커 웹 모바일 버그 4종 (SSE→XHR, 툴칩, 채팅 중복, 스크롤)
- 워커 웹 채팅 메시지 버블 병합 (tool 사이여도 단일 버블)

### 문서 (docs)
- CLAUDE.md 공통 원칙 8개 추가
- kst.js 사용 규칙 + launchd 시간 규칙

### 리팩터링 (refactor)
- 공유 헬퍼 통합 (헬스리포트 + 프로바이더 + 포맷터)
- 인텐트 스토어 공유 (전 팀 커맨더 연결)
- 스카 레거시 코드 정리

---

## [2026-03-11] — 전 팀 LLM 모델 최적화 + 스크리닝 장애 대응

### Added
- **screening-monitor.js** (루나팀): 아르고스 스크리닝 연속 실패 추적 + 3회 이상 텔레그램 알림
- **loadPreScreenedFallback()** (pre-market-screen.js): 24h TTL RAG 폴백 — 아르고스 실패 시 마지막 성공 결과 재사용
- **callOpenAIMini()** (llm-client.js): gpt-4o-mini 전용 호출 함수
- **MINI_FIRST_AGENTS** (llm-client.js): hermes/sophia/zeus/athena → gpt-4o-mini 메인 라우팅

### Changed
- `llm-client.js`: GROQ_AGENTS `[nemesis,oracle,athena,zeus]` → `[nemesis,oracle]` / callGroq 폴백 gpt-4o→gpt-4o-mini
- `pos-writer.js`, `gems-writer.js`: LLM 폴백 체인 2순위 gpt-oss-20b → gpt-4o-mini
- `star.js`: 단일 체인 → gpt-4o-mini + llama-4-scout 폴백
- `claude-lead-brain.js`: LLM_CHAIN claude-sonnet 제거 → gpt-4o → gpt-4o-mini → scout
- `archer/config.js`: OPENAI.model gpt-4o → gpt-4o-mini
- `domestic.js`, `overseas.js`, `crypto.js`: 아르고스 RAG 폴백 + screening-monitor 연동

---

## [2026-03-10] — 블로그팀 장문 출력 극대화

### Added
- **Continue 이어쓰기 패턴**: 1차 호출 글자수 부족 시 자동 2차 호출 (pos/gems)
- **_THE_END_ 마커**: 시스템 프롬프트에 완성 신호 강제 지시
- **exhaustive 키워드**: comprehensively / in-depth / thoroughly 장문 유도

### Fixed
- temperature 조정: pos 0.75→0.82 / gems 0.80→0.85
- 글자수 기준 상향: 강의 MIN 9,000/GOAL 10,000 / 일반 MIN 5,000/GOAL 7,000

### Result
- 강의 포스팅: 최대 10,225자 달성 (이전 ~8,122자)

---

## [2026-03-10] — 블로그팀 분할 생성 + llm-keys 통합

### Added
- **chunked-llm.js** (packages/core): Gemini Flash / GPT-4o 분할 생성 공용 유틸
- **writeLecturePostChunked()**: 강의 포스팅 4청크 분할 생성
- **writeGeneralPostChunked()**: 일반 포스팅 3청크 분할 생성
- **BLOG_LLM_MODEL 환경변수**: `gemini`(무료 분할) / `gpt4o`(유료 단일) 전환

### Fixed
- `pos-writer`, `gems-writer`, `chunked-llm`: OpenAI 키를 `getOpenAIKey()` (llm-keys 폴백) 로 통일
- 글자수 기준 실측 기반 재조정: 강의 MIN 7,000 / 일반 MIN 4,500

---

## [2026-03-09] — 블로그팀 Phase 1 완전체

### Added
- **블로그팀 5봇**: blo(팀장) + richer(리서치) + pos(강의작성) + gems(일반작성) + publ(퍼블리셔)
- **blog 스키마 5테이블**: posts / category_rotation / curriculum / research_cache / daily_config
- **Node.js 120강 커리큘럼** 시딩 완료
- **ai.blog.daily launchd**: 매일 06:00 KST 자동 실행
- **팀 제이 핵심 기술 15종 통합**: RAG/MessageEnvelope/trace_id/tool-logger/StateBus/llm-cache/mode-guard/AI탐지리스크/GEO+AEO/ai-agent-system컨텍스트/RAG실전에피소드/내부링킹/리라이팅가이드/포럼토픽/Registry등록
- **rag_blog 컬렉션** (pgvector): 과거 포스팅 중복 방지 + 내부 링킹용
- **publ.js 구글드라이브 자동 저장**: `/010_BlogPost` 폴더 동기화

### Fixed
- pos-writer max_tokens 8000 → 16000 (글자수 부족 해결)
- 섹션별 최소 글자수 userPrompt 명시 (GPT-4o 출력 유도)
- 글자수 기준 실측 기반 조정: lecture 7,000자 / general 3,500자

## [2026-03-08] — 제이 자연어 능력 향상 v2.0

### Added
- **intent-parser.js**: Intent 53개 (기존 36 + 17 신규), 슬래시 명령 7개 추가
- **CoT + Few-shot 프롬프트**: 2단계 Chain-of-Thought + 10개 예시 + 동적 DB 주입
- **`loadDynamicExamples()`**: unrecognized_intents DB에서 5분 캐시 동적 Few-shot 주입
- **unrecognized_intents 테이블** (claude 스키마): 미인식 명령 자동 기록
- **chat 폴백 2단계**: TEAM_KEYWORDS → delegateToTeamLead → geminiChatFallback
- **17개 신규 router 핸들러**: Shadow, LLM 졸업, 투자 일지, 덱스터 즉시 실행 등
- **`promoteToIntent()`**: 미인식 명령 → nlp-learnings.json 즉시 승격 + 5분 내 자동 반영
- **HELP_TEXT v2.0**: 전체 명령 + 자동학습 섹션 추가

### Fixed
- ska_query 패턴 bare `|통계` 제거 → "캐시 통계" 오매칭 버그 수정
- OpenClaw `openclaw.json` `agents.teamLeads` 미인식 키 → `openclaw doctor --fix` 제거

---

## [Unreleased]

---

## [v3.3.0] - 2026-03-07 — PostgreSQL 단일 DB 통합 마이그레이션

### Changed
- **DB 아키텍처 전면 통합**: SQLite 2종 + DuckDB 2종 → PostgreSQL 17 단일 DB (`jay`)
  - `~/.openclaw/workspace/state.db` → `reservation` 스키마
  - `~/.openclaw/workspace/claude-team.db` → `claude` 스키마
  - `bots/investment/db/investment.duckdb` → `investment` 스키마
  - `bots/ska/db/ska.duckdb` → `ska` 스키마

### Added
- **`packages/core/lib/pg-pool.js`**: Node.js PostgreSQL 커넥션 풀 싱글톤
  - 스키마별 `search_path` 자동 설정
  - `?` → `$N` 파라미터 자동 변환
  - `prepare()` → `run/get/all()` better-sqlite3 호환 API
- **`bots/ska/scripts/setup-db.py`**: ska PostgreSQL 스키마 초기화 (5개 테이블)

### Removed
- `duckdb` npm 패키지 (`bots/investment`) — KI-003 취약점 해결
- `better-sqlite3` npm 패키지 (`bots/reservation`, `bots/orchestrator`)
- `duckdb==1.2.0` pip 패키지 (`bots/ska`)

### Fixed
- **KI-003**: duckdb→node-gyp→tar npm audit high 취약점 — duckdb 완전 제거로 해결

---

## [v3.2.0] - 2026-03-07 — 1주차 완료: 3계층 핵심 기반 구축

### Added
- **헤파이스토스 TP/SL OCO** (`bots/investment/team/hephaestos.js`)
  - Binance Spot OCO 주문 자동 설정 (TP +6%, SL -3%, R/R 2:1)
  - PAPER_MODE 시 OCO 생략, `tp_sl_set` 플래그 기록
- **State Bus agent_events/agent_tasks** (`bots/reservation/lib/state-bus.js`)
  - 팀원↔팀장 비동기 소통 채널 (emitEvent, createTask 등 7개 함수)
- **덱스터 v2 체크 모듈** (`bots/claude/lib/checks/`)
  - team-leads / openclaw / llm-cost / workspace-git
- **DexterMode 이중 모드** (`bots/claude/lib/dexter-mode.js`)
  - Normal ↔ Emergency 자동 전환 + 알림 버퍼링
- **LLM 인프라** (`packages/core/lib/`)
  - llm-logger.js: 전 팀 LLM 비용 DB 추적
  - llm-router.js: 복잡도 기반 모델 자동 분배 (simple→Groq, complex→Sonnet)
  - llm-cache.js: SQLite 시맨틱 캐시, 팀별 TTL 차등
- **루나팀 매매일지** (`bots/investment/shared/trade-journal-db.js`)
  - 5개 테이블: trade_journal / rationale / review / performance_daily / luna_monitor
  - hephaestos/nemesis 자동 기록 연동, 텔레그램 리포트
- **OpenClaw 멀티에이전트 구조** (`packages/core/lib/`)
  - team-comm.js: 팀장 간 소통 (State Bus 기반, sessions_send 대체)
  - heartbeat.js: 팀장 생존 확인 + 이벤트 폴링
  - SOUL.md 3개 (ska / claude-lead / luna)
- **독터 자동 복구 봇** (`bots/claude/lib/doctor.js`)
  - 화이트리스트 5개: 서비스재시작 / 파일권한 / WAL체크포인트 / 캐시정리 / npm패치
  - 블랙리스트 9개: rm-rf / DROP TABLE / DELETE FROM / kill-9 / --force 등
  - doctor_log 테이블 자동 생성 (state.db)
- **OPS/DEV 분리** (`packages/core/lib/mode-guard.js`, `scripts/deploy-ops.sh`)
  - ensureOps / ensureDev / runIfOps
  - 배포 전 5단계 점검 스크립트

### Fixed
- **덱스터 오류 이력 무한 누적** — cleanup() 미호출 버그, 7일 보존으로 수정
- **덱스터 오탐 근본 수정** — markResolved() 추가 (ok 복귀 시 error 이력 즉시 삭제)
- **openclaw.js IPv6 파싱 오탐** — bracket notation `[::1]` 처리 추가
- **미해결 알림 반복 + tool_code 누출** (pickko-alerts-resolve.js 신규)

### Security
- pre-commit에 config.yaml 차단 추가
- .gitignore에 config.yaml, *.key 추가
- security.js에 pre-commit 훅 설치/권한 점검 추가

---

## [2026-03-06] — 팀 제이 아키텍처 Day 3

### Added
- **llm-logger.js** (`packages/core/lib/llm-logger.js`)
  - 전 팀 LLM 호출 통합 추적 (state.db `llm_usage_log` 테이블 자동 생성)
  - 모델별 단가표: Groq=무료, Haiku=$1/$5, Sonnet=$3/$15, Opus=$15/$75 per 1M
  - `logLLMCall`, `getDailyCost`, `getCostBreakdown`, `buildDailyCostReport` 함수
  - 기존 cost-tracker.js (루나팀 파일 기반) 독립 유지

- **llm-router.js** (`packages/core/lib/llm-router.js`)
  - 복잡도 기반 LLM 모델 자동 라우팅 (DB 의존 없음, 순수 로직)
  - simple→Groq(무료), medium→Haiku, complex→Sonnet, deep→Opus
  - 팀별 requestType 매핑: ska(7종), claude(6종), luna(6종)
  - 긴급도(urgency) 상향 로직: simple→medium (high/critical)
  - `selectModel`, `classifyComplexity` 함수

- **llm-cache.js** (`packages/core/lib/llm-cache.js`)
  - 시맨틱 캐시: 벡터 DB 없이 키워드 해시 기반 경량 구현 (state.db `llm_cache`)
  - 캐시 키: 불용어 제거 → 키워드 추출 → 정렬 → SHA256(team:requestType:keywords)
  - TTL 팀별 차등: ska=30분, claude=360분(6h), luna=5분
  - 민감정보 보호: 앞 100자 요약 + 긴 숫자열(6자리+) 마스킹
  - `generateCacheKey`, `getCached`, `setCache`, `getCacheStats`, `cleanExpired` 함수

### Changed
- **llm-client.js** (`bots/investment/shared/llm-client.js`)
  - `_logLLMCall` import 추가 (createRequire 패턴, 무음 실패)
  - callOpenAI / callGroq 양쪽에 `_logLLMCall?.()` 연동

---

## [2026-03-06] — 팀 제이 아키텍처 Day 1~2

### Added
- **State Bus 확장** (`bots/reservation/lib/state-bus.js`)
  - `agent_events` 테이블: 팀원→팀장 이벤트 보고 (emitEvent, getUnprocessedEvents, markEventProcessed)
  - `agent_tasks` 테이블: 팀장→팀원 작업 지시 (createTask, getPendingTasks, completeTask, failTask)
  - priority 정렬: critical(0) > high(1) > normal(2) > low(3)

- **루나팀 TP/SL OCO** (`bots/investment/team/hephaestos.js`)
  - BUY 진입 후 Binance Spot OCO 주문 자동 설정
  - TP: +6%, SL: -3%, SL limit buffer: ×0.999
  - PAPER_MODE 시 OCO 생략
  - `trade.tpSlSet = true/false` 기록

- **DB 마이그레이션 v3** (`bots/investment/shared/db.js`)
  - `tp_price`, `sl_price`, `tp_order_id`, `sl_order_id`, `tp_sl_set` 컬럼 추가

- **덱스터 v2 체크 모듈** (`bots/claude/lib/checks/`)
  - `team-leads.js`: 핵심 봇 프로세스 건강 (OpenClaw/앤디/지미/루나크립토/tmux:ska)
  - `openclaw.js`: OpenClaw 게이트웨이 상태 (launchd+포트+메모리)
  - `llm-cost.js`: LLM 비용 모니터링 (일간/월간, 예산 $10 기준)
  - `workspace-git.js`: 워크스페이스 Git 건강 점검

- **DexterMode 이중 모드** (`bots/claude/lib/dexter-mode.js`)
  - Normal ↔ Emergency 자동 전환 (OpenClaw/스카야 3분 이상 다운 시)
  - Emergency 중 알림 버퍼링 + 복구 시 일괄 발송
  - 상태 파일: `~/.openclaw/workspace/dexter-mode-state.json`

- **덱스터 v2 통합** (`bots/claude/src/dexter.js`)
  - v2 체크 모듈 4개 추가 (에러 격리 적용)
  - DexterMode 모드 전환 판단 연동

- **덱스터 퀵체크 v2** (`bots/claude/src/dexter-quickcheck.js`)
  - 팀장 봇 프로세스 빠른 점검 추가

### Fixed
- **openclaw.js IPv6 파싱 버그**
  - `[::1]:18789` 주소를 `split(':')[0]` → `[` 로 파싱하는 버그 수정
  - IPv6 bracket notation 명시적 처리: `[::1]` → loopback 인식
  - IPv6 wildcard 추가: `::`, `0:0:0:0:0:0:0:0`

- **dexter-quickcheck.js false positive**
  - v2 openclaw 포트 체크(lsof 기반) 제거 → 기존 launchd 체크로 충분
  - 5분 주기 퀵체크에서 CRITICAL "포트 미바인딩" 오경보 해소

### Changed
- CLAUDE.md: 개발 루틴 + 세션 루틴 섹션 추가

---

## [2026-03-05] — 시스템 인프라 확장

### Added
- LLM 토큰 이력 DB (`bots/orchestrator/lib/token-tracker.js`)
- 덱스터 AI 분석 레이어 (`bots/claude/lib/ai-analyst.js`)
- 덱스터 퀵체크 2-티어 체계 (5분 + 1시간)
- OpenClaw 2026.3.2 업데이트

### Fixed
- 덱스터 Phase C 버그 수정
- 헬스체크 회복 로직
- 스카 취소루틴 버그 수정

---

## [2026-03-03] — 스카팀 v3.0 + 클로드팀 v2.0

### Added
- 스카팀 폴더 구조 개편 (auto/manual/lib)
- State Bus 에이전트 통신 구축
- 덱스터 ska 감시 모듈
- 아처 v2.0 AI/LLM 트렌드 재정의
- team-bus 덱스터↔아처 통신

### Changed
- 루나팀 Phase 3-A 크립토 LIVE 전환 (PAPER_MODE=false)
# 2026-03-18

- 자동화 리포트
  - `jay-llm-daily-review.js`가 `dbSourceStatus`를 추가해 `sandbox_restricted / permission_denied / db_unreachable` 등 source별 실패 상태를 구분해 노출하도록 보강
  - `jay-llm-daily-review.js`가 `tmp/jay-llm-daily-review-db-snapshot.json` fallback 저장을 지원해, live DB query가 막혀도 최근 DB 집계를 snapshot 기준으로 계속 읽을 수 있게 정리
  - `packages/core/lib/health-runner.js`가 빈 `예외:` 대신 `[EPERM] ...` 형태의 실제 실패 힌트를 stderr에 남기도록 보강
  - `ska-sales-forecast-daily-review.js`가 `requestedDays / effectiveDays`를 함께 출력해 일일/주간 리포트 해석 규칙을 통일
  - `daily-ops-report.js`가 `inputFailures.code`를 세분화하고 `investment / reservation`에는 `local fallback 활동 신호`를 함께 표시해 health-report 실패와 팀 활동 신호를 분리해서 읽을 수 있게 정리
  - `daily-ops-report.js` 추천 문구가 `db_sandbox_restricted`와 `local fallback` 상태를 구분해 운영 액션으로 직접 이어지도록 보강
  - `daily-ops-report.js`가 `sourceMode`를 추가해 전 팀 health source를 `unavailable / local_fallback / auxiliary_review` 같은 관측 모드로 표준화해 읽을 수 있게 정리

- 공통 LLM
  - `packages/core/lib/llm-model-selector.js` 추가
  - 제이/아처/클로드 리드/워커/블로그/공용 chunked-llm/투자 agent 정책의 모델·폴백 기준을 공용 selector key 기반으로 1차 통합
  - 오케스트레이터 `runtime_config.llmSelectorOverrides`와 투자 `runtime_config.llmPolicies`를 추가해 selector 기본값 위에 운영 override를 얹는 2차 통합 진행
  - 워커 `runtime_config.llmSelectorOverrides`를 추가해 `worker.ai.fallback`, `worker.chat.task_intake` 경로를 selector override로 운영 제어 가능하게 정리
  - 블로그 `runtime_config.llmSelectorOverrides`를 추가해 writer/social/star/curriculum 경로를 selector override로 운영 제어 가능하게 정리
  - 클로드 `runtime_config.llmSelectorOverrides`를 추가해 아처·클로드 리드·덱스터 경로를 selector override로 운영 제어 가능하게 정리
  - `describeLLMSelector()`와 `scripts/llm-selector-report.js`를 추가해 현재 selector의 primary/fallback 체인을 텍스트/JSON으로 조회 가능하게 정리
  - `packages/core/lib/llm-selector-advisor.js`를 추가해 speed-test 기준 selector 추천(`hold / compare / switch_candidate / observe`)을 생성하고 워커 모니터링 UI에 표시
  - `scripts/llm-selector-override-suggestions.js`를 추가해 advisor 결과를 runtime_config override 후보로 정리하고 `--write` 저장까지 지원
  - `scripts/review-llm-selector-override-suggestion.js`를 추가해 저장된 selector override 추천을 `pending / hold / approved / rejected / applied` 상태로 검토 가능하게 정리
  - `scripts/apply-llm-selector-override-suggestion.js`를 추가해 승인된 selector override 추천을 실제 `config.json` 경로에 반영하고 applied 이력을 남길 수 있게 정리
  - `scripts/speed-test.js`가 최신 스냅샷 외에 `llm-speed-test-history.jsonl` 히스토리를 누적하도록 보강
  - `scripts/reviews/llm-selector-speed-review.js`를 추가해 최근 N일 speed-test 히스토리 기반 selector 추천 근거를 리뷰 가능하게 정리
  - `scripts/reviews/llm-selector-speed-daily.js`를 추가해 speed-test 실행과 review를 일일 러너로 묶어 자동화 진입점을 정리
  - 블로그 `publ.js`가 내부 링킹 플레이스홀더를 실제 `published + naver_url` 과거 포스트 링크로 치환하고 Markdown 링크를 HTML anchor로 변환하도록 보강
  - `packages/core/lib/naver-blog-url.js`, `scripts/parse-naver-blog-url.js`를 추가해 네이버 블로그 URL 파싱/정규화 경로를 공용 유틸로 정리
  - `bots/blog/scripts/mark-published-url.js`를 추가해 수동 발행 후 `postId/scheduleId` 기준으로 canonical 네이버 블로그 URL을 저장하고 `published` 상태를 기록할 수 있게 정리
  - 워커웹 `/admin/monitoring/blog-links`와 `/api/admin/monitoring/blog-published-urls`를 추가해 최근 블로그 글을 운영 화면에서 조회하고 네이버 발행 URL을 직접 입력/저장할 수 있게 정리
- 클로드/아처
  - 아처 LLM 폴백 순서를 `anthropic/claude-sonnet-4-6 -> openai/gpt-4o-mini -> groq/llama-4-scout-17b-16e-instruct`로 재정렬
  - `bots/claude/lib/archer/config.js`에 `LLM_CHAIN`을 추가해 아처 전용 모델 우선순위를 설정 레이어로 승격
- 투자
  - 루나 주식 공격적 매매를 `runtime_config` 기반 전략 프로필(`stockStrategyMode`, `stockStrategyProfiles`)로 실제 연결
  - 네메시스가 `stockRejectConfidence`, `stockAutoApproveDomestic`, `stockAutoApproveOverseas`를 하드 규칙으로 사용하도록 보강
  - 소규모 국내/해외장 BUY 자동 승인과 저확신 주식 조기 차단이 실제 코드 경로에 반영
- 개발계획
  - `PLATFORM_IMPLEMENTATION_TRACKER`에서 이미 운영 중인 워커 로컬/외부 IP 접속 항목을 PENDING 최우선 목록에서 제거
- 투자
  - 실제 운영 `config.yaml`에 `runtime_config.luna.fastPathThresholds.minCryptoConfidence = 0.44` 반영
  - suggestion log `498d9f9c-4725-460a-a5ea-129e82f3be19`를 `applied` 상태로 올리고 검증 단계까지 연결
- 세션 운영
  - 세션 종료 문서를 `모바일 알림 최적화 + 투자 실험 observe 단계` 기준으로 갱신
- 클로드
  - `node bots/claude/src/dexter.js --update-checksums`로 체크섬 베이스라인 갱신 (`65개 파일`)
- reporting-hub notice/report 메시지를 모바일 친화형으로 축약
- payload.details가 있는 알림은 긴 원문 본문 대신 요약 detail 우선 사용
- telegram-sender에서 긴 구분선과 연속 공백을 발송 직전 정리
- 루나 실시간 알림/주간 리뷰 메시지의 구분선과 장문 근거를 단축
- 오케스트레이터
  - `jay-model-policy.js` 신규
  - 제이 모델 체계를 `OpenClaw gateway 기본 모델`과 `제이 앱 레벨 커스텀 모델 정책`으로 분리
  - `intent-parser.js`, `router.js`가 제이 모델 정책 파일을 공통 참조하도록 정리
- 운영 리뷰
  - `error-log-daily-review.js`에 `최근 3시간 활성 오류`와 `하루 누적 오류`를 분리
  - 종료된 `OpenClaw gateway rate limit`이 현재 장애처럼 과장되지 않도록 보정
- 투자
  - `onchain-data.js`에서 비정상 `nextFundingTime` 방어 추가
  - `PEPEUSDT Invalid time value` 로그 노이즈 완화
