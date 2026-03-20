# 세션 핸드오프

> 다음 세션은 먼저 [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)를 읽고 이 문서를 보세요.

---

## 1. 현재 시스템 상태 요약

- 공통 알림 / 리포팅
  - 공용 `reporting-hub` notice/report 렌더러가 모바일 친화형으로 축약됐다.
  - 텔레그램 발송 직전에 긴 구분선과 과도한 공백을 정규화하도록 `telegram-sender`가 보강됐다.
  - 루나 실시간 알림/주간 리뷰 메시지도 긴 구분선과 장문 근거를 줄여 모바일 가독성을 높였다.
  - 긴 구분선은 모두 `───────────────` 15자 규칙으로 통일됐다.
  - queued notice 알림은 `headline` 우선 제목 구조로 바뀌어 `ℹ️ 안내 / ℹ️ luna 알림 / 요약:` 중복이 줄었다.
  - 장전 스크리닝과 장 마감 매매일지는 심볼/포지션/매매 내역이 `외 N개 / 외 N건` 형태로 축약돼 한 화면 가독성이 높아졌다.
- 워커
  - 문서 업로드/파싱/OCR/문서 상세/재사용 이력/생성 결과 연결까지 한 사이클이 닫혔다.
  - `/documents`, `/documents/[id]`에서 문서 재사용 성과를 확인할 수 있다.
  - `/admin/monitoring`은 `LLM API 현황`으로 재정리돼, ai-agent-system 전체 에이전트의 primary / fallback / 미적용 상태와 speed-test 결과를 한 화면에서 본다.
  - 같은 화면에서 Jay / Worker / Claude / Blog selector는 `primary / fallback` 역할 선택 후 `provider -> model` 2단계로 변경할 수 있다.
  - `/admin/monitoring/blog-links`가 추가돼 실제 네이버 블로그 URL 기록과 발행 후처리를 마스터 화면에서 처리할 수 있다.
  - `ai.worker.lead`, `ai.worker.task-runner`는 이번 세션에서 launchd 재등록으로 복구됐고, health-report 기준 정상이다.
- 스카
  - 기존 예측 엔진은 유지되고 있다.
  - `knn-shadow-v1` shadow 비교 모델이 `forecast_results.predictions`에 저장되기 시작했다.
  - 일일/주간 예측 리뷰와 자동화는 shadow 비교를 읽도록 확장됐다.
- 운영 분석
  - `daily-ops-report.js`가 도입됐다.
  - health 입력 실패 시 과장된 장애 진단을 줄이도록 보정됐다.
  - `error-log-daily-review.js`는 `최근 3시간 활성 오류`와 `하루 누적 오류`를 분리해, 이미 종료된 반복 오류를 현재 장애처럼 과장하지 않도록 보정됐다.
  - `daily-ops-report.js`는 이제 `health_report_failed_launchctl / health_report_failed_probe_unavailable`와 `healthError`를 함께 보여줘 입력 실패 원인을 더 명확히 읽을 수 있다.
  - `daily-ops-report.js`는 이제 `현재 활성 이슈 / 누적 반복 이슈 / 입력 실패`를 분리해, 시스템 문제와 자동화 입력 실패를 한 화면에서 구분해 읽을 수 있다.
  - `daily-ops-report.js`는 입력 실패를 `db_sandbox_restricted` 같은 코드형 상태로 구분하고, investment / reservation 팀은 `local fallback 활동 신호`를 함께 표시해 “DB 제한은 있지만 팀 활동은 있음”을 읽을 수 있게 됐다.
