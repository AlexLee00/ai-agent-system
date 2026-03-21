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
  - `/video`, `/video/history`가 추가돼 영상 편집 세션 생성, 업로드, 프리뷰 확인, confirm/reject, 다운로드까지 worker-web에서 처리할 수 있다.
  - worker 비디오 업로드는 이번 세션에서 `video_sessions.company_id`를 `TEXT`로 보정해 `test-company` 같은 문자열 회사 ID에서도 세션 생성이 가능하도록 복구됐다.
  - `/video` 업로드 영역은 드래그앤드롭 + 아이콘 클릭 + 파일 선택 버튼 3가지 입력 경로를 모두 지원하도록 개선됐다.
  - 업로드 한글 파일명은 서버에서 UTF-8 복원 경계로 보정돼 `original_name`이 깨진 상태로 저장되지 않도록 복구됐다.
  - `/video`는 현재 세션 ID를 URL `?session=`과 `localStorage`에 동기화해 새로고침 후에도 진행 세션을 다시 붙잡을 수 있게 됐다.
  - `POST /api/video/sessions/:id/start`는 n8n 응답만 믿지 않고 실제 `video_edits(session_id, pair_index)` 생성까지 확인하며, 생성이 안 되면 direct fallback으로 다시 실행하도록 보강됐다.
  - `/api/video` 라우터는 `video_sessions -> video_upload_files -> video_edits` 원장 구조를 사용하며, 현재는 `projects` 권한 정책에 임시 매핑돼 있다.
  - protected preview/subtitle/download는 JWT 헤더를 직접 실을 수 없는 HTML media 태그 제약 때문에 `fetch + Authorization + blob URL` 방식으로 프론트에서 처리한다.
  - confirm 이후 final render는 `bots/video/scripts/render-from-edl.js`가 백그라운드에서 수행한다.
- 비디오
  - 비디오팀 Phase 1은 과제 1~13 + RAG 피드백 루프 기준으로 마감됐다.
  - `bots/worker/web`의 Next.js는 이번 세션에서 재빌드 후 launchd `ai.worker.nextjs`를 재기동했고, `/video`, `/video/history`는 현재 `200 OK`로 실제 반영 상태다.
  - `bots/video/lib/critic-agent.js`와 `bots/video/scripts/test-critic-agent.js`가 추가돼 RED Team Critic이 자막/오디오/영상 구조를 하나의 `critic_report.json`으로 평가할 수 있다.
  - 코드 점검 후 자막 JSON 파싱 실패 강등, config provider 준수, 인접 scene 병합을 보강했다.
  - 현재 샘플 기준 실제 Critic 결과는 `score=78`, `pass=false`, `subtitle issues=18`, `audio LUFS=-14.96`, `scene issues=10`으로 확인됐다.
  - Gemini 기반 자막 분석은 무료라 `llm_cost_usd=0`이었고, timeout 보강으로 네트워크 지연 시 무한 대기하지 않도록 했다.
  - `bots/video/lib/refiner-agent.js`와 `bots/video/scripts/test-refiner-agent.js`가 추가돼 BLUE Team Refiner가 `critic_report.json`을 받아 `subtitle_corrected_v2.srt`와 버전형 결과물을 생성할 수 있다.
  - 현재 샘플 기준 실제 Refiner 결과는 `subtitle changes=12`, `edl changes=0`, `audio 변경 없음`, `cost_usd=0`이다.
  - 코드 점검 후 Refiner도 단계별 partial failure fallback이 들어가, 자막/EDL/오디오 중 하나가 실패해도 전체 BLUE Team 실행이 중단되지 않는다.
  - `bots/video/lib/evaluator-agent.js`, `bots/video/lib/quality-loop.js`, `bots/video/scripts/test-quality-loop.js`가 추가돼 Evaluator와 품질 루프 오케스트레이션이 구현됐다.
  - Evaluator는 Refiner 수정본을 기준으로 Critic을 재호출해 점수를 재평가하고, quality-loop는 `PASS / RETRY / ACCEPT_BEST` 종료 판정과 최고 점수 버전 선택을 담당한다.
  - 현재 샘플 기준 실제 quality-loop 결과는 `iteration0 score=80`, `iteration1 score=80`, `recommendation=ACCEPT_BEST`, `final_score=80`, `pass=false`다.
  - 코드 점검 후 Evaluator는 `analysis_path`가 없는 standalone `refiner_result.json`도 sibling `analysis.json` 자동 추론으로 재평가할 수 있게 보강됐다.
  - 이번 샘플에서는 Refiner가 추가 변경을 만들지 못해 최고 버전이 원본 subtitle/EDL로 유지됐고, 다음 자연스러운 단계는 과제 13 다세트 검증과 preview wall-clock 최적화다.
  - 비디오팀 n8n 연동은 현재 live 검증까지 완료돼 `POST /api/video/sessions/:id/start`와 `POST /api/video/edits/:id/confirm`이 `runWithN8nFallback()`를 통해 `Video Pipeline` webhook을 우선 호출하고, n8n 장애 시 기존 detached fork로 direct fallback 한다.
  - 현재 n8n 런타임은 `ExecuteCommand` activation을 거부해, workflow는 `HTTP Request -> /api/video/internal/*` 구조로 호환 전환됐다.
  - `bots/worker/web/routes/video-internal-api.js`가 추가돼 n8n이 `X-Video-Token`으로 보호된 내부 dispatch API를 호출하고, 실제 프로세스 실행은 기존 `fork()` 경로를 재사용한다.
  - `packages/core/lib/n8n-runner.js`는 커스텀 헤더 전달을 지원하도록 확장됐고, 비디오 webhook은 `X-Video-Token`을 사용한다.
  - `bots/video/lib/video-n8n-config.js`가 추가돼 `VIDEO_N8N_TOKEN`을 env 우선, 없으면 `bots/worker/secrets.json`의 `video_n8n_token` fallback으로 읽도록 통합됐다.
  - `bots/video/n8n/setup-video-workflow.js`는 registry DB 조회 실패 시 기본 webhook 경로로 degrade 하도록 보강돼, setup 성공 후 URL 출력 단계에서 불필요하게 실패하지 않는다.
  - sandbox 밖 live 검증 기준 현재 상태는 `n8nHealthy=true`, `webhookRegistered=true`, `webhookStatus=200`, `resolvedWebhookUrl=http://127.0.0.1:5678/webhook/eJrK6wh4S8qAkuw9/webhook/video-pipeline`이다.
  - 이후 실제 운영 `bots/worker/secrets.json`에 `video_n8n_token`을 반영했고, launchd env 없이도 setup/check 스크립트와 내부 dispatch probe가 정상 동작하는 것까지 확인됐다.
  - 이번 라운드에서 `packages/core/lib/rag.js`에 `rag_video` 컬렉션이 추가됐고, `bots/video/lib/video-rag.js`가 편집 결과/피드백 저장, 유사 패턴 검색, Critic/EDL 보강, 예상 시간 추정을 담당하게 됐다.
  - `run-pipeline.js`, `critic-agent.js`, `edl-builder.js`, `bots/worker/web/routes/video-api.js`가 RAG와 연결돼 비디오 품질 루프가 이제 과거 편집 패턴을 학습할 수 있는 구조로 확장됐다.
  - 5세트 전체 `run-pipeline.js --skip-render` 재검증 결과 현재는 파라미터/컴포넌트스테이트/동적데이터/서버인증/DB생성 모두 `preview_ready`까지 복구됐다.
  - 이번 worker 실사용 테스트에서는 `video_sessions.id=1`이 새로고침 후 세션 컨텍스트를 잃어 `processing`으로만 남는 문제가 있었고, 세션 복원 로직과 start 검증 fallback을 추가한 뒤 `video_edits.id=16`으로 직접 복구했다.
  - 세션 1의 프리뷰 검은 화면은 `edl-builder.js`에서 연속 `fade in/out` transition을 같은 스트림에 체인 적용한 것이 원인이었고, 현재는 transition을 EDL 원장에만 남기고 렌더 단계에서는 임시 비활성화한 상태다.
  - 초기 5세트 실패의 실제 원인은 preview watchdog 자체가 아니라 `ffmpeg-preprocess.syncVideoAudio()`가 나레이션 길이에 맞춰 영상을 자르지 않아 `synced.mp4`의 video/audio duration이 크게 어긋난 것이었다.
  - `syncVideoAudio()`에 audio duration 기준 `-t` + `-shortest`를 적용한 뒤 5세트가 모두 정상 통과했고, `subtitle.vtt`는 preview 전에 생성되도록 이동해 artifact 정합성도 회복됐다.
  - 최신 종합 리포트는 `bots/video/temp/validation_report.json`에 저장돼 있으며 요약값은 `successful=5`, `failed=0`, `avg_total_ms=440378`, `rag_records_stored=7`이다.