- 투자
  - `executionMode=live/paper`, `brokerAccountMode=real/mock` 기준이 코드/리포트/문서에 반영됐다.
  - 실패 원인 저장은 `block_reason + block_code + block_meta` 구조로 확장됐다.
  - `pipeline_runs.meta`는 이제 `decision / BUY / SELL / HOLD / executed / weak / risk / savedExecutionWork`를 함께 저장해 루나 decision 퍼널을 시장별로 직접 읽을 수 있다.
  - `trading-journal.js`, `weekly-trade-review.js`는 시장별 `decision 퍼널 병목`을 노출해, 거래 부재 원인을 weak/risk가 아닌 `portfolio decision` 쪽에서 좁혀 볼 수 있게 됐다.
  - `onchain-data.js`에서 `nextFundingTime` 비정상 값 방어가 추가돼 `PEPEUSDT Invalid time value` 로그 노이즈가 줄었다.
  - `runtime_config.luna.fastPathThresholds.minCryptoConfidence = 0.44`가 실제 운영 `config.yaml`에 반영됐다.
  - suggestion log `498d9f9c-4725-460a-a5ea-129e82f3be19`는 `applied` 상태이며, 현재 판단은 `observe`다.
  - `trading-journal.js`는 거래 없음 대비 분석비용이 큰 날 `no-trade high-cost` 경고를 출력하도록 보강됐다.
  - `weekly-trade-review.js`는 종료 거래가 없어도 미결 포지션, 주간 LLM 사용량, 다음 조치를 포함한 운영 요약을 남기며, `date_kst::date` 비교로 주간 usage가 0으로 떨어지던 버그를 수정했다.
  - 바이낸스 목표를 `수익 가능 종목 다변화 + 활발한 거래 파이프라인`으로 재정의하고, `config.yaml`과 `luna.js`에서 crypto 후보 폭과 decision 보수성을 완화했다.
  - `screening.crypto.max_dynamic=12`, `min_volume_usdt=750000`, `minConfidence.live.binance=0.44`, `debateThresholds.crypto=0.56/0.18`, `fastPath minCryptoConfidence=0.40`가 적용됐다.
  - 바이낸스는 최종 signal gating에서 `timeMode.minSignalScore`보다 runtime crypto 기준이 더 낮을 경우 runtime 기준을 우선 사용하도록 정리됐다.
  - 루나 시스템 재점검 Phase용 문서와 Codex 실행 프롬프트가 추가됐다.
    - `docs/LUNA_RESET_AUDIT_PLAN_2026-03-19.md`
    - `docs/LUNA_RESET_AUDIT_CODEX_PROMPT_2026-03-19.md`
- 제이 / 오케스트레이터
  - OpenClaw gateway 기본 모델과 제이 앱 레벨 커스텀 모델 정책을 분리해서 읽도록 정리됐다.
  - `jay-model-policy.js`가 추가되어 `intent parse`와 `chat fallback` 모델 체인을 한 곳에서 관리한다.
  - `jay-gateway-experiment-daily.js`는 새 스냅샷 저장 실패 시에도 기존 누적 스냅샷 기준 review를 계속 출력하도록 보강됐다.
  - `log-jay-gateway-experiment.js`와 `jay-gateway-experiment-daily.js`는 `~/.openclaw/workspace` 쓰기 실패 시 repo 내부 `tmp/jay-gateway-experiments.jsonl` fallback 저장으로 계속 기록을 남긴다.
  - `jay-llm-daily-review.js`는 DB 접근 실패 시에도 `session_usage_fallback` 기준 모델별 사용량을 유지하고, `dbStatsStatus=partial`, `dbSourceErrors`, `dbSourceStatus`를 함께 노출해 현재 실행 컨텍스트 제한과 실제 DB 장애를 더 명확히 구분한다.
  - `jay-llm-daily-review.js`는 DB 읽기가 가능한 실행 컨텍스트에서는 `tmp/jay-llm-daily-review-db-snapshot.json`에 최근 DB 집계를 저장하고, 이후 DB 접근이 막혀도 snapshot fallback으로 리뷰를 계속 유지하도록 보강됐다.
- 스카
  - `ska-sales-forecast-daily-review.js`는 `requestedDays / effectiveDays`와 `actionItems`를 제공해 일일/주간 리포트 해석 규칙을 맞췄다.
  - `ska-sales-forecast-weekly-review.js`도 `requestedDays / effectiveDays`와 `actionItems`를 제공해 일일/주간 리포트 해석 규칙을 맞췄다.
- 클로드/덱스터
  - 저위험 코드 무결성 이슈는 `soft match`로 재해석되어 shadow mismatch 과장 경고가 정리됐다.