- 스카
  - 기존 예측 엔진은 유지되고 있다.
  - `knn-shadow-v1` shadow 비교 모델이 `forecast_results.predictions`에 저장되기 시작했다.
  - 일일/주간 예측 리뷰와 자동화는 shadow 비교를 읽도록 확장됐다.
  - `naver-monitor` 취소 감지 루프에서 `pendingCancelMap` shape 충돌로 `bookingId` 예외가 반복되던 버그를 수정했다.
  - `today cancelledCount`가 증가했는데 실제 신규 취소 처리 0건이면 `cancel counter drift` 경고를 즉시 alert로 올리도록 보강했다.
  - `reservation health-report`는 이제 `cancelCounterDriftHealth`와 샘플 메시지를 함께 보여준다.
  - `duplicate slot audit`가 reservation health-report에 추가돼, 같은 슬롯 duplicate를 `risky(활성 중복)`와 `historical(과거 취소/재예약 이력)`로 분리해서 보여준다.
  - `bots/reservation/scripts/audit-duplicate-slots.js --json`가 추가돼 duplicate group의 실제 row id / status / 권장 조치를 health summary보다 자세히 볼 수 있다.
  - 2026-03-21 실운영 복구:
    - 박수민 `2026-03-21 01:00~03:30 A1`
    - 김경혜 `2026-03-27 17:30~18:30 A1`
    두 누락 취소를 `pickko-cancel-cmd.js`로 수동 복구했고, reservation DB 상태도 `cancelled / cancelled`로 정합성 복구했다.
  - 수동 취소 후에는 실제 픽코/네이버 취소만 끝내지 말고 `reservations.status`, `pickko_status`, `marked_seen`, `cancelled_keys`, `doneKey`, alert resolve까지 같이 맞춰야 한다.
  - duplicate slot 전수 점검 결과 현재 `risky duplicate = 0`, `historical duplicate = 3`이며, 현재 3건은 `completed + cancelled` 또는 `cancelled + cancelled`로 확인돼 즉시 cleanup 대상은 아니다.
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
  - 루나 rail guard 보강이 연속 반영됐다.
    - `daily trade limit`는 이제 `exchange + trade_mode` 기준으로 분리 집계된다.
    - `signals` 저장 단계에는 `same symbol + same action + same exchange + same trade_mode` 기준 recent dedupe가 붙었다.
    - `paper positions`는 `symbol + exchange + paper + trade_mode` scope로 분리돼 normal/validation 실험이 섞이지 않는다.
    - `same-lane open position reentry`와 `same-day same-lane reentry` 차단이 `hephaestos / hanul`에 공통 반영됐다.
  - investment health-report는 이제 다음을 함께 보여준다.
    - 오늘 `signal block_code / 세부 reason group`
    - 최근 60분 `signal block pressure`
    - 최근 60분 `daily_trade_limit rail pressure`
    - rail별 신규 진입(BUY) 한도 사용량
    - 당일 체결이 없어도 configured rail별 `0/limit` 상태를 계속 보여준다.
  - scheduled market worker(`crypto/domestic/overseas`)는 코드 파일 시각이 stderr보다 최신이면 과거 `last exit 1`을 stale failure로 간주해 health false warning을 줄이도록 보정됐다.
  - `daily_trade_limit`는 이제 SELL이 아니라 BUY 신규 진입만 집계한다.
  - 2026-03-20 운영 조정:
    - 로컬 운영 `bots/investment/config.yaml`에서 `binance validation max_daily_trades`를 `8 -> 10`으로 상향했다.
    - 이 파일은 `.gitignore` 대상이라 저장소에는 남지 않으며, 운영 메모/핸드오프로만 추적한다.
    - health-report 기준 현재 `BINANCE / validation 3/10`, 최근 60분 차단/거부 `2건`, 세부 그룹은 모두 `daily_trade_limit`이다.
    - 다음 세션부터는 `■ 최근 60분 rail 압력` 섹션으로 실제 압력이 `BINANCE / validation`에 몰리는지 바로 확인할 수 있다.
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
- 영상 편집은 이제 worker-web 세션/프리뷰 UI까지 연결됐고, 다음은 실제 운영 기준 `preview_ready -> confirming -> rendering -> done` 루프를 더 안정화하는 단계

### 스카 관점

- `기존 엔진 유지 + shadow 비교 모델 관찰` 단계
- 현재 `shadowDecision.stage = collecting`
- 다음은 `primary vs shadow` actual 비교 누적 관찰 단계
- 수동등록 후 네이버 예약불가 후속 차단은 이번 세션에서 silent failure를 원장에 남기도록 보강됐다.
- `kiosk_blocks`에는 이제 `last_block_attempt_at`, `last_block_result`, `last_block_reason`, `block_retry_count`가 저장돼 실제 실패 / 지연 후 재시도 / 성공을 구분할 수 있다.
- `naver-monitor.js`는 더 이상 `manual`, `manual_retry`, `verified`, `completed` 예약을 자동 취소 대상에서 잘못 스킵하지 않는다.
- 민경수 `2026-03-27 A1` 연속 4건과 인접 manual 등록 건들은 이번 원장 조회에서 `manual 등록 완료 + naver_blocked=false`로 확인돼, false alert가 아니라 실제 후속 차단 누락 사례로 분류됐다.
- 이후 운영자가 네이버 예약관리에서 해당 미래 슬롯들을 직접 확인했고, 이번 수동 점검 대상 8건은 모두 처리 완료됐다.
- 이후 `manual-block-followup-resolve.js`로 해당 8건을 `kiosk_blocks` 원장에 `manually_confirmed / operator_confirmed_naver_blocked` 상태로 반영했고, `manual-block-followup-report.js --from=2026-03-21` 기준 현재 `openCount=0`이다.
- 새 원장 필드는 이번 패치 이후 발생하는 후속 차단 시도부터 채워지며, 과거 누락 건은 별도 운영 점검/백필이 필요하다.

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
7. 비디오 품질 루프 확장
  - 과제 10 Critic, 과제 11 Refiner, 과제 12 Evaluator/quality-loop, 과제 13 5세트 preview 검증까지 완료
  - 다음은 preview wall-clock을 원장에 따로 저장하는 구조 보강, 세션 1 프리뷰 재검증, transition 렌더 재설계, final render 다세트 실검증
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
- 스카 수동등록 후속 차단 경로는 이제 결과 원장화를 시작했지만, 과거 manual 등록 건은 새 필드가 비어 있어 historical 분석에는 바로 쓰기 어렵다.
- 최근 manual 등록건 중 `reservations.pickko_status='manual'`인데 `kiosk_blocks.naver_blocked=false`인 사례는 이번 1차 리스트를 운영자가 직접 처리 완료했다.
- 다음 단계는 새 원장 필드(`last_block_*`, `block_retry_count`)가 이후 발생하는 건에서 실제로 채워지고, 후속 사이클에서 `naver_blocked=true`로 수렴하는지 확인하는 것이다.
- `bots/reservation/manual/reports/manual-block-followup-report.js`와 `manual-block-followup-resolve.js`가 추가돼, 앞으로는 손조회 대신 CLI로 미완료 건 조회와 운영 확인 반영이 가능하다.
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
- `binance validation max_daily_trades`는 로컬 운영값으로 `10`이 적용돼 있지만 tracked config가 아니므로, 재배포/환경 복구 시 누락될 수 있다
- 따라서 다음 투자 세션 시작 시 `health-report --json`에서 `BINANCE / validation 3/10`처럼 limit가 실제 반영됐는지 먼저 확인하는 것이 안전하다
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
3. [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
4. [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
5. [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
6. [RESEARCH_JOURNAL.md](/Users/alexlee/projects/ai-agent-system/docs/RESEARCH_JOURNAL.md)

코덱 세션 규칙:
- 코덱은 새 세션 시작 시 위 문서 묶음을 먼저 읽고 작업을 시작한다.
- 코덱은 세션 마감 직전 이 문서를 다시 확인하고, 실제 변경 사항이 있으면 `SESSION_HANDOFF / WORK_HISTORY / CHANGELOG / TEST_RESULTS`를 함께 갱신한다.

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
상태: 과제 1~6 핵심 모듈 구현 완료, 과제 7 run-pipeline 1차 통합 완료, preview 최적화 대기
상세 인수인계: bots/video/docs/SESSION_HANDOFF_VIDEO.md

현재 확보된 문서:
  - bots/video/docs/CLAUDE.md
  - bots/video/docs/VIDEO_HANDOFF.md
  - bots/video/docs/video-automation-tech-plan.md
  - bots/video/docs/video-team-design.md
  - bots/video/docs/video-team-tasks.md
  - bots/video/samples/ANALYSIS.md

현재 폴더 상태:
  - bots/video/는 문서 + 과제 1 스캐폴딩(config/context/migrations/src)까지 반영된 신규 팀 폴더
  - scripts/ 폴더는 다른 bots와 같은 공통 구조용 예약 폴더로 유지
  - config/video-config.yaml, context/IDENTITY.md, migrations/001-video-schema.sql, src/index.js 생성 완료
  - lib/ffmpeg-preprocess.js, scripts/test-preprocess.js 생성 완료
  - lib/whisper-client.js, scripts/test-whisper.js 생성 완료
  - lib/subtitle-corrector.js, scripts/test-subtitle-corrector.js 생성 완료
  - lib/capcut-draft-builder.js, scripts/test-capcut-draft.js 생성 완료
  - lib/video-analyzer.js, scripts/test-video-analyzer.js 생성 완료
  - lib/edl-builder.js, scripts/test-edl-builder.js 생성 완료
  - scripts/run-pipeline.js 추가, src/index.js는 loadConfig export 구조로 리팩터링 완료
  - temp/, exports/ 디렉토리 생성 완료
  - public.video_edits 테이블 생성 및 조회 검증 완료
  - 샘플 1세트 기준 FFmpeg 전처리 테스트(removeAudio / normalizeAudio / syncVideoAudio / preprocess) 통과
  - 나레이션 44100Hz mono → 48000Hz stereo AAC 리샘플링 확인
  - LUFS `-14.9` 확인 (목표 -14 ± 2)
  - Whisper STT 샘플 테스트 통과
  - `temp/subtitle_raw.srt` 생성 확인
  - `67 segments` 반환 확인
  - `llm_usage_log`에 `whisper-1`, `$0.026119`, `audio_transcription` 기록 확인
  - 자막 교정 샘플 테스트 통과
  - `temp/subtitle_corrected.srt` 생성 확인
  - entries `67` 유지, 타임스탬프 `67/67` 보존 확인
  - `llm_usage_log`에 `gpt-4o-mini`, `subtitle_correction`, 비용 로그 확인
  - subtitle_correction fallback 모델을 `gemini-2.5-flash`로 갱신
  - `quality_loop`를 `critic/refiner/evaluator` 역할별 모델 구조로 확장
  - CapCut 드래프트 빌더 구현 완료
  - `healthCheck / createDraft / addVideo / addAudio / addSubtitle / saveDraft / findDraftFolder / copyToCapCut / buildDraft` 통합 구현 확인
  - CapCutAPI upstream `add_subtitle`의 `font_type` 오류를 피하기 위해 기본 `font='文轩体'`, `vertical=false`, `alpha=1.0`, `width/height` 전달 보강
  - `node bots/video/scripts/test-capcut-draft.js` 통과
  - repo 내부 `dfd_cat_*` draft 생성 + CapCut Desktop 프로젝트 폴더 복사 확인
  - CapCut Desktop 프로젝트 목록에 새 draft 카드 표시 확인
  - 단, CapCut Desktop 내부 타임라인/미디어/자막은 비어 있어 CapCut draft parser 전략은 폐기
  - 메인 파이프라인은 CapCut 의존 대신 EDL JSON + FFmpeg로 재정의 중
  - 120초 smoke clip 기준 `analyzeVideo()`, EDL 생성, 720p preview, 1440p final render 검증 완료
  - smoke final 결과 `2560x1440`, `60fps`, `H.264 High`, `48kHz stereo`, `faststart` 확인
  - `node bots/video/scripts/run-pipeline.js --source=1 --skip-render` 실검증에서 전처리 → STT → 자막교정 → 영상분석 → EDL 생성까지 완료 확인
  - scene 중복 감지를 줄이기 위해 EDL builder에 인접 transition merge 보정을 추가
  - `run-pipeline`는 이제 single-flight lock으로 동시 실행을 즉시 차단하고, stale lock / SIGINT / SIGTERM 정리까지 수행
  - 실자산 preview 렌더도 진행되지만 wall-clock이 길어 과제 7은 preview 최적화와 최종 end-to-end 검증이 다음 경계
  - 현재 로컬 FFmpeg는 `drawtext`, `subtitles` 필터가 없어 overlay / burn-in은 자동 생략 fallback으로 동작
  - YouTube 렌더링 확정값(24M / 48kHz / 384kbps / faststart)은 video 문서 세트에 반영 완료
  - task 프롬프트는 하드코딩보다 config 참조 우선으로 정리 완료
  - ANALYSIS.md는 초기 분석값과 최종 확정값을 구분하도록 정리 완료

다음 작업:
  1. 과제 7 엔드투엔드 통합 마감
     - 전처리 → STT → 교정 → 분석 → EDL → preview/final runner는 구현됨
     - 남은 것은 실자산 preview wall-clock 최적화와 장시간 전체 자산 기준 render/analysis 운영 시간 측정
  2. 자막 번인용 FFmpeg capability 확보 또는 대체 실행 환경 정리
  3. 워커 웹 대화형 영상 편집 UX를 기존 worker 패턴 재사용 기준으로 구체화

설계상 핵심 판단:
  - 지금 당장 필요한 구조는 Case 1 (원본 영상 편집 자동화)만 구현
  - Case 2 (완전 자동 생성), LMS 발행 자동화, 품질 루프 고도화는 후속 Phase
  - 원본/임시/결과 파일 저장소는 외부 작업 디렉토리(flutterflow_video)를 사용하고,
    리포지토리 내부 bots/video/는 오케스트레이션/설정/문서/메타데이터 레이어로 유지
  - Claude는 video 폴더 문서를 읽고 구조를 해석하는 역할이며, 실제 코드 업데이트는 코덱 또는 Claude Code가 수행
  - 비디오팀 개발도 각 과제 종료 시 문서 업데이트 + 커밋/푸시까지 함께 마감
```

## 2026-03-21 — 스카 매출 정책 전환 / 과거 데이터 재검증

- 스카 스터디룸 매출 기준을 `픽코 amount`에서 `예약 시간 기반 산출식`으로 전환
  - 이유: 네이버 예약은 픽코 등록 시 금액을 `0원`으로 수정하고 있어 예약목록 `이용금액`을 신뢰할 수 없음
  - 정책:
    - `A1/A2`: `30분당 3,500원`, `00:00~09:00`은 `30분당 2,500원`
    - `B`: `30분당 6,000원`, `00:00~09:00`은 `30분당 4,000원`
- 코드 반영:
  - `bots/reservation/lib/study-room-pricing.js` 신규
  - `bots/reservation/auto/scheduled/pickko-daily-summary.js`
  - `bots/reservation/scripts/pickko-revenue-backfill.js`
  - `bots/reservation/scripts/health-report.js`
- 운영 조치:
  - `2026-03` 전체 backfill 재실행
  - `2026-03-10` timeout 잔여값 직접 재검증/복구
  - `2026-02` 전체 backfill 재실행으로 `2026-02-27` stale row 복구
  - `syncSkaSalesToWorker('test-company')` 재실행
- 최종 검증:
  - 과거 전체 source(`reservation.daily_summary`) vs worker mirror(`worker.sales`, `test-company`) diff `0건`
  - `node bots/reservation/scripts/health-report.js --json` 기준 `dailySummaryIntegrityHealth.issueCount = 0`
  - 남는 `policyDivergenceCount = 14`는 `pickko_total`과 운영 산출식 차이이며 정책상 정상 가능
- 주의:
  - 이제 `pickko_total == general_revenue + pickko_study_room`은 무결성 불변식이 아님
  - 실제 저장 오류는 `room_amounts_json`과 `pickko_study_room` 불일치만 보면 됨

## 2026-03-22 — 스카 수동등록 후속 차단 / 취소 완결성 보강

- 수동등록 후 네이버 예약불가 후속 차단의 silent failure를 더 이상 방치하지 않도록 `kiosk_blocks` 원장에 `last_block_attempt_at`, `last_block_result`, `last_block_reason`, `block_retry_count`를 남기는 구조를 붙였고, `manual-block-followup-report.js`, `manual-block-followup-resolve.js`로 운영 점검/수동 확인 반영 루프를 만들었다.
- 최근 미래 `manual/manual_retry` 예약 중 네이버 차단 미완료 후보 8건을 실제 네이버 예약관리에서 확인 후 처리했고, `manual-block-followup-resolve.js`로 `manually_confirmed / operator_confirmed_naver_blocked` 상태를 원장에 반영해 `openCount=0` 기준점을 확보했다.
- `pickko-kiosk-monitor.js`는 이제 `manual follow-up open` 건도 정기 재시도 레일에 포함하며, B룸 오전 슬롯의 잘못된 시간대/잘못된 셀을 건드리는 문제를 줄이기 위해 visible time axis 기준 Y축 보정, available-only 필터, slot guard, trailing half-hour verify 보강을 적용했다.
- 이재룡 `010-3500-0586 / 2026-11-28 11:00~12:30 B` 테스트 예약은 block 경로 기준 `already_blocked`로 수렴했고, `manual-block-followup` 원장 기준 `naver_blocked=1`, `last_block_result=blocked`, `last_block_reason=already_blocked` 상태로 정리됐다.
- `naver-monitor.js`의 자동 취소 경로는 이제 픽코 취소 성공 후 `pickko-kiosk-monitor.js --unblock-slot`까지 후속 실행하도록 보강됐다. 즉 자동 취소도 `취소 감지 -> 픽코 취소 -> 네이버 예약가능 복구`의 완결 경로를 갖는다.
- 추가로 `pickko-cancel-cmd.js`는 `픽코 취소 성공 + 네이버 해제 실패`를 더 이상 `success: true`로 포장하지 않고 `success: false`, `partialSuccess: true`, `pickkoCancelled: true`, `naverUnblockFailed: true`로 반환하도록 바꿔 상위 응답 레이어가 완전 성공으로 오해하기 어렵게 만들었다.
- 현재 남은 핵심은 두 가지다.
  1. 상위 텔레그램 응답 레이어가 `partialSuccess / naverUnblockFailed`를 그대로 반영해 “픽코 취소 완료, 네이버 수동 확인 필요” 문구로 분기하는지 실전 확인
  2. `naver-monitor`의 미래 취소 스캔 범위가 현재 11월 테스트 예약을 직접 커버하지 못하므로, 자동 취소 테스트는 더 가까운 날짜 예약 또는 scan window 확장 기준으로 다시 검증 필요