- 문서 체계
  - 구현 추적 문서는 [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)로 이름이 바뀌었다.
  - 세션 지속성용 문서 체계는 기존 문서 중심으로 정리됐다.
    - [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
    - [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
    - [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)
- 재부팅 절차
  - `scripts/pre-reboot.sh`는 기본 실행 시 준비/대기만 수행하고, `--drain-now`에서만 ai-agent-system 서비스 정지 신호를 보낸다.
  - 재부팅 전에는 `SESSION_HANDOFF / WORK_HISTORY / CHANGELOG / TEST_RESULTS / PLATFORM_IMPLEMENTATION_TRACKER` 최신성 점검이 필수 게이트다.
  - `scripts/post-reboot.sh`는 현재 전사 운영 구조 기준으로 worker / investment / blog / claude / orchestrator / ska / n8n 복구 상태를 넓게 확인한다.
  - 투자팀은 `ai.investment.crypto`를 `normal` 거래 레일로 유지하고, `ai.investment.crypto.validation`을 선택적 validation 레일로 분리할 준비가 됐다.
  - validation 레일은 이제 `crypto / domestic / overseas`까지 launchd 분리 가능한 구조로 확장됐고, `crypto`는 더 작은 reserve / position cap / daily trade cap, 더 완화된 starter 승인 기준까지 분리되었다.
  - `signals / trades / trade_journal / pipeline_runs.meta`에는 `trade_mode(normal/validation)`가 저장되며, 일지/주간 리뷰도 `NORMAL / VALIDATION` 집계를 분리해서 보여준다.
  - `trading-journal.js`는 `initJournalSchema()`를 명시적으로 호출해 기존 DB에서도 `trade_journal.trade_mode` 마이그레이션을 선행하도록 복구됐다.
  - `crypto.js`는 `trade_mode`별 상태 파일을 분리해, validation canary가 normal 레일의 쿨다운/긴급트리거 상태를 공유하지 않도록 정리됐다.
  - 레거시 `.llm-emergency-stop`의 `investment` scope는 이제 `investment.normal`만 막고 `investment.validation`은 막지 않는다.
  - 암호화폐 validation은 일간 기준 `BUY 2 / approved 2 / executed 2 / PAPER 2건`이 확인돼 `승격 후보`로 읽힌다.
  - 국내장 validation은 일간 기준 `BUY 3 / approved 3 / executed 1 / LIVE 1건`이 확인돼 `승격 후보`로 읽힌다.
  - 국내장 validation 강제 세션에서는 `214390 BUY 500000 자동 승인`, `최종 결과: 1개 신호 승인`까지 확인됐다.
  - `runtime-config-suggestions.js`는 validation 성과를 actual `trades` 기준으로 보정해 `normal 승격 후보`를 직접 제안한다.
  - 국내장 normal 정책은 validation 성과를 반영해 `stockStarterApproveDomestic=450000`까지 제한 승격됐다.
- 블로그
  - `ai.blog.node-server`는 이번 세션에서 launchd 재등록으로 복구됐고, `node-server API`까지 health-report 기준 정상이다.
  - 재부팅 후에는 `/tmp/post-reboot-followup.txt`를 확인하고, 상태 변화가 있으면 문서와 세션 인수인계를 다시 갱신해야 한다.
  - 최근 dry-run 기준 현재 로컬 launchd 상태는 `OK 5 / WARN 16 / FAIL 12`로 보고되어, 실제 재부팅 후에는 팀별 `health-report --json` 2차 확인이 필수다.

---

## 2. 현재 진행 Phase

### 플랫폼 관점

- `운영 데이터 신뢰성 강화 + 모바일 알림 최적화 + 관찰 단계 전환` 단계

### 워커 관점

- `문서 파싱 → 문서 재사용 → 실제 업무 생성 결과 추적 → 품질/효율 분석 → 개선 후보 리뷰` 단계까지 확장
- `LLM API 현황`과 `블로그 URL 입력`이 마스터 운영 콘솔에 올라왔고, 다음은 `OpenClaw` 조회 전용 그룹을 추가해 전사 LLM 현황 범위를 넓히는 단계

### 스카 관점

- `기존 엔진 유지 + shadow 비교 모델 관찰` 단계
- 현재 `shadowDecision.stage = collecting`
- 다음은 `primary vs shadow` actual 비교 누적 관찰 단계

---

## 3. 다음 작업 목표

1. 투자 normal / validation 분리 관찰
   - 적용값: `screening.crypto.max_dynamic=12`, `minConfidence.live.binance=0.44`, `debateThresholds.crypto=0.56/0.18`, `fastPath minCryptoConfidence=0.40`, `stockStarterApproveDomestic=450000`
   - 현재 성과:
     - crypto validation `PAPER 2건`
     - domestic validation `LIVE 1건`
   - 확인 항목: `crypto/domestic/overseas BUY / SELL / HOLD`, `approved`, `executed`, `LIVE/PAPER`, `NORMAL/VALIDATION`, `weakSignalSkipped`, `riskRejected`, `nemesis_error`, `legacy_executor_failed`
   - 운영 체크리스트: [INVESTMENT_VALIDATION_OBSERVATION_CHECKLIST_2026-03-19.md](/Users/alexlee/projects/ai-agent-system/docs/INVESTMENT_VALIDATION_OBSERVATION_CHECKLIST_2026-03-19.md)
2. 스카 shadow 비교 actual 누적 관찰
   - 현재 `availableDays = 0`
   - 일일 최소 3일 / 주간 최소 5일 누적이 필요
   - `availableDays > 0`가 생기기 시작하면 `collecting -> observe` 진입 여부 판단
3. 워커 문서 효율 후보 관찰
   - 개선 후보 문서 / 템플릿 후보 / OCR 재검토 후보가 실제로 생기는지 확인
4. `LLM API 현황`에 OpenClaw 조회 전용 그룹 추가
   - 현재 전사 현황은 Jay / Worker / Claude / Blog / Investment까지만 포함
   - 내일은 `OpenClaw`를 조회 전용 그룹으로 붙여 전사 LLM 현황 범위를 확장
5. 남은 자동화 확정
  - 스카 shadow 일일/주간
  - 워커 문서 효율 일일/주간
  - 투자 설정 제안 일일/주간
6. 자동화 리포트 운영 데이터 관찰
  - 제이 Gateway `persisted` 상태
  - 제이 일일 리뷰 `dbSource=db / snapshot_fallback` 전환 패턴
  - 일일 운영 분석의 `activeIssues / historicalIssues / inputFailures` 축적 패턴
  - investment / reservation `local fallback 활동 신호`가 실제 운영 상태를 안정적으로 대변하는지
  - 투자 `no-trade high-cost` 경고 발생 여부
  - 스카 `actionItems`가 실제 튜닝 판단에 충분한지 확인
7. 제이 DB 접근 컨텍스트 복구
   - `jay-llm-daily-review.js`는 현재 `dbStatsStatus=partial` 상태
   - `reservation.llm_usage_log`, `claude.command_history` 접근이 자동화 컨텍스트에서 `EPERM`으로 막히고 있어 PostgreSQL 접근 권한 또는 실행 컨텍스트를 복구해야 함
8. 루나 시스템 재점검 Phase 후속 관찰
   - 현재는 퍼널 계측, crypto 보수성 완화, `normal/validation`, `trade_mode` 영속화까지 반영된 상태
   - 다음은 `LUNA_RESET_AUDIT_PLAN_2026-03-19.md` 기준으로 validation 결과를 normal 정책에 승격할지, 부분 보완을 유지할지, 재설계로 전환할지 판단
9. 재부팅 후 운영 검증
   - `bash /Users/alexlee/projects/ai-agent-system/scripts/post-reboot.sh --dry-run`
   - `/tmp/post-reboot.log`
   - `/tmp/post-reboot-followup.txt`
   - worker / orchestrator / investment / blog health-report 재확인

---

## 4. 현재 열린 이슈

- 스카 shadow 비교는 저장은 정상이나 아직 actual 누적이 부족해서 비교 일수는 `0`
- 스카 일일/주간 리뷰는 이제 `shadowDecision`으로 현재 단계(`collecting / observe / promotion_candidate / primary_hold`)를 명시
- 자동화 런타임에서 일부 `health-report.js`가 직접 실패하는 경향이 있어 `fallback_probe_unavailable`이 남을 수 있음
- 제이 Gateway 자동화는 review 강인성은 올라갔지만, `~/.openclaw/workspace` 쓰기 권한 문제로 `persisted=false`가 남을 수 있어 운영 환경에서 재확인 필요
- 제이 Gateway 자동화는 repo 내부 fallback 저장으로 기록은 남기지만, 운영 기본 경로(`~/.openclaw/workspace`) 쓰기 권한은 여전히 재확인 필요
- `jay-llm-daily-review.js`는 더 이상 완전 degraded가 아니라 `partial`로 동작하지만, DB source(`llmUsage`, `parseHistory`)는 아직 `EPERM`으로 실패한다
- `daily-ops-report.js`는 investment / reservation에 대해 `local fallback 활동 신호`를 보이지만, 여전히 원본 `health-report`의 DB 접근 제한은 별도 복구가 필요하다
- `jay-llm-daily-review.js`는 이제 snapshot fallback으로 운영 리포트 연속성은 확보했지만, live DB query 자체의 `EPERM` 원인은 아직 별도 운영 컨텍스트 복구가 필요하다
- `daily-ops-report.js`는 이제 `sourceMode`를 함께 출력해 `orchestrator / worker / claude / blog`는 `unavailable`, `investment / reservation`은 `local_fallback`, global error review는 `auxiliary_review`로 읽을 수 있다
- `worker`와 `blog`의 상시 서비스 공백은 이번 세션에서 복구됐다.
- 해외장 validation은 아직 장중 + 실제 운영 컨텍스트 표본이 부족하다.
- 투자 주간 리뷰 usage는 복구됐지만, 주간/일간 usage 집계 로직을 공용 함수로 통합하면 중복 유지보수를 더 줄일 수 있다
- 루나 퍼널의 `BUY / SELL / HOLD` 분포는 저장 필드를 추가했지만, 과거 `pipeline_runs.meta`에는 값이 없어 초기 관측 구간에서는 `0`으로 보일 수 있다
- 따라서 다음 해석은 새 파이프라인 런 누적 후 진행해야 한다
- 워커 문서 재사용은 품질/효율 지표와 개선 후보 리뷰까지 붙었지만, 현재 `company_id=1` 기준 실제 문서 표본은 아직 없음
- 워커 `LLM API 현황`은 전사 콘솔로 정리됐지만, 아직 `OpenClaw`는 포함되지 않았고 내일 조회 전용 그룹으로 추가할 예정
- 투자 실험은 실제 적용까지 들어갔지만, 아직 표본이 부족해 `observe` 상태다
- OpenClaw gateway 기본 primary는 아직 `google-gemini-cli/gemini-2.5-flash`이고, 제이 명령 해석은 `gpt-5-mini`라 운영자 입장에서 모델 체계 혼선이 남아 있다
- 텔레그램 알림 포맷은 구분선/헤더/본문 압축까지 반영됐지만, 잔여 producer 미세 조정은 실제 운영 알림이 더 쌓인 뒤 확인하는 편이 안전하다
- 제이 일일 리뷰는 실제 운영 컨텍스트에서는 `dbSource=db`, 샌드박스 안에서는 `dbSource=snapshot_fallback`으로 동작해 live + fallback 이중화는 확보된 상태다
- 재부팅 절차는 개편됐지만, post-reboot 최종 판정은 아직 launchd 중심이며 팀별 `health-report --json` 2차 자동 판정까지는 붙지 않았다

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
- 알림 UX는 개별 producer 전면 수정보다 공용 sender / renderer 정규화를 우선한다.
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


---

## ★ 비디오팀 세션 컨텍스트 (2026-03-20 추가)

```
상태: 기획/설계 문서 정리 완료, 구현 스캐폴딩 시작 전
상세 인수인계: bots/video/docs/SESSION_HANDOFF_VIDEO.md

현재 확보된 문서:
  - bots/video/docs/VIDEO_HANDOFF.md
  - bots/video/docs/video-automation-tech-plan.md
  - bots/video/docs/video-team-design.md
  - bots/video/docs/video-team-tasks.md

현재 폴더 상태:
  - bots/video/는 설계/인수인계 문서 중심의 신규 팀 폴더
  - scripts/ 폴더는 제거됨 (문서 이동/배치 스크립트는 유지하지 않음)
  - 구현 코드 뼈대(context/config/migrations/src)는 아직 비어 있거나 최소 상태

다음 작업:
  1. Claude Code 과제 1 범위의 최소 스캐폴딩 생성
     - context/IDENTITY.md
     - config/video-config.yaml
     - migrations/001-video-schema.sql
     - src/index.js
  2. 워커 웹 대화형 영상 편집 UX를 기존 worker 패턴 재사용 기준으로 구체화
  3. 더백클래스 LMS 구조 학습은 Phase 2 이후 확장 과제로 분리

설계상 핵심 판단:
  - 지금 당장 필요한 구조는 Case 1 (원본 영상 편집 자동화)만 구현
  - Case 2 (완전 자동 생성), LMS 발행 자동화, 품질 루프 고도화는 후속 Phase
  - 원본/임시/결과 파일 저장소는 외부 작업 디렉토리(flutterflow_video)를 사용하고,
    리포지토리 내부 bots/video/는 오케스트레이션/설정/문서/메타데이터 레이어로 유지
```
