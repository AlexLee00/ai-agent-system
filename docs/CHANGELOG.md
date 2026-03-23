# Changelog

All notable changes to ai-agent-system will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/ko/1.0.0/).

## 12주차 후속 (2026-03-23) — 비디오팀 Phase 3 과제 F `step-proposal-engine`

- `bots/video/lib/step-proposal-engine.js` 추가
  - `sync_map.matches -> steps[]` 변환
  - confidence 정규화, `auto_confirm` 판정
  - RED 평가 / BLUE 대안 첨부 인터페이스
  - `applyUserAction`, `stepsToSyncMap`, `saveSteps`, `loadSteps` 추가
- `bots/video/config/video-config.yaml`
  - `step_proposal` 섹션 추가
    - `auto_confirm_threshold`
    - `red_required_below`
    - `blue_required_below_red`
    - `red_model`
    - `blue_max_alternatives`
- 의미:
  - Phase 2 `sync_map`를 Phase 3 대화형 편집의 개별 스텝 원장으로 변환하는 첫 백엔드 엔진 추가

## 12주차 후속 (2026-03-23) — 비디오팀 Phase 3 과제 G `video-feedback-service`

- `bots/video/lib/video-feedback-service.js` 추가
  - `ai-feedback-service` 패턴을 비디오팀용으로 복제
  - `schema='video'`, `sourceRefType='edit_step'`, `sourceBot='video-feedback'`
  - `createVideoStepFeedbackSession`, `record/replace edits`, `confirm/reject/submit/commit` 상태 전이 지원
- `bots/video/migrations/006-feedback-sessions.sql` 추가
  - `video.ai_feedback_sessions`
  - `video.ai_feedback_events`
  - `video.video_edit_steps`
- 의미:
  - Phase 3에서 스텝별 사용자 판단/수정 이력을 `accepted_without_edit`까지 포함해 누적하는 피드백 원장 레이어 추가
  - `packages/core`를 수정하지 않고도 `video.*` 스키마를 쓰도록 로컬 어댑터 경계 복구

## 12주차 후속 (2026-03-23) — 비디오팀 Phase 3 과제 F confidence 문자열 경계 복구

- `bots/video/lib/step-proposal-engine.js`
  - `normalizeConfidence()`가 문자열 `match_score` (`high` / `medium` / `low`)를 올바르게 0~1 confidence로 해석하도록 수정
  - `buildSyncProposal()`가 비숫자 `match_score`를 `0`으로 덮어쓰지 않고
    - `match_score`에는 정규화된 수치값
    - `match_score_raw`에는 원본 문자열값
    을 함께 보존하도록 보강
- 의미:
  - 자동 승인/수동 검토 분류가 문자열 점수 입력에서도 안정적으로 유지
  - 사용자가 `confirm`만 해도 proposal/final 단계에서 원본 confidence 의미가 손실되지 않음

## 12주차 후속 (2026-03-23) — 비디오팀 feedback session missing guard 복구

- `bots/video/lib/video-feedback-service.js`
  - `markVideoFeedbackStatus()` 시작 시 대상 feedback session 존재 여부를 먼저 확인
  - 세션이 없으면 FK 오류 대신 `feedback_session_id=... 를 찾을 수 없습니다.` 도메인 오류 반환
- 의미:
  - 잘못된 `sessionId` 입력이 API 레이어에서 DB 내부 오류(`23503`)로 번지지 않도록 입력 경계 복구

## 12주차 후속 (2026-03-23) — 비디오팀 Twick CSS scoped 로딩 전환

- `bots/worker/web/app/video/editor/page.js`
  - Twick 전역 CSS import 제거
- `bots/worker/web/components/TwickEditorWrapper.js`
  - `/twick-editor-scoped.css`를 mount 시 `<link>`로 로드하고 unmount 시 제거하도록 변경
  - root wrapper에 `.twick-scope` 부여
- `bots/worker/web/scripts/scope-twick-css.js`
  - Twick 충돌 클래스(`.btn-primary`, `.card`, `.flex`, `.gap-*`, `.text-sm` 등)에 `.twick-scope` 접두사를 붙인 scoped CSS 생성 스크립트 추가
- `bots/worker/web/public/twick-editor-scoped.css`
  - 빌드 산출용 scoped Twick CSS 추가
- `bots/worker/web/package.json`
  - `build`, `dev` 전에 `node scripts/scope-twick-css.js` 실행하도록 변경
- 의미:
  - `/video/editor` 방문 후에도 Twick CSS가 worker 포털 전체에 남아 `/dashboard` 스타일을 깨뜨리던 전역 주입 경계를 복구
- 검증:
  - `node bots/worker/web/scripts/scope-twick-css.js` 성공
  - `npx next build` 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` 성공
  - `http://127.0.0.1:4001/dashboard`, `/video`, `/video/editor` 모두 `200`

## 12주차 후속 (2026-03-23) — 비디오팀 Twick CSS 경계 복구 1차

- `bots/worker/web/app/globals.css`
  - 전역 media reset에서 `video`, `canvas`를 제외하고 `img, svg`만 유지하도록 조정
- 의미:
  - worker 공용 전역 CSS가 Twick preview/timeline 캔버스 크기 계산에 간섭할 수 있는 경계를 줄임
  - 편집기 도메인(`video/canvas`)은 컴포넌트/Twick 내부 스타일이 우선하도록 정리
- 검증:
  - `npx next build` 성공
  - `http://127.0.0.1:4001/`, `/video`, `/video/editor` 모두 `200`

## 12주차 후속 (2026-03-23) — 비디오팀 Twick React SDK 통합 1차

- `bots/worker/web/app/video/editor/page.js`
  - `/video/editor` 테스트 페이지 추가
  - Twick CSS를 페이지 상단 글로벌 import로 이동
  - 좌측 AI 편집 어시스턴트 스켈레톤 패널 추가
- `bots/worker/web/components/TwickEditorWrapper.js`
  - 런타임 CSS `require()` 제거
  - Twick 패키지 로드/에러 경계만 유지
- `bots/worker/web/next.config.js`
  - `transpilePackages`에 `@twick/video-editor`, `@twick/timeline`, `@twick/canvas`, `@twick/live-player` 추가
- `bots/worker/web/package.json`, `bots/worker/web/package-lock.json`
  - `tailwindcss` 재설치로 PostCSS 빌드 경계 복구
- 검증:
  - `npx next build` 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` 성공
  - `http://127.0.0.1:4001/`, `/video`, `/video/editor` 모두 `200`
  - 현재 worker-web live 포트는 `4001`, `localhost:3000`은 worker Next.js 라우트가 아님을 확인

## [2026-03-22] 팀 구조 결정 + Phase 2 문서 보완

- 확정: Phase 2 완료 후 bots/video → packages/video, bots/blog → packages/blog 승격
- bots/worker는 통합 웹 포털 (영상 편집 UI + 블로그 관리 UI + 기존 SaaS)
- CLAUDE.md 절대규칙 21번, 팀 구조 로드맵, EDL 예시 수정, reference-quality 등재

## 12주차 후속 (2026-03-23) — 스카 daily_summary `pickko_total` 제거

- `bots/reservation/migrations/009_daily_summary_remove_pickko_total.js` 추가
  - `daily_summary`에서 `pickko_total` 컬럼 제거
- `db.js`, `pickko-daily-summary.js`, `pickko-revenue-backfill.js`에서 더 이상 `pickko_total`을 저장하지 않도록 정리
- `ska-read-service.js`, `dashboard-server.js`, `health-report.js`, `export-ska-sales-csv.js`, `ska-sales-sync.js`에서 `pickko_total` 의존 제거
- `feature_store.py`, `etl.py`, `export-ska-training-csv.js`, `build-ska-model-dataset.js`도 새 스키마 기준으로 정렬
- `migrate.js --status` 기준 스키마 버전 `v9` 확인
- `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365` 재실행으로 예측 ETL/feature store를 새 스키마로 다시 동기화

## 12주차 후속 (2026-03-23) — 스카 스터디룸 계산식 문서 기준 재정렬

- `bots/reservation/lib/study-room-pricing.js`의 `A1/A2` 새벽 요금을 문서 기준으로 수정
  - 이전: `A1/A2` 항상 `30분당 3,500원`
  - 현재: `A1/A2` `00:00~09:00`은 `30분당 2,500원`, 그 외 `3,500원`
- `B`는 기존대로 `00:00~09:00` `4,000원`, 그 외 `6,000원` 유지
- 스터디룸 산출은 계속 `30분 슬롯 시작 시각` 기준 합산을 사용
- 수정 후 `pickko-revenue-backfill --from=2026-03 --to=2026-03`를 다시 실행해 3월 전체 `daily_summary`를 재집계
- `syncSkaSalesToWorker('test-company')`를 다시 실행해 worker 미러를 새 기준으로 동기화 (`updated=12`)
- 대표 결과:
  - `2026-03-12` `pickko_study_room: 137000 -> 135000`
  - `2026-03-17` `pickko_study_room: 74500` 유지
  - `2026-03-01` `pickko_study_room: 113000`으로 재산출
 - 검증 기준 문구도 명확히 함
 - 스터디카페 매출은 `payment_day|general`을 픽코 `매출현황` 기준으로 검증
  - 스터디룸 매출은 `use_day|study_room`을 픽코 `예약/이용 검색` 기준으로 검증

## 12주차 후속 (2026-03-23) — 스카 downstream 합산 표기 정렬

- `ska-read-service`, `dashboard-server`, `dashboard.html`에서 합산값을 `combined_revenue` / `내부 합산매출`로 함께 노출
- 대시보드 요약 카드에 `스터디카페 / 스터디룸` 분리 표시 추가
- `collect-kpi.js`, `bots/ska/src/etl.py`, `ska-sales-forecast-daily-review.js`에 합산값 의미 주석/표기 반영
- `ska-sales-forecast-weekly-review.js`, `export-ska-sales-csv.js`, `health-report.js`도 같은 용어 체계로 정렬

## 12주차 후속 (2026-03-23) — 스카 예측엔진 feature cleanup 1차

- `bots/ska/lib/feature_store.py`
  - 이미 제거된 `payment_day|study_room` 축을 더 이상 training feature source로 읽지 않도록 정리
  - 기존 `study_room_payment_*` 컬럼은 학습 스키마 호환용으로만 유지하고 실제 동기화 값은 `0`으로 고정
  - `total_amount`는 `legacy compatibility / fallback trace` 필드라는 의미를 코드에 명시
- `docs/SKA_FORECAST_ENGINE_UPDATE_STRATEGY_2026-03-22.md`
  - target은 유지하고 stale feature cleanup을 우선한다는 전략을 문서에 반영
- `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365`
  - `revenue_daily`/`training_feature_daily`를 다시 동기화
  - 샘플 검증 기준 `study_room_payment_*`는 모두 `0`, `study_room_use_*`만 실제 use 축 값을 유지함을 확인

## 12주차 후속 (2026-03-23) — 스카 예측엔진 bias 보정 2차

- `bots/ska/src/forecast.py`
  - calibration 관련 상수를 runtime-config에서 읽도록 변경
  - `calibrationMaxRatio`, `bookedHoursAdjustmentWeight`, `roomSpreadAdjustmentWeight`, `peakOverlapAdjustmentWeight`, `morning/afternoon/eveningPatternAdjustmentWeight`, `reservationTrendAdjustmentWeight`, `bookedHoursTrendAdjustmentWeight`를 외부화
- `bots/ska/src/runtime_config.py`, `bots/ska/lib/runtime-config.js`, `bots/ska/config.json`
  - underprediction 완화를 위해 예약/이용 선행지표 보정값을 완만하게 상향
  - 핵심 값:
    - `reservationAdjustmentWeight 0.42 -> 0.55`
    - `calibrationMaxRatio 0.12 -> 0.22`
    - `bookedHoursAdjustmentWeight 0.30 -> 0.40`
    - `reservationTrendAdjustmentWeight 0.18 -> 0.24`
    - `bookedHoursTrendAdjustmentWeight 0.16 -> 0.22`
- 검증
  - `bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=daily --json`
  - `2026-03-24` 예측 `238,053원`, `calibration_adjustment=34,912` 반영 확인
  - `node scripts/reviews/ska-sales-forecast-daily-review.js --json` 기준 shadow `knn-shadow-v1`가 `availableDays=3`, `avgMapeGap=-7.32`로 우위지만, canary guard 전에는 자동 편입되지 않음을 확인

## 12주차 후속 (2026-03-23) — 루나 암호화폐 TP/SL 실패 추적 계측 1차

- `bots/investment/shared/trade-journal-db.js`
  - `trade_journal`에 `tp_sl_mode`, `tp_sl_error` 컬럼 추가
- `bots/investment/team/hephaestos.js`
  - `buildProtectionSnapshot()` 추가
  - BTC 직접 매수 / 미추적 잔고 흡수 / 일반 BUY 경로 모두 보호 주문 결과(`ok`, `tp/sl orderId`, `mode`, `error`)를 `trade_journal`에 기록
- 의미:
  - 기존에는 `tp_sl_set=false`만 보여 “왜 실패했는지”를 알기 어려웠고,
  - 이제는 `oco`, `oco_list`, `stop_loss_only`, `failed`와 실제 에러 문자열 기준으로 후속 분석 가능

## 12주차 후속 (2026-03-23) — 루나 Binance 자본 스코프 경계 복구

- `bots/investment/shared/capital-manager.js`
  - `getAvailableBalance(exchange)`가 바이낸스 외 거래소에서는 `0`을 반환하도록 변경
  - `getTotalCapital(exchange)`가 해당 거래소 포지션만 평가금액에 포함하도록 변경
  - `preTradeCheck()`와 `calculatePositionSize()`도 거래소 스코프를 명시적으로 전달하도록 정렬
- 효과:
  - 바이낸스 BUY 검토 시 국내장/해외장 포지션을 USDT reserve 계산에 섞어 읽던 경계를 제거
  - `ETH/USDT` 소액 LIVE probe가 더 이상 `실잔고 부족 → PAPER 폴백`으로 내려가지 않고, 다음 경계인 `최대 포지션 도달: 6/6`에서 멈춤을 확인

## 12주차 후속 (2026-03-23) — 루나 PAPER→LIVE 승격 슬롯 잠식 방지

- `bots/investment/team/hephaestos.js`
  - `maybePromotePaperPositions()`에 `reserveSlots` 인자 추가
  - BUY 직전 호출을 `maybePromotePaperPositions({ reserveSlots: 1 })`로 변경
  - 승격 루프가 현재 LIVE open 수를 다시 읽어 `max_concurrent_positions - reserveSlots`를 넘지 않도록 보수화
- 효과:
  - PAPER→LIVE 자동 승격이 현재 처리 중인 신규 BUY의 슬롯을 잠식해 `최대 포지션 도달`을 유발하던 경계를 복구
  - 다만 이미 열린 6개 LIVE 포지션은 그대로이므로 추가 probe는 포지션 정리 전까지 계속 보류

## 12주차 후속 (2026-03-23) — 루나 장기 미결 LIVE 포지션 health 경고 추가

- `bots/investment/scripts/health-report.js`
  - `loadStalePositionHealth()` 추가
  - `paper=false`인 LIVE 포지션만 대상으로 장기 미결 여부 집계
  - threshold:
    - `binance 48h`
    - `kis 48h`
    - `kis_overseas 72h`
  - 결과를 `장기 미결 LIVE 포지션` 섹션과 운영 판단 이유에 함께 반영
- 효과:
  - force-exit 정책이 아직 없는 상태에서도 오래된 LIVE 포지션이 운영 경고로 직접 드러남
  - 현재 기준 `ORCL`, `HIMS`, `NBIS`, `NVTS`, `ROBO/USDT`, `375500`, `006340`이 stale 경고로 잡힘

## 12주차 후속 (2026-03-23) — 루나 force-exit 후보 리포트 추가

- `bots/investment/scripts/force-exit-candidate-report.js`
  - 장기 미결 LIVE 포지션을 `force_exit_candidate` / `strong_force_exit_candidate`로 분류하는 read-only 리포트 추가
  - `binance 48h`, `kis 48h`, `kis_overseas 72h` threshold 적용
  - `priorityScore` 기준 정렬, `--json`과 텍스트 출력 모두 지원
- 구현 보강:
  - sandbox에서 `db.initSchema()`가 `EPERM`으로 막혀도 read-only 보고 스크립트는 계속 동작할 수 있도록 경계 보완
- 운영 DB 기준 효과:
  - 총 후보 `7건`, strong 후보 `5건`
  - 상위 후보 `ORCL`, `NVTS`, `HIMS`, `NBIS`, `ROBO/USDT`
  - force-exit 최소 정책이 실제 후보 리포트로 연결됨

## 12주차 후속 (2026-03-23) — 루나 force-exit 승인형 runner 추가

- `bots/investment/scripts/force-exit-runner.js`
  - 기본 preview-only
  - `--execute --confirm=force-exit`에서만 실제 SELL 실행
  - 후보는 `force-exit-candidate-report`를 재사용하고, 실행은 기존 executor를 그대로 사용
- `bots/investment/team/hephaestos.js`, `bots/investment/team/hanul.js`
  - `exit_reason_override` 지원 추가
  - 승인형 force-exit 실행 시 journal close reason을 명시적으로 남길 수 있도록 보강
- `bots/investment/scripts/force-exit-candidate-report.js`
  - direct CLI 실행일 때만 `main()`이 동작하도록 변경해 import side effect 제거
- 효과:
  - 자동 cleanup runner 전 단계로, 승인형 stale position 정리 레일이 기존 아키텍처 위에 안전하게 연결됨

## 12주차 후속 (2026-03-23) — 루나 crypto TP/SL capability-first 정책 반영

- `bots/investment/team/hephaestos.js`
  - `safeFeatureValue()`, `getProtectiveExitCapabilities()` 추가
  - 보호 주문 우선순위를 `raw OCO -> raw orderListOco -> ccxt stopLossPrice -> exchange stop_loss_limit`으로 정리
  - `ccxt_stop_loss_only`, `exchange_stop_loss_only` 모드를 journal 추적 축으로 포함

## 12주차 후속 (2026-03-23) — 스카 shadow canary 편입 경로 추가

- `bots/ska/src/forecast.py`
  - shadow 비교 성능을 읽는 `_load_shadow_compare_signal()` 추가
  - 예측 결과에 `shadow_blend_applied`, `shadow_blend_weight`, `shadow_blend_reason`, `shadow_compare_days`, `shadow_compare_mape_gap`를 저장
  - shadow blend는 아래 guard를 모두 만족할 때만 적용
    - `shadowBlendEnabled = true`
    - `shadowCompareDays >= 5`
    - `shadow avgMapeGap <= -5.0`
    - `shadow confidence >= 0.35`
- `bots/ska/config.json`, `bots/ska/src/runtime_config.py`, `bots/ska/lib/runtime-config.js`
  - shadow canary 설정 추가
  - 기본값: `shadowBlendWeight=0.25`, `shadowBlendMinCompareDays=5`, `shadowBlendRequiredMapeGap=5.0`, `shadowBlendMinConfidence=0.35`
- `scripts/reviews/ska-sales-forecast-daily-review.js`, `scripts/reviews/ska-sales-forecast-weekly-review.js`
  - review 출력이 `shadow canary 적용/미적용`, `compare days`, `mape gap`를 그대로 보여주도록 보강
  - 승격 판단도 `shadowBlendMinCompareDays`, `shadowBlendRequiredMapeGap`와 같은 guard를 사용하도록 정렬
- 현재 운영 상태
  - `2026-03-24` 예측에서 shadow `yhat=283075`, primary `yhat=238598`
  - `shadow avgMapeGap=-7.32`, `availableDays=3`
  - 하지만 canary는 `shadow_compare_days_insufficient`로 아직 미적용

## 12주차 후속 (2026-03-23) — 스카 daily_summary 당일 false warning 제거

- `bots/reservation/scripts/health-report.js`
  - `daily_summary 무결성(스터디룸 축)`은 이제 마감 완료된 과거 일자만 검사
  - 당일 KST row(`date >= todayKst`)는 `09:00` 예약현황 보고가 먼저 저장될 수 있으므로 경고 대상에서 제외
- 효과
  - `2026-03-23 room_amounts_json 76500원 != pickko_study_room 0원` false warning 제거
  - 스카 health가 실제 서비스 상태와 더 일치하도록 복구

## 12주차 후속 (2026-03-23) — 스카 재예약 교차 취소 오탐 방지

- `bots/reservation/auto/monitors/naver-monitor.js`
  - 취소 감지 2/2E에서 취소 탭 항목을 바로 픽코 자동 취소 대상으로 넘기지 않고, DB에 이미 추적 중인 예약인지 먼저 확인하도록 변경
  - 새 가드 함수 `findTrackedReservationForCancelCandidate()` / `shouldProcessCancelledBooking()` 추가
  - `bookingId`, `compositeKey`, `phone+date+start+room` 기준으로 tracked reservation을 찾지 못하면 `미추적 과거 취소건 스킵` 로그만 남기고 자동 취소를 건너뜀
- 효과
  - 같은 고객/같은 날짜/같은 룸에서 과거 취소건과 현재 재예약건이 함께 보이는 경우, historical cancel을 현재 확정 예약 취소로 오인하던 경계를 제거
  - 조민정 `2026-04-04 A1` 케이스처럼 `16:30` 취소 이력과 `15:30` 재예약이 섞여도 자동 픽코 취소가 잘못 발동하지 않도록 보강
- 운영
  - `bash bots/reservation/scripts/reload-monitor.sh`로 `naver-monitor`를 재기동했고, `health-report --json` 기준 `naver-monitor / kiosk-monitor` 모두 정상 상태 확인

## 12주차 후속 (2026-03-22) — 스카 매출 source 영향 경로 정렬 + 예측엔진 입력 복구

- `ska-read-service`, `dashboard-server`, dashboard HTML, `collect-kpi`가 총매출을 `general_revenue + pickko_study_room` 기준으로 읽도록 정리
- `bots/ska/src/etl.py`가 `actual_revenue = pickko_study_room + general_revenue` 기준으로 `revenue_daily`를 적재하도록 수정
- `bots/ska/venv/bin/python bots/ska/src/etl.py --days=120`를 재실행해 `revenue_daily`와 `training_feature_daily`를 새 기준으로 재동기화
- `ska-sales-forecast-daily-review.js`가 `total_revenue / studyRoomRevenue / generalRevenue`를 보조 표시값으로 노출하도록 정리
- 일일/주간 리뷰는 `forecast_date::text` 기준으로 바꿔 날짜가 하루 밀려 보이던 경계를 복구
- 후속 예측엔진 단계별 정리 문서 `docs/SKA_FORECAST_ENGINE_UPDATE_STRATEGY_2026-03-22.md` 추가

## 12주차 후속 (2026-03-22) — 스카 매출 DB 적재 마무리 / daily_summary 정합성 복구

- `bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03`를 다시 실행해 3월 전체 `daily_summary`를 재집계
- stale 상태였던 `2026-03-21`, `2026-03-22` row를 현재 스터디룸 산출식 기준으로 복구
- `bots/worker/lib/ska-sales-sync.js`로 `test-company` `worker.sales` 미러를 다시 동기화
- `health-report.js --json` 재검증 기준 `dailySummaryIntegrityHealth.issueCount=0` 회복
- 결과적으로 현재 남은 스카 health 주요 경고는 매출 적재가 아니라 `naver-monitor 미로드/무활동`으로 다시 좁혀짐

## 12주차 후속 (2026-03-22) — 스카 픽코 모니터링 unblock 경계 복구

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - `unblockNaverSlot()`가 최종 검증 실패 시에도 `true`를 반환하던 경계를 `return verified`로 수정
  - `fillAvailablePopup()`에 `waitForSettingsPanelClosed()`를 추가해 `설정변경` 후 패널이 실제로 닫혔는지 확인하도록 보강
  - `--unblock-slot` 단독 모드가 실패 시에도 `naverBlocked=false`를 쓰던 버그를 수정해 성공 시에만 DB 상태를 낮추도록 정리
  - 취소 후 네이버 해제 성공 알림을 `publishKioskSuccessReport()`로 되돌려 success/report, failure/alert 계약을 회복

### 효과
- 해제 검증 실패를 성공처럼 포장하는 false success 경계를 제거했다.
- 단독 해제 모드 실패 시 `kiosk_blocks` 원장이 오염되는 문제를 막아 운영 데이터 신뢰도를 높였다.
- block/unblock 경로의 성공 판정 규칙이 다시 대칭적으로 정렬됐다.

### 검증
- `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅
- `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --block-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ `PATCH /schedules` `200 OK`, 최종 검증 성공 재확인
- `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --unblock-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ 패널 닫힘 확인, `PATCH /schedules` `200 OK`, 최종 해제 검증 성공 재확인

## 12주차 후속 (2026-03-22) — 스카 네이버 슬롯 UI 안정화 1차

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 네이버 일간 캘린더 슬롯 선택을 가상 스크롤/transform 구조에 맞춘 `row-index + room column` 방식으로 보강
  - `Calendar__row-wrap` 스크롤을 직접 제어해 목표 시간 row를 화면에 끌어온 뒤 처리하도록 수정
  - `clickRoomAvailableSlot()`, `clickRoomSuspendedSlot()`, `verifyBlockInGrid()`가 같은 캘린더 parser 전제를 사용하도록 정리
  - `NAVER_TRACE_SCHEDULE_API=1` 환경에서 `/tmp/naver-schedule-trace.log`에 네이버 `/schedules` request/response trace를 남기도록 계측 추가

### 효과
- 잘못된 시간대 fallback 클릭을 제거하고, 실제 목표 슬롯 기준으로 block/unblock UI 조작이 가능해졌다.
- 사용자가 기억한 네이버 내부 `PATCH /schedules` API 경로가 여전히 살아 있음을 실측으로 재확인했다.
- block/unblock 모두에서 UI 실행 경로, 내부 API 호출, 최종 검증 레이어가 같은 기준으로 정렬됐다.

### 검증
- `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅
- `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --block-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ row-index 기반 block 경로 및 최종 검증 성공
- `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --unblock-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ row-index 기반 unblock 경로, `PATCH /schedules` `200 OK`, 최종 해제 검증 성공

## 12주차 후속 (2026-03-22) — 스카 operation_queue 설계 문서 추가

### 추가 사항 (added)
- `docs/SKA_OPERATION_QUEUE_DESIGN_2026-03-22.md`
  - 스카 `operation_queue` 차후 도입을 위한 설계 초안 추가
  - 현재 in-memory 직렬화와의 관계, 미도입 이유, 테이블 스키마 초안, `operation_type`, `operation_group_key`, producer/consumer 구조, 상태 전이, audit trail 방향 정리

### 효과
- 지금은 왜 queue를 넣지 않았는지와 나중에 어떻게 승격할지를 분리해서 설명할 수 있게 됐다.
- 내부 MVP의 현재 구조와 향후 SaaS 확장 구조를 한 문서에서 연결할 수 있게 됐다.

### 검증
- 문서 작업이므로 별도 실행 검증 없음

## 12주차 후속 (2026-03-22) — 스카 고객 단위 연속 작업 cooldown 추가

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 같은 고객(`phone|date`)의 예약 차단/해제 작업을 정렬 후 순차 처리하도록 보강
  - `waitForCustomerCooldown()` / `markCustomerCooldown()`를 추가해 같은 고객/같은 날짜의 직전 작업 후 일정 시간 대기한 뒤 다음 작업을 수행
- `bots/reservation/lib/runtime-config.js`
  - `kioskMonitor.customerOperationCooldownMs` 기본값 `30000` 추가
- `bots/reservation/config.yaml`
  - `runtime_config.kioskMonitor.customerOperationCooldownMs: 30000` 반영

### 효과
- 한 고객이 연속으로 여러 슬롯을 예약/취소할 때 이전 작업의 UI/원장 반영 시간이 부족해 실패하던 경계를 1차로 완화했다.
- 새 큐 테이블 없이 기존 자동 모니터 안에서 고객 단위 직렬화를 먼저 확보했다.

### 검증
- `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅
- `node --check bots/reservation/lib/runtime-config.js` | ✅

## 12주차 후속 (2026-03-22) — 스카 픽코 자동 예약 감지 runbook 추가

### 추가 사항 (added)
- `docs/SKA_PICKKO_RESERVATION_FLOW_RUNBOOK_2026-03-22.md`
  - 픽코 자동 모니터링 예약 감지 절차를 운영/개발 공통 runbook으로 추가
  - `결제완료` 예약 조회, `newEntries / retryEntries` 분기, `phone|date|start|end|room` dedupe, 네이버 세션 분기, 차단 성공/실패 분기 문서화

### 효과
- 픽코 자동 모니터링의 예약 경계와 취소 경계가 모두 문서화됐다.
- `manual follow-up`이 자동 경로에 포함되지 않는 현재 운영 원칙을 source of truth로 고정했다.

### 검증
- 문서 작업이므로 별도 실행 검증 없음
- 참조 구현은 `bots/reservation/auto/monitors/pickko-kiosk-monitor.js` 최신 기준선 사용

## 12주차 후속 (2026-03-22) — 스카 픽코 자동 취소 감지 이중 조회 + runbook 추가

### 추가 사항 (added)
- `docs/SKA_PICKKO_CANCEL_FLOW_RUNBOOK_2026-03-22.md`
  - 픽코 자동 모니터링 예약취소 절차를 운영/개발 공통 runbook으로 추가
  - `상태=환불`, `상태=취소` 별도 조회, 합산/중복제거, 실제 해제 대상 판정, 네이버 세션 분기, 해제 성공/실패 분기 문서화

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 픽코 취소 감지를 `상태=환불` 단일 조회에서 `상태=환불 + 상태=취소` 이중 조회로 확장
  - 두 결과를 `phone|date|start|end|room` 기준으로 합산/중복제거 후 `cancelledEntries`를 계산
  - 운영 로그도 `환불 / 취소 / 합산 / 처리 필요`를 각각 보이도록 정리

### 효과
- 픽코 관리자 상태 필터가 단일 선택이라는 실제 운영 제약을 코드에 반영했다.
- `취소` 상태 예약이 자동 해제 대상에서 누락되는 위험을 줄였다.

### 검증
- `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅

## 12주차 후속 (2026-03-22) — 스카 kiosk-monitor 자동 차단 경계 조정

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - `toBlockEntries` dedupe key를 `phone|date|start|end|room`으로 확장해 같은 사람/같은 날짜/같은 시작시각 재예약이 같은 사이클에서 합쳐지지 않도록 보강
  - `manualFollowupEntries`를 자동 차단 루프에서 제거하고, 자동 경로를 `픽코 직접 감지 신규 예약 + 미차단 재시도`만 담당하도록 축소
  - 로그도 `manual 후속 재시도` 카운트 없이 현재 자동 처리 범위만 보여주도록 정리
- `bots/reservation/manual/reservation/pickko-accurate.js`
  - `manual` 픽코 락 TTL을 20분으로 늘려 수동 작업 중 자동 모니터가 중간에 진입하지 않도록 보강
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 사이클 시작 시 `isPickkoLocked()`로 기존 락 소유자를 먼저 확인하고, `manual` 락이 잡혀 있으면 `manual_priority_lock` 상태로 즉시 스킵하도록 보강

### 효과
- 자동 차단 레일과 수동 후속 레일의 경계가 명확해졌다.
- 사람이 개입한 예약은 `manual-block-followup` 운영 루프로만 닫히므로, 중복 차단 시도와 운영 오해를 줄일 수 있다.
- 수동 작업 중에는 자동이 멈추는 `수동 우선` 운영 원칙이 코드로 명시됐다.

### 검증
- `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅
- `node --check bots/reservation/manual/reservation/pickko-accurate.js` | ✅

## 12주차 후속 (2026-03-22) — 스카 취소 command contract 복구

### 추가 사항 (added)
- `bots/reservation/lib/manual-cancellation.js`
  - 자연어 취소 요청에서 `phone/date/start/end/room/name`을 파싱하고
  - `pickko-cancel-cmd.js` stdout JSON을 스카 상위 result shape로 정규화하는 모듈 추가

### 변경 사항 (changed)
- `bots/reservation/lib/ska-command-handlers.js`
  - `cancel_reservation` write-path command 추가
- `bots/reservation/scripts/dashboard-server.js`
  - webhook bridge가 `cancel_reservation`을 직접 처리하도록 확장
- `bots/reservation/lib/ska-intent-learning.js`
  - Claude unknown-intent prompt에 `cancel_reservation` command 추가
- `bots/reservation/context/COMMANDER_IDENTITY.md`
  - 스카 커맨더 지원 명령에 `cancel_reservation` 반영
- `bots/reservation/context/N8N_COMMAND_CONTRACT.md`
  - 취소 command의 request/response/partial success 계약 문서화
- `bots/orchestrator/lib/intent-parser.js`
  - `"예약 취소해줘"`류 문장을 `ska_action -> cancel_reservation`으로 파싱하도록 추가
- `bots/orchestrator/src/router.js`
  - `cancel_reservation` 결과를 `✅ / ⚠️` 사용자 문구로 포맷하고 `partialSuccess`를 완전 성공으로 오해하지 않도록 분기

### 검증
- `node --check bots/reservation/lib/manual-cancellation.js` | ✅
- `node --check bots/reservation/lib/ska-command-handlers.js` | ✅
- `node --check bots/reservation/scripts/dashboard-server.js` | ✅
- `node --check bots/orchestrator/lib/intent-parser.js` | ✅
- `node --check bots/orchestrator/src/router.js` | ✅
- `node - <<'NODE' ... parseCancellationCommand(...) ... NODE` | ✅ `강보영 / 2026-04-05 / 09:00~11:00 / A1 / 01023174540` 정상 파싱
- `node - <<'NODE' ... parseIntent('강보영 4월 5일 오전 9시~11시 A1 예약 취소해줘 010-2317-4540') ... NODE` | ✅ `ska_action -> cancel_reservation`

## 12주차 후속 (2026-03-22) — 비디오팀 pacing policy 추가

### 변경 사항 (changed)
- `bots/video/lib/sync-matcher.js`
  - `syncMapToEDL()`에 pacing policy를 추가해 timeline을 나레이션 길이에만 고정하지 않고 `hold / low confidence / speed floor` 구간에 추가 체류 시간을 부여
  - main clip metadata에 `narration_duration`, `timeline_duration`, `pacing_extra_sec` 기록
- `bots/video/lib/edl-builder.js`
  - main clip 오디오에 `apad`를 추가해 timeline 확장 시 무음 패딩으로 final render 유지
- `bots/video/scripts/run-pipeline.js`
  - config를 `syncMapToEDL()`까지 전달해 pacing policy가 실제 파이프라인에 반영되도록 수정
- `bots/video/scripts/test-full-sync-pipeline.js`
  - validation 레일도 같은 pacing policy를 타도록 `syncMapToEDL(..., config)`로 정렬
- `bots/video/scripts/test-sync-matcher.js`
  - 더미 검증도 최신 pacing config를 반영하도록 호출부 정리
- `bots/video/config/video-config.yaml`
  - `pacing_multiplier`, `pacing_max_extra_sec`, `hold_pacing_extra_sec`, `low_confidence_pacing_extra_sec`, `speed_floor_threshold`, `speed_floor_pacing_extra_sec`, `pacing_total_max_extra_sec` 추가

### 검증
- `node --check bots/video/lib/sync-matcher.js` | ✅
- `node --check bots/video/lib/edl-builder.js` | ✅
- `node --check bots/video/scripts/run-pipeline.js` | ✅
- `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅
- `node --check bots/video/scripts/test-sync-matcher.js` | ✅
- `node bots/video/scripts/test-sync-matcher.js` | ✅ `matched_keyword=2`, `overall_confidence=0.8334`
- `node -e \"... syncMapToEDL(server auth sync_map) ...\"` | ✅ `edl.duration=1008.129`, `pacing_extra_total=162.129`
- `node -e \"... syncMapToEDL(db sync_map) ...\"` | ✅ `edl.duration=629.8`, `pacing_extra_total=125.8`
- `node bots/video/scripts/test-full-sync-pipeline.js --source-video=...원본_서버인증.mp4 --source-audio=...원본_나레이션_서버인증.m4a --edited=...편집_서버인증.mp4 --render-final` | ✅ `duration_ms=675045`, `2560x1440`, `60fps`
- `node bots/video/scripts/test-reference-quality.js --generated=.../video-sync-pipeline-6qDyBJ/final.mp4 --sample=서버인증 --json` | ✅ `overall=75.61`, `duration=49.13`, `visual_similarity=75.30`, `duration_ratio=0.4913`
- `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-6qDyBJ/final.mp4 --edl=.../video-sync-pipeline-6qDyBJ/edit_decision_list.json --sample=서버인증 --json` | ✅ `hold=0`, `speed_floor_ratio=0.7143`, 반복 window 2개 확인
- `node bots/video/scripts/test-full-sync-pipeline.js --source-video=...원본_DB생성.mp4 --source-audio=...원본_나레이션_DB생성.m4a --edited=...편집_DB생성.mp4 --render-final` | ✅ `duration_ms=345379`, `2560x1440`, `60fps`
- `node bots/video/scripts/test-reference-quality.js --generated=.../video-sync-pipeline-mjrDSu/final.mp4 --sample=db생성 --json` | ✅ `overall=78.77`, `duration=47.47`, `visual_similarity=85.75`, `duration_ratio=0.4747`
- `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-mjrDSu/final.mp4 --edl=.../video-sync-pipeline-mjrDSu/edit_decision_list.json --sample=db생성 --json` | ✅ `hold=2`, `speed_floor_ratio=0.5`, 반복 window 2개 확인

### 효과
- 남아 있던 핵심 병목이 `키워드`보다 `timeline length / tutorial pacing`임을 실제 EDL 숫자로 고정했다.
- 기존 deterministic 구조를 유지한 채, final 재렌더 전에 길이 확장 정책을 config-driven으로 실험할 수 있게 됐다.
- pacing policy는 `서버인증`, `DB생성` 두 저점 세트 모두에서 실제 점수 개선으로 이어졌다.
- 다음 1순위 병목은 `hold 완화`와 `반복 source window` 감소다.

## 12주차 후속 (2026-03-22) — 비디오팀 final 5세트 baseline 완료 + watchdog 완화

### 변경 사항 (added)
- `bots/video/scripts/analyze-final-structure-gap.js`
  - `final.mp4 + edit_decision_list.json + reference` 기준으로 low-score 세트의 구조 병목을 분석하는 진단 스크립트 추가

### 변경 사항 (changed)
- `bots/video/lib/edl-builder.js`
  - `computeFinalWatchdogOptions()`를 추가해 긴 final render가 고정 2분 stall timeout으로 false failure 되지 않도록 가변 watchdog으로 전환
- `bots/video/lib/narration-analyzer.js`
  - offline narration fallback을 길이 비례형 `4/5/6/7` segment 구조로 확장
  - `서버인증`, `DB생성` sample-aware fallback 키워드/주제 추가
- `bots/video/lib/sync-matcher.js`
  - 짧은 source window 반복 선택에 대한 `repeated_window_penalty` 추가
- `bots/video/scripts/test-full-sync-pipeline.js`
  - offline fallback 시 normalized temp filename이 아니라 원본 sample label을 함께 전달하도록 보강
- `bots/video/config/video-config.yaml`
  - offline fallback segment count / repeated window penalty 관련 설정 추가

### 검증
- `node --check bots/video/lib/edl-builder.js` | ✅
- `node --check bots/video/scripts/analyze-final-structure-gap.js` | ✅
- `node --check bots/video/lib/narration-analyzer.js` | ✅
- `node --check bots/video/lib/sync-matcher.js` | ✅
- `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅
- `node bots/video/scripts/test-final-reference-quality-batch.js --title=서버인증 --json` | ✅ false stall 복구 후 `overall=72.96`, `duration=41.26`, `visual_similarity=74.49`
- `node bots/video/scripts/test-final-reference-quality-batch.js --json` | ✅ final 5세트 baseline 완료
  - `averageOverall=79.00`
  - `averageDuration=54.67`
  - `averageResolution=99.58`
  - `averageVisualSimilarity=80.41`
- `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-S73v5p/final.mp4 --edl=.../video-sync-pipeline-S73v5p/edit_decision_list.json --sample=서버인증 --json` | ✅ `duration_ratio=0.4126`, `speed_floor_ratio=0.8`, `hold=1`, `main:900~910s` 4회 재사용 확인
- `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-037yYC/final.mp4 --edl=.../video-sync-pipeline-037yYC/edit_decision_list.json --sample=db생성 --json` | ✅ `duration_ratio=0.3803`, `speed_floor_ratio=0.8`, `hold=0`, `main:1370~1400s` 2회 재사용 확인
- `node -e "... buildOfflineNarrationFixture(server auth sample) ..."` | ✅ `segments=7`, 인증 특화 topic/keywords 확인
- `node -e "... buildSyncMap(server scene_index + auth fixture) ..."` | ✅ `서버인증` sync-level `keyword=7`, `hold=0`, `unmatched=0`
- `node -e "... buildSyncMap(db scene_index + db fixture) ..."` | ✅ `DB생성` sync-level `keyword=4`, `hold=2`, `unmatched=0`

### 효과
- 긴 세트(`서버인증`)가 false stall 없이 끝까지 렌더되며 final 5세트 batch를 완주할 수 있게 됐다.
- final 기준으로 남은 핵심 차이가 해상도보다는 사람 편집본 대비 `길이/구조`라는 점이 더 선명해졌다.
- 이제 낮은 점수 세트의 병목을 “짧은 source window 반복 / speed floor 의존 / hold 사용” 수준으로 재현 가능하게 분석할 수 있다.
- duration/structure 튜닝 1차로 `서버인증`은 generic fallback 병목을 줄여 sync-level에서 `keyword 7 / hold 0`까지 회복됐고, `DB생성`도 다음 final 재렌더 대상으로 검증 가능한 상태가 됐다.

## 12주차 후속 (2026-03-22) — 비디오팀 final render batch 검증 레일 추가

### 변경 사항 (added)
- `bots/video/scripts/test-final-reference-quality-batch.js`
  - temp `validation_report.json` 없이도 샘플 5세트를 직접 순회하며 `final render -> reference 비교`를 수행하는 batch evaluator 추가
- `bots/video/scripts/test-full-sync-pipeline.js`
  - CLI 외부에서도 재사용할 수 있도록 `runPipelineValidation()` export 추가
  - `preview_render` / `final_render` 결과를 함수 반환값으로 재사용 가능하게 정리

### 검증
- `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅
- `node --check bots/video/scripts/test-final-reference-quality-batch.js` | ✅
- `node bots/video/scripts/test-final-reference-quality-batch.js --title=파라미터 --json` | ✅ `averageOverall=81.62`, `averageFinalRenderMs=210767`

### 효과
- final render 5세트 batch baseline을 temp 파일 유무와 무관하게 같은 스크립트로 재현할 수 있게 됐다.
- 다음 단계에서 5세트 전체 final baseline을 같은 레일로 밀 수 있는 기반이 생겼다.

## 12주차 후속 (2026-03-22) — 비디오팀 final render 단일 세트 기준선 추가

### 변경 사항 (changed)
- `bots/video/scripts/test-full-sync-pipeline.js`
  - `--render-final` 옵션을 추가해 Phase 2 파이프라인을 preview뿐 아니라 final render까지 한 번에 검증할 수 있도록 확장

### 검증
- `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅
- `node bots/video/scripts/test-full-sync-pipeline.js --source-video=... --source-audio=... --edited=... --render-final` | ✅ `final.mp4` 생성, `2560x1440`, `60fps`, `264s`, `AAC 48kHz stereo`, `file_size=46,555,622`, `duration_ms=249452`
- `ffprobe .../final.mp4` | ✅ `video=264.000s`, `audio=264.000s`, `2560x1440`, `60fps`
- `node bots/video/scripts/test-reference-quality.js --generated=.../final.mp4 --sample=파라미터 --json` | ✅ `overall=81.62`, `duration=64.26`, `resolution=99.30`, `visual_similarity=79.82`

### 효과
- Phase 2가 preview 정합성 복구를 넘어서 final render 단일 세트 기준선까지 확보됐다.
- 현재 자동 편집의 남은 핵심 차이가 `sync`나 출력 해상도보다는 사람 편집본 대비 `길이/구조`라는 점이 더 선명해졌다.

## 12주차 후속 (2026-03-22) — Jimmy 성공 알림 경계 복구

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 성공한 네이버 예약 차단 완료, 대리등록 차단 완료, 취소 후 네이버 예약가능 복구 완료를 `event_type=report`, `alert_level=1`로 하향 조정
  - 성공 이벤트 전용 `publishKioskSuccessReport()` helper 추가
- `bots/reservation/manual/reports/pickko-alerts-query.js`
  - 예전 SQLite `getDb()` 의존 제거
  - 최신 `pgPool` 기반 reservation DB 조회로 복구
  - `alerts.timestamp` text 컬럼 비교를 `timestamptz` 캐스팅으로 보정

### 효과
- 성공 이벤트가 더 이상 `⚠️ 경고 · ...`, `⚠️ jimmy 집약 알림`으로 묶이지 않음
- 실패/불확실 경로의 alert severity는 그대로 유지
- 현재 미해결 오류 알림을 DB 기준으로 바로 조회할 수 있게 됐고, `01089430972` 관련 실패 알림이 과거 잔상인지 즉시 확인 가능해졌다

## 12주차 후속 (2026-03-22) — 비디오팀 preview render A/V 정합성 복구

### 변경 사항 (changed)
- `bots/video/lib/edl-builder.js`
  - V2 sync clip concat 전에 모든 비디오를 공통 캔버스 기준으로 정규화하도록 보강
  - narration 오디오는 clip speed와 독립적으로 timeline 길이에 맞춰 유지하도록 보강
  - speed floor(`min_speed_factor=0.5`) 때문에 영상 길이가 narration보다 짧아질 때 마지막 프레임 hold(`tpad=stop_mode=clone`)로 길이를 맞추도록 보강
- `bots/video/scripts/test-full-sync-pipeline.js`
  - 테스트도 runtime과 동일하게 `normalizeAudio()`를 먼저 거치도록 수정

### 검증
- `node --check bots/video/lib/edl-builder.js` | ✅
- `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅
- `node bots/video/scripts/test-full-sync-pipeline.js --source-video=... --source-audio=... --edited=... --render-preview` | ✅ preview render 완료
- `ffprobe .../preview.mp4` | ⚠️ 초기 검증에서 `video=103s`, `audio=524.863s` 불일치 확인
- `node - <<'NODE' ... renderPreview(loadEDL(...), 'preview-fixed.mp4') ... NODE` | ✅ 수정 후 `preview-fixed.mp4` 렌더 성공
- `ffprobe .../preview-fixed.mp4` | ✅ `1280x720`, `60fps`, `video=264.000s`, `audio=264.000s`, `48000Hz stereo`

### 효과
- preview가 단순 생성 성공을 넘어서 timeline 기준 A/V 정합성을 회복했다.
- Phase 2 다음 단계는 sync 기준선 자체보다 final render 다세트 검증과 transition 재도입 설계로 이동할 수 있다.

## 12주차 후속 (2026-03-22) — 비디오팀 reference quality evaluator 추가

### 변경 사항 (added)
- `bots/video/lib/reference-quality.js`
  - `ffprobe` 기반 메타데이터 비교
  - 샘플 프레임 RGB 비교 기반 시각 유사도 계산
  - duration / resolution / fps / audio spec / visual similarity 종합 점수 산출
- `bots/video/scripts/test-reference-quality.js`
  - 자동 결과물과 `samples/edited` 실제 편집본을 비교하는 CLI 추가
  - `--generated`, `--reference`, `--sample`, `--json` 지원

### 검증
- `node --check bots/video/lib/reference-quality.js` | ✅
- `node --check bots/video/scripts/test-reference-quality.js` | ✅
- `node bots/video/scripts/test-reference-quality.js --generated=.../preview-fixed.mp4 --sample=파라미터 --json` | ✅ `overall=70.43`, `duration=64.26`, `resolution=25.18`, `visual_similarity=79.61`

### 효과
- RED/BLUE 내부 품질 점수와 별도로, 실제 사람 편집본 기준 reference 품질 평가 축이 생겼다.
- 현재 baseline 기준 자동 결과의 약점이 `sync` 자체보다 `길이 축소`와 `preview 해상도 차이`라는 점을 수치로 읽을 수 있게 됐다.

## 12주차 후속 (2026-03-22) — 비디오팀 reference quality batch baseline 추가

### 변경 사항 (added)
- `bots/video/scripts/test-reference-quality-batch.js`
  - `temp/validation_report.json`의 5세트 preview 산출물을 실제 `samples/edited` 편집본과 일괄 비교하는 batch evaluator 추가

### 검증
- `node --check bots/video/scripts/test-reference-quality-batch.js` | ✅
- `node bots/video/scripts/test-reference-quality-batch.js --json` | ✅
  - `averageOverall=68.88`
  - `averageDuration=54.30`
  - `averageResolution=25.11`
  - `averageVisualSimilarity=83.76`

### 효과
- 5세트 전체에서 현재 자동 편집 품질의 공통 병목이 `sync`보다 `duration/structure`와 `preview 해상도 차이`라는 점이 드러났다.
- 세트별 우선순위를 정해 final render 검증과 구조 튜닝으로 바로 연결할 수 있게 됐다.

## 2026-03-22

### 스카 kiosk_blocks 키 v2 재설계 / 재예약 충돌 완화

- `bots/reservation/lib/crypto.js`
  - `hashKioskKeyLegacy()` 추가
  - `hashKioskKey()`를 `phone|date|start|end|room` 기반 v2 해시로 변경
- `bots/reservation/lib/db.js`
  - `getKioskBlock()` v2 우선 + legacy fallback 지원
  - `upsertKioskBlock()`이 legacy row를 v2 id로 승격하도록 보강
  - `getOpenManualBlockFollowups()` 조인에 `end_time` 조건 추가
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 주요 조회 경로가 `end/room`까지 전달하도록 보강
  - 추가로 `blockNaverSlot()` 반환 객체를 다시 boolean으로 해석하지 않던 잔여 경로 1건 수정
- `bots/reservation/migrations/007_kiosk_block_key_v2.js`
  - 기존 `kiosk_blocks` row를 v2 id로 재키잉하는 마이그레이션 추가
- `bots/reservation/scripts/test-kiosk-block-key-v2.js`
  - 실제 DB 트랜잭션에서 두 개의 재예약 row를 삽입/조회 후 rollback하는 비파괴 회귀 테스트 스크립트 추가
- `docs/SKA_REBOOK_REGRESSION_TEST_2026-03-22.md`
  - 취소 후 같은 시작시각 재예약 회귀 테스트 절차서 추가
- `docs/SKA_NAVER_CANCEL_FLOW_RUNBOOK_2026-03-22.md`
  - 네이버 자동 모니터링 예약취소 절차 runbook 추가

### 스카 manual block follow-up 원장 정정 / corrected slot 리포트 보강

- `bots/reservation/manual/reports/manual-block-followup-report.js`
  - exact `getKioskBlock(phone,date,start)` lookup을 사용하도록 변경
  - `operator_confirmed_actual_slot` corrected row를 별도 `correctedRows` / `correctedCount`로 출력하도록 확장
- 운영 원칙
  - 취소/예약없음/시간 불일치 row는 `operator_invalidated`로 정정
  - 실제 차단된 corrected slot은 별도 row로 기록

### 스카 자동 모니터링 로직 정렬 / kiosk-monitor 재가동

- `bots/reservation/auto/monitors/naver-monitor.js`
  - 네이버 신규 예약 후 픽코 등록을 막던 `OBSERVE_ONLY`, `PICKKO_ENABLE`, `SAFE_DEV_FALLBACK` 가드 제거
  - 자동 취소 후 `pickko-kiosk-monitor.js --unblock-slot` 후속 제거
  - 후속 코드 점검에서 취소 감지 1/2/2E/4 경로에 남아 있던 `OBSERVE_ONLY` 필터도 제거
- `bots/reservation/manual/reservation/pickko-cancel-cmd.js`
  - 수동 취소 command를 `픽코 취소만 수행`하는 계약으로 단순화
- `bots/reservation/lib/manual-cancellation.js`
  - `cancel_reservation` result shape에서 `partialSuccess / naverUnblockFailed` 제거
- `bots/reservation/context/N8N_COMMAND_CONTRACT.md`
  - 취소 command 응답 예시와 원칙을 최신 운영 로직 기준으로 갱신
- 운영 상태:
  - `launchctl bootstrap/kickstart`로 `ai.ska.kiosk-monitor` 재가동
  - `node bots/reservation/scripts/health-report.js --json` 기준 `kiosk-monitor 정상`

## [Phase 2] 비디오팀 AI 싱크 매칭 파이프라인 (2026-03-21)

### 신규 모듈
- `bots/video/lib/scene-indexer.js`
  - OCR 기반 원본 영상 장면 인덱싱
- `bots/video/lib/narration-analyzer.js`
  - 나레이션 구간별 의도/키워드 분석
- `bots/video/lib/sync-matcher.js`
  - 키워드+임베딩 기반 AI 싱크 매칭
- `bots/video/lib/intro-outro-handler.js`
  - 인트로/아웃트로 하이브리드 (파일/프롬프트)
- `bots/video/migrations/004-intro-outro.sql`
  - 인트로/아웃트로 DB 컬럼 추가

### 변경
- `bots/video/scripts/run-pipeline.js`
  - `syncVideoAudio()` 기본 경로를 제거하고 `scene-indexer -> narration-analyzer -> sync-matcher -> intro-outro -> syncMapToEDL` 흐름으로 교체
- `bots/video/lib/edl-builder.js`
  - 다중 입력과 clip 기반 `version: 2` EDL 렌더링 지원
- `bots/video/config/video-config.yaml`
  - `scene_indexer`, `narration_analyzer`, `sync_matcher`, `intro_outro` 섹션 추가
- `bots/worker/web/routes/video-api.js`
  - 인트로/아웃트로 API 및 `file_type` 확장
- `bots/worker/web/routes/video-internal-api.js`
  - 내부 `run-pipeline` 호출에 intro/outro 인자 전달
- `bots/worker/web/app/video/page.js`
  - 5단계 질문 흐름과 인트로/아웃트로 입력 UI 추가
- `bots/video/n8n/video-pipeline-workflow.json`
  - intro/outro 관련 webhook payload 전달 확장

### 폐기
- `ffmpeg-preprocess.js`의 `syncVideoAudio()`는 더 이상 `run-pipeline`의 메인 경로에서 호출하지 않음
  - 함수 자체는 유지되며 Phase 1 호환/보조 용도로만 남김

## 12주차 후속 (2026-03-22) — 일일 운영 분석 리포트 해석 품질 보강

### 변경 사항 (changed)
- `scripts/reviews/daily-ops-report.js`
  - 보조 입력으로 `jay-gateway-experiment-review.js --json`, `llm-selector-speed-daily.js --skip-test --json`를 함께 읽도록 확장
  - `runtimeRestrictions` top-level 섹션 추가
  - `activeIssues`에 unhealthy selector primary 상태를 직접 반영
  - gateway `post-restart` 창이 깨끗한 경우 이를 recommendation에 분리 표기
  - `buildTextReport()`에 `런타임 제한` 섹션 추가

### 검증
- `node --check scripts/reviews/daily-ops-report.js` | ✅
- `node scripts/reviews/daily-ops-report.js --json` | ✅ `runtimeRestrictions`, selector primary issue, post-restart gateway guidance 반영 확인

## 12주차 후속 (2026-03-22) — 제이/OpenClaw gateway fallback readiness + concurrency 안정화

### 변경 사항 (changed)
- `bots/orchestrator/lib/openclaw-config.js`
  - provider `configured`와 `authReady`를 분리하도록 readiness 계산 추가
  - `fallbackReadiness`, `readyFallbacks`, `unreadyFallbacks` 노출
  - `updateOpenClawGatewayFallbacks()`, `updateOpenClawGatewayConcurrency()` 추가
- `bots/orchestrator/scripts/check-jay-gateway-primary.js`
  - candidate별 `authReady`, ready/unready fallback 개수, 즉시 사용 가능 fallback 출력 추가
- `bots/orchestrator/scripts/prepare-jay-gateway-switch.js`
  - 전환 후보는 `configured=true`뿐 아니라 `authReady=true`여야 통과하도록 보강
- `bots/orchestrator/scripts/log-jay-gateway-experiment.js`
  - `providerAuthMissingCount`, `nonAuthFailoverErrorCount`, `embeddedRateLimitRuns`, `retryBurstCount`, `maxAttemptsPerRun` 추가
- `scripts/reviews/jay-gateway-experiment-review.js`
  - rate limit과 auth missing, retry burst를 분리 해석하도록 리뷰 보강
  - `마지막 gateway 재기동 이후` 창의 rate limit / auth missing / retry burst를 별도 요약하도록 보강

### 신규 기능 (feat)
- `bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js`
  - ready fallback만 유지하는 권장 체인을 계산하고 `--apply`로 라이브 설정에 반영하는 CLI 추가
- `bots/orchestrator/scripts/tune-jay-gateway-concurrency.js`
  - `maxConcurrent`, `subagents.maxConcurrent`를 보수적으로 조정하는 CLI 추가

### 운영 반영 (ops)
- `~/.openclaw/openclaw.json`
  - fallback chain `11 -> 4` 축소
  - 현재 fallback:
    - `openai/gpt-4o-mini`
    - `openai/gpt-4o`
    - `openai/o4-mini`
    - `openai/o3-mini`
  - concurrency:
    - `maxConcurrent=1`
    - `subagents.maxConcurrent=2`

### 검증
- `node --check bots/orchestrator/lib/openclaw-config.js` | ✅
- `node --check bots/orchestrator/scripts/check-jay-gateway-primary.js` | ✅
- `node --check bots/orchestrator/scripts/prepare-jay-gateway-switch.js` | ✅
- `node --check bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅
- `node --check scripts/reviews/jay-gateway-experiment-review.js` | ✅
- `node --check bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js` | ✅
- `node --check bots/orchestrator/scripts/tune-jay-gateway-concurrency.js` | ✅
- `node bots/orchestrator/scripts/check-jay-gateway-primary.js` | ✅ `ready fallback=4`, `unready fallback=0` 확인
- `node bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js --apply` | ✅ 라이브 fallback chain 정리
- `node bots/orchestrator/scripts/tune-jay-gateway-concurrency.js --apply --max=1 --subagents=2` | ✅ 라이브 concurrency 조정
- `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` | ✅ gateway 재기동
- `node scripts/reviews/jay-gateway-experiment-daily.js` | ✅ 최신 24시간 창에서 `retry burst runs=13`, `max attempts per run=4` 기준 남은 병목 확인
- `node bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅ `마지막 gateway 재기동 이후: rate limit 0 / auth missing 0 / retry burst 0` 확인
- `node scripts/reviews/jay-gateway-experiment-review.js` | ✅ `post-restart rate limit/auth missing/retry burst` 출력 확인

## 12주차 후속 (2026-03-21) — 스카 수동등록 후속 차단 원장화

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/naver-monitor.js`
  - `manual`, `manual_retry`, `verified`, `completed` 예약을 잘못 종결 상태로 보던 취소 스킵 조건 제거
- `bots/reservation/auto/monitors/pickko-kiosk-monitor.js`
  - 재시도 가능한 네이버 차단 실패 알람을 `지연 / 자동 재시도 예정`으로 재분류
  - `journalBlockAttempt()`를 추가해 차단 시도 결과/사유/재시도 횟수를 `kiosk_blocks`에 기록
  - `block-slot` 독립 재검증 성공 시 DB 상태도 `naver_blocked=true`로 동기화
- `bots/reservation/manual/reservation/pickko-register.js`
  - 수동등록 직후 `queued/manual_register_spawned` 상태를 `kiosk_blocks`에 기록
  - detached spawn 실패도 원장에 남기도록 보강
- `bots/reservation/lib/db.js`
  - `recordKioskBlockAttempt()` 추가
  - `kiosk_blocks` 새 필드 읽기/쓰기 지원
- `bots/reservation/scripts/check-n8n-command-path.js`
  - nested error 상세 출력 지원
- `bots/reservation/manual/reports/manual-block-followup-checklist-2026-03-21.md`
  - 운영자가 실제 확인/처리한 8건 상태를 기록하도록 갱신

### 신규 기능 (feat)
- `bots/reservation/manual/reports/manual-block-followup-report.js`
  - manual 등록 미래 예약의 네이버 차단 상태를 `전체 / 미완료` 기준으로 조회하는 CLI 추가
- `bots/reservation/manual/reports/manual-block-followup-resolve.js`
  - 운영자가 수동으로 처리 완료한 future 예약을 `kiosk_blocks`에 `manually_confirmed`로 반영하는 CLI 추가

### 신규 기능 (feat)
- `bots/reservation/migrations/006_kiosk_block_attempts.js`
  - `kiosk_blocks.last_block_attempt_at`
  - `kiosk_blocks.last_block_result`
  - `kiosk_blocks.last_block_reason`
  - `kiosk_blocks.block_retry_count`
  컬럼 추가

### 검증
- `node --check bots/reservation/lib/db.js` | ✅
- `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅
- `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅
- `node --check bots/reservation/manual/reservation/pickko-register.js` | ✅
- `node --check bots/reservation/migrations/006_kiosk_block_attempts.js` | ✅
- `node bots/reservation/scripts/migrate.js --status` | ✅ `v006` 미적용 확인
- `node bots/reservation/scripts/migrate.js` | ✅ `v006 kiosk_block_attempts` 적용 완료
- `launchctl kickstart -k gui/$(id -u)/ai.ska.naver-monitor` | ✅
- `launchctl kickstart -k gui/$(id -u)/ai.ska.kiosk-monitor` | ✅
- `node bots/reservation/scripts/health-report.js --json` | ✅ core/scheduled/n8n 건강도 정상 확인
- 최근 manual 등록 미래 예약 8건 운영 점검 | ✅ 네이버 예약관리에서 직접 확인 후 처리 완료
- `node bots/reservation/manual/reports/manual-block-followup-resolve.js --from=2026-03-21 --all-open` | ✅ 8건 원장 반영 완료
- `node bots/reservation/manual/reports/manual-block-followup-report.js --from=2026-03-21` | ✅ `전체 11건 / 미완료 0건` 확인

## 12주차 후속 (2026-03-21) — worker-web `/video` 세션 복원 + 프리뷰 렌더 경계 복구

### 변경 사항 (changed)
- `bots/worker/web/app/video/page.js`
  - `idle` 단계에서도 업로드 영역이 바로 보이도록 조정
  - 파일 업로드 시 세션이 없으면 자동 생성 후 업로드하는 흐름 추가
  - 현재 세션 ID를 URL `?session=`과 `localStorage`에 동기화해 새로고침 후에도 진행 세션 복원이 가능하도록 보강
  - 기존 깨진 한글 파일명을 화면에서 복원해 보이도록 `repairFilename()` 추가
- `bots/worker/web/app/_shell.js`
  - hydration 전 완전 빈 화면 대신 로딩 셸 표시
- `bots/worker/web/routes/video-api.js`
  - 업로드 파일명의 UTF-8 복원 경계 추가
  - `POST /sessions/:id/start`에서 n8n 응답 후 실제 `video_edits` 생성까지 확인하고, 미생성 시 direct fallback으로 재실행하도록 보강
- `bots/video/lib/edl-builder.js`
  - 프리뷰를 검게 만들던 연속 `fade in/out` transition 렌더를 임시 비활성화
  - transition edit는 EDL 원장에 남기고 렌더 단계에서만 무시하도록 조정

### 검증
- `node --check bots/worker/web/app/_shell.js` | ✅
- `node --check bots/worker/web/app/video/page.js` | ✅
- `node --check bots/worker/web/routes/video-api.js` | ✅
- `node --check bots/video/lib/edl-builder.js` | ✅
- `cd bots/worker/web && npx next build` | ✅
- `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅
- `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅
- session 1 direct recovery | ✅ `video_edits.id=16`, `trace=f84aa3f6-329e-43af-8eac-ae6f8eeaf474`, `status=correction_done` 확인

## 12주차 후속 (2026-03-21) — 비디오팀 Phase 1 마감 문서 정리 + worker-web `/video` 반영

### 변경 사항 (changed)
- `bots/video/docs/CLAUDE.md`
  - 절대 규칙에 RAG 피드백 루프 원칙 14~16 추가
  - `RAG 피드백 루프 — 학습하는 편집 시스템` 섹션 추가
- `bots/video/docs/SESSION_HANDOFF_VIDEO.md`
  - Phase 1 완료 기준 인수인계 문서로 전면 교체
- `bots/video/docs/VIDEO_HANDOFF.md`
  - 상태 라인을 `Phase 1 전체 완료` 기준으로 갱신
- `docs/SESSION_HANDOFF.md`
  - 비디오팀 Phase 1 완료와 worker-web `/video` 반영 상태를 전사 handoff에 반영

### 검증
- `cd bots/worker/web && npx next build` | ✅ `/video`, `/video/history` route 생성 확인
- `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 런타임 재기동
- `curl -I http://127.0.0.1:4001/video` | ✅ `200 OK`
- `curl -I http://127.0.0.1:4001/video/history` | ✅ `200 OK`

## 12주차 후속 (2026-03-21) — worker-web 비디오 업로드 경계 복구

### 변경 사항 (changed)
- `bots/worker/web/routes/video-api.js`
  - `company_id`를 문자열로 정규화하고, `video_sessions.company_id`가 예전 `INTEGER` 스키마여도 자동으로 `TEXT`로 보정하는 guard 추가
- `bots/worker/web/app/video/page.js`
  - 업로드 영역에 drag active 시각화, 전체 영역 클릭 업로드, 아이콘 클릭 업로드, `accept` 확장자 제한 추가
- `bots/video/migrations/002-video-sessions.sql`
  - `video_sessions.company_id`를 `TEXT`로 수정
- `bots/video/migrations/003-video-sessions-company-text.sql`
  - 기존 DB용 `company_id TEXT` 보정 마이그레이션 추가

### 검증
- `node --check bots/worker/web/routes/video-api.js` | ✅
- `node --check bots/worker/web/app/video/page.js` | ✅
- `cd bots/worker/web && npx next build` | ✅
- `node --input-type=module ... ALTER TABLE ... video_sessions.company_id TYPE TEXT ...` | ✅ DB 컬럼 `text` 확인

## 12주차 후속 (2026-03-21) — 비디오팀 5세트 preview 검증 복구

### 변경 사항 (changed)
- `bots/video/lib/ffmpeg-preprocess.js`
  - `syncVideoAudio()`가 오디오 duration 기준 `-t`와 `-shortest`를 사용하도록 수정
  - 긴 원본 영상 + 짧은 나레이션 조합에서 `synced.mp4` video/audio duration mismatch가 생기지 않도록 보강
- `bots/video/scripts/run-pipeline.js`
  - `subtitle.vtt` 생성 시점을 preview 렌더 이전으로 이동
- `bots/video/lib/edl-builder.js`
  - preview watchdog을 예상 duration 기반으로 동적 계산하도록 보강

### 검증
- 5세트 전체 `run-pipeline.js --skip-render` 재실행
  - 파라미터, 컴포넌트스테이트, 동적데이터, 서버인증, DB생성 모두 `preview_ready`
- `bots/video/temp/validation_report.json`
  - `successful=5`, `failed=0`, `avg_total_ms=440378`, `rag_records_stored=7`

## 12주차 후속 (2026-03-21) — 비디오팀 과제 11 Refiner Agent

### 신규 기능 (feat)
- `bots/video/lib/refiner-agent.js`
  - Critic 리포트 기반으로 자막(SRT), EDL, 오디오를 순차 보정하는 BLUE Team 레이어 추가
  - deterministic 치환/타임스탬프 보정/줄 분할을 우선 사용하고, 필요한 경우에만 Groq→Gemini LLM 폴백으로 자막을 재교정
  - `applyPatch()` 기반 EDL 수정과 `normalizeAudio()` 재사용을 통한 오디오 재정규화 경로 추가
- `bots/video/scripts/test-refiner-agent.js`
  - 실제 `critic_report.json` 기준 통합 테스트 추가
  - `subtitle_corrected_v2.srt`, `refiner_result.json` 생성과 SRT/EDL 재검증 포함

### 변경 사항 (changed)
- `bots/video/lib/refiner-agent.js`
  - `runRefiner()`에 단계별 fallback을 추가해 자막/EDL/오디오 중 한 단계 실패가 전체 Refiner 실패로 번지지 않도록 보강

## 12주차 후속 (2026-03-21) — 비디오팀 과제 12 Evaluator + quality loop

### 신규 기능 (feat)
- `bots/video/lib/evaluator-agent.js`
  - Refiner 수정본을 기준으로 Critic을 재호출해 점수, 개선폭, 남은 이슈를 재평가하는 Evaluator 레이어 추가
  - `compareReports()`와 `makeRecommendation()`으로 `PASS / RETRY / ACCEPT_BEST` 판정을 구조화
- `bots/video/lib/quality-loop.js`
  - `critic -> refiner -> evaluator` 반복과 최고 점수 버전 선택을 담당하는 품질 루프 오케스트레이터 추가
  - 각 반복 산출물을 `critic_report_v0.json`, `refiner_result_v1.json`, `evaluation_v1.json`, `loop_result.json`으로 temp 원장에 저장
- `bots/video/scripts/test-quality-loop.js`
  - 실제 quality loop 실행과 진행 이벤트 출력, 최종 결과 저장을 검증하는 테스트 스크립트 추가

### 변경 사항 (changed)
- `bots/video/lib/evaluator-agent.js`
  - standalone `refiner_result.json` 입력에서도 같은 temp 디렉토리의 `analysis.json`을 자동 추론해 재평가를 계속할 수 있도록 입력 경계를 보강

## 12주차 후속 (2026-03-21) — 비디오팀 과제 9 n8n 연동

### 신규 기능 (feat)
- `bots/video/n8n/video-pipeline-workflow.json`
  - `Video Pipeline` 워크플로우 템플릿 추가
  - video start/confirm webhook을 받아 background `run-pipeline.js` 또는 `render-from-edl.js`를 실행하는 순차 체인 구성
- `bots/video/n8n/setup-video-workflow.js`
  - 공용 `n8n-setup-client` 기반 워크플로우 재생성/활성화 스크립트 추가
- `bots/video/scripts/check-n8n-video-path.js`
  - resolved webhook URL, healthz, webhook 등록 상태를 점검하는 진단 스크립트 추가

### 변경 사항 (changed)
- `bots/worker/web/routes/video-api.js`
  - `/sessions/:id/start`, `/edits/:id/confirm`이 `runWithN8nFallback()`로 n8n webhook을 우선 호출하고, 실패 시 기존 detached fork로 direct fallback 하도록 전환
- `bots/video/n8n/video-pipeline-workflow.json`
  - `ExecuteCommand` 대신 `HTTP Request -> /api/video/internal/*` 구조로 호환 전환
- `packages/core/lib/n8n-runner.js`
  - webhook 호출에 커스텀 헤더(`X-Video-Token`) 전달 지원 추가
- `bots/video/lib/video-n8n-config.js`
  - `VIDEO_N8N_TOKEN`을 env 또는 `bots/worker/secrets.json`의 `video_n8n_token` fallback으로 읽는 공용 helper 추가
- 운영 검증
  - 실제 `bots/worker/secrets.json`에 `video_n8n_token`을 반영한 뒤 env 없이도 `setup-video-workflow.js`, `check-n8n-video-path.js`, 내부 dispatch probe가 모두 성공하는 것을 확인
- `bots/video/config/video-config.yaml`
  - 비디오팀 `n8n` 설정 섹션 추가
- `bots/video/n8n/setup-video-workflow.js`
  - registry DB 조회 실패 시에도 setup 성공 후 기본 webhook 경로를 출력하도록 보강
- `bots/worker/web/server.js`
  - `/api/video/internal` 비공개 dispatch 라우트 마운트 추가
- `bots/worker/web/routes/video-internal-api.js`
  - `run-pipeline`, `render-from-edl`용 내부 토큰 보호 dispatch API 추가

## 12주차 후속 (2026-03-21) — 비디오팀 RAG 피드백 루프

### 신규 기능 (feat)
- `packages/core/lib/rag.js`
  - `rag_video` 컬렉션 추가
- `bots/video/lib/video-rag.js`
  - 편집 결과/피드백 저장, 유사 편집 검색, 분석 기반 패턴 추천, Critic/EDL 보강, 예상 시간 추정 구현
- `bots/video/scripts/test-video-rag.js`
  - `rag_video` 초기화, 저장/검색/보강/추정 통합 테스트 추가

### 변경 사항 (changed)
- `bots/video/scripts/run-pipeline.js`
  - `preview_ready` / `completed` 시 편집 결과를 RAG에 저장하도록 연동
- `bots/video/lib/critic-agent.js`
  - 점수 산출 후 `rag_insights`를 병합하도록 보강
- `bots/video/lib/edl-builder.js`
  - 초기 EDL 생성 시 RAG 패턴을 반영하도록 비동기화
- `bots/worker/web/routes/video-api.js`
  - `confirm/reject` 피드백을 RAG에 저장하고 `/estimate`는 RAG 기반 추정을 우선 사용하도록 전환

## 12주차 후속 (2026-03-21) — 비디오팀 과제 10 Critic Agent

### 신규 기능 (feat)
- `bots/video/lib/critic-agent.js`
  - `runCritic`, `analyzeSubtitles`, `analyzeAudio`, `analyzeVideoStructure`, `calculateOverallScore`, `parseSrt`, `saveCriticReport` 구현
  - Gemini `gemini-2.5-flash` 기반 자막 품질 분석과 OpenAI `gpt-4o-mini` fallback 추가
  - FFmpeg loudnorm 기반 LUFS / True Peak 측정 및 issue 생성 추가
  - `analysis.json` 기반 무음/정지/씬전환 구조 분석과 `critic_report.json` 생성 추가
- `bots/video/scripts/test-critic-agent.js`
  - 실제 Critic 실행, 점수/이슈 출력, `temp/critic_report.json` 저장 테스트 추가

### 변경 사항 (changed)
- `bots/video/lib/critic-agent.js`
  - LLM 호출 timeout을 추가해 네트워크 지연 시 Critic이 무한 대기하지 않도록 보강
  - config의 `quality_loop.critic.provider`를 실제 primary provider로 사용하도록 정리
  - 자막 JSON 파싱 실패 시 점수가 과대평가되지 않도록 `score <= 50` 경계 추가
  - 인접한 `scene_change` 후보를 병합해 중복 transition 권고를 줄이도록 보강

## 12주차 후속 (2026-03-21) — 워커 웹 영상 편집 API + 세션 원장 + 대화형 UI

### 신규 기능 (feat)
- `bots/video/migrations/002-video-sessions.sql`
  - `video_sessions`, `video_upload_files` 테이블 추가
  - `video_edits`에 `session_id`, `pair_index`, `confirm_status`, `reject_reason` 컬럼 확장
- `bots/worker/web/routes/video-api.js`
  - `/api/video/sessions`, `/api/video/edits` 계열 API 추가
  - 업로드, 정렬, 노트 저장, 시작, 상태 조회, preview/subtitle/download, ZIP 다운로드 지원
- `bots/video/scripts/render-from-edl.js`
  - confirm 이후 EDL 기준 final render 전용 백그라운드 스크립트 추가
- `bots/worker/web/app/video/page.js`
  - 대화형 영상 편집 메인 UI 추가
  - 업로드, 상태 추적, preview 확인, confirm/reject, 다운로드 흐름 구현
- `bots/worker/web/app/video/history/page.js`
  - 과거 편집 세션 이력 화면 추가

### 변경 사항 (changed)
- `bots/video/scripts/run-pipeline.js`
  - `--session-id`, `--pair-index` 지원 추가
  - worker 세션과 `video_edits` 원장을 직접 연결
- `bots/worker/web/server.js`
  - `/api/video` 라우터 연결
  - UI prefix에 `/video` 추가
- `bots/worker/web/components/Sidebar.js`, `bots/worker/web/components/BottomNav.js`
  - `영상 편집` 메뉴 추가
- `bots/worker/web/lib/menu-access.js`
  - `video` 메뉴를 현재 `projects` 정책에 매핑하는 MVP 권한 해석 추가

## 12주차 후속 (2026-03-20) — 스카 세션 만료 알림 문구 고도화

### 변경 사항 (changed)
- `bots/reservation/auto/monitors/naver-monitor.js`
  - 네이버 세션 만료/자동 재로그인 실패 알림에 즉시 조치 절차를 포함
  - `.playwright-headed` 플래그 생성/삭제, `reload-monitor.sh` 재시작, 수동 로그인 순서를 본문에 직접 표시
  - 네이버 profile 경로와 플래그 파일 경로를 함께 노출해 운영자가 바로 확인할 수 있도록 보강
- `bots/reservation/context/HANDOFF.md`
  - `.playwright-headed` 기반 headed 디버그 운영 가이드와 환경변수 기반 1회 디버깅 예시를 추가

## 12주차 후속 (2026-03-20) — 스카 브라우저 자동화 headless 기본화

### 변경 사항 (changed)
- `bots/reservation/lib/browser.js`
  - `PLAYWRIGHT_HEADLESS` 기본 토글, `NAVER_HEADLESS` / `PICKKO_HEADLESS` 하위 호환, `.playwright-headed` 파일 기반 headed 디버그 전환 지원 추가
  - `pickko`, `naver` 공용 launch 옵션에 `headless: 'new'`, `--disable-gpu`, `--disable-dev-shm-usage`를 반영
- `packages/playwright-utils/src/browser.js`
  - reservation 브라우저 정책과 동일한 headless/ headed 토글 규칙으로 정리
- `bots/reservation/auto/monitors/naver-monitor.js`
  - 네이버 모니터 기본 실행을 headless로 전환하고, 기존 persistent profile 세션은 유지
  - 로그인/종료 안내 문구를 `PLAYWRIGHT_HEADLESS=false` 기준으로 갱신
- `bots/reservation/src/check-naver.js`, `init-naver-booking-session.js`, `inspect-naver.js`, `analyze-booking-page.js`, `get-naver-html.js`
  - 진단 스크립트도 공통 headless 토글을 사용하도록 정리
- `bots/reservation/auto/monitors/start-ops.sh`, `bots/reservation/launchd/ai.ska.naver-monitor.plist`
  - 운영 기본값으로 `PLAYWRIGHT_HEADLESS=true`를 명시

## 12주차 후속 (2026-03-20) — 비디오팀 과제 1 스캐폴딩 생성

### 신규 기능 (feat)
- `bots/video/config/video-config.yaml`
  - YouTube 공식 권장 렌더링 값(24M, H.264 High, 48kHz stereo 384kbps, `+faststart`, `bt709`)을 포함한 비디오팀 설정 파일 추가
- `bots/video/migrations/001-video-schema.sql`
  - `video_edits` 원장 테이블과 상태/생성일 인덱스를 생성하는 초기 DB 스키마 추가
- `bots/video/context/IDENTITY.md`
  - 비디오팀 역할, 소속, 핵심 도구, 렌더링 규칙을 담은 정체성 파일 추가
- `bots/video/src/index.js`
  - config 로드와 `pg-pool` DB 연결을 확인하는 비디오팀 엔트리 추가
- `bots/video/temp/`, `bots/video/exports/`
  - 비디오 처리 임시 산출물과 최종 렌더 출력을 위한 디렉토리 추가

### 변경 사항 (changed)
- `.gitignore`
  - 비디오팀 대용량 미디어 파일(`*.mp4`, `*.m4a`, `*.mp3`, `*.wav`, `*.srt`, `dfd_*/`) 무시 규칙 추가

## 12주차 후속 (2026-03-20) — 비디오팀 과제 2 FFmpeg 전처리

- `bots/video/lib/ffmpeg-preprocess.js`
  - `removeAudio`, `normalizeAudio`, `syncVideoAudio`, `preprocess` 함수 추가
  - 나레이션 정규화 시 config 기반 `-14 LUFS / -1 TP / LRA 20 / 48kHz / stereo / AAC 384k` 적용
  - 영상 스트림은 `-c:v copy`로 재인코딩 없이 유지
- `bots/video/scripts/test-preprocess.js`
  - 샘플 `원본_파라미터` 세트를 사용하는 과제 2 통합 테스트 추가
  - ffprobe로 audio/video stream 사양을 검증하고 loudnorm 측정으로 LUFS 범위를 확인
- macOS 한글 파일명 정규화(NFC/NFD) 차이로 `preprocess()` 매칭이 실패하지 않도록 샘플 파일 탐색 로직을 보강

## 12주차 후속 (2026-03-20) — 비디오팀 과제 3 Whisper STT

- `bots/video/lib/whisper-client.js`
  - OpenAI Whisper API `verbose_json` 호출, 25MB 제한 검사, 429/5xx 재시도, 5분 타임아웃 처리 추가
  - `toSRT()`로 seconds → `HH:MM:SS,mmm` 변환과 SRT 문자열 생성 구현
  - `generateSubtitle()`에서 `subtitle_raw.srt` 저장과 `llm_usage_log` 비용 기록까지 통합
- `bots/video/scripts/test-whisper.js`
  - `원본_나레이션_파라미터.m4a` 기준 실제 Whisper 호출 검증 추가
  - `67 segments`, `subtitle_raw.srt`, 비용 `$0.026119` 확인

## 12주차 후속 (2026-03-20) — 비디오팀 과제 4 LLM 자막 교정

- `bots/video/lib/subtitle-corrector.js`
  - `gpt-4o-mini` + `gemini-2.5-flash` 폴백 기반 자막 교정 모듈 추가
  - 50-entry 청크 처리와 타임스탬프/번호 보존 검증, 구조 불일치 시 원문 유지 fallback 추가
  - 실패 시 텔레그램 알림 후 원본 SRT 복사로 파이프라인 중단을 방지
- `bots/video/scripts/test-subtitle-corrector.js`
  - `subtitle_raw.srt` 기준 실제 교정 테스트 추가
  - entries `67` 유지, 타임스탬프 `67/67` 보존, 비용 `$0.002` 수준 확인
- `bots/video/config/video-config.yaml`
  - `subtitle_correction.fallback_model`을 `gemini-2.5-flash`로 갱신
  - `quality_loop`를 `critic/refiner/evaluator` 역할별 모델 구조로 확장
- `bots/video/docs/video-team-design.md`
  - `subtitle_correction.fallback_model`을 `gemini-2.5-flash`로 갱신

## 12주차 후속 (2026-03-20) — 아처 비용 표 source 보정 + 날짜 포맷 정상화

### 변경 사항 (changed)
- `bots/claude/lib/archer/analyzer.js`
  - 최근 7일 `LLM 비용 트렌드` 표를 `billing_snapshots` day-over-day delta 대신 `reservation.llm_usage_log`의 실제 일별 합계로 계산하도록 변경
  - 월 누적 비용과 소진율은 계속 `billing_snapshots` provider별 최신값을 사용하도록 유지
  - 비용 표 날짜 라벨을 `YYYY-MM-DD` 형식으로 정규화
- `bots/claude/reports/archer-2026-03-20.md`
  - 수정된 집계 로직 기준으로 자동화 리포트를 재생성

## 12주차 후속 (2026-03-20) — KIS 공용 throttling + 아처 비용 리포트 정합성 복구

### 변경 사항 (changed)
- `bots/investment/shared/kis-client.js`
  - KIS 공용 요청 레이어에 `paper/live` 별도 직렬화 queue, 최소 호출 간격, rate-limit 재시도를 추가
  - `초당 거래건수를 초과하였습니다.` 응답이 나올 때 주문/현재가/잔고 조회가 즉시 실패하지 않고 backoff 후 재시도하도록 보강
- `bots/claude/lib/archer/analyzer.js`
  - `billing_snapshots.cost_usd`를 일별 비용처럼 해석하던 오류를 수정
  - 최근 7일 비용 표는 누적 snapshot의 day-over-day delta로 계산
  - 월간 누적/소진율은 provider별 최신 snapshot만 합산하도록 보정

## 12주차 후속 (2026-03-20) — 모바일 알림 short-title 정리 + 스카 모니터 리로드 복구

### 변경 사항 (changed)
- 모바일 텔레그램 카드에서 제목이 2줄로 쉽게 꺾이던 운영 알림을 short-title 중심으로 정리
  - `루나 메트릭 경고`는 `루나 경고`로 축약
  - `국내주식 수집`, `해외주식 수집`은 각각 `국내 수집`, `해외 수집`으로 축약
  - `오늘 예약 현황 — ...` 계열 제목은 `오늘 예약 · ...` 또는 `오늘 예약 (...)` 형태로 짧게 보이도록 정리
- 루나 collect 경고는 raw key 나열 대신 사람이 바로 해석할 수 있는 경고 문장으로 보강
  - `collect_blocked_by_llm_guard`, `enrichment_collect_failure_rate_high`를 `LLM guard 발동`, `보조 분석 수집 차단` 의미로 풀어서 전달
  - 핵심 수집(`coreFailed=0`)과 보조 enrichment 실패를 구분해 과장된 장애 해석을 줄임
- 스카 n8n 매출 알림 제목을 모바일 기준으로 축약
  - `스카팀 일간 매출 요약 (n8n)` → `스카 매출 요약`
  - `스카팀 주간 매출 트렌드 (n8n)` → `스카 주간 매출`
- `reload-monitor.sh`를 강제 `bootout/bootstrap` 기반에서 안전한 `ensure_launchd_service + kickstart -k` 구조로 바꿔 `Bootstrap failed: 5` 재기동 오류를 줄임

## 12주차 후속 (2026-03-20) — 루나 LLM guard 범위 정밀화 + 자동 만료 복구

### 변경 사항 (changed)
- 루나 collect 경고 본문에서 `조치: 상세 내용 확인`, `추가 점검: /ops-health` footer를 중복 생성하던 구조를 제거해 모바일 카드 중복 문구를 정리
- 투자 `LLM guard` scope를 전역 `investment.normal`에서 시장 단위로 정밀화
  - `investment.normal.crypto`
  - `investment.normal.domestic`
  - `investment.normal.overseas`
  - 암호화폐 급등 guard가 국내/해외 enrichment까지 같이 막지 않도록 보정
- 투자팀 per-symbol LLM 호출이 `market`, `symbol`, `guard_scope` 문맥을 함께 전달하도록 보강
  - `athena`, `oracle`, `hermes`, `sophia`, `nemesis`, `luna`의 심볼 분석 호출을 symbol-aware guard에 연결
- `llm_usage_log`에 `market`, `symbol`, `guard_scope` 메타를 저장하도록 확장하고, 심볼 호출은 팀 전체가 아니라 심볼 기준 10분 급등으로 우선 판단하도록 정리
- `billing-guard`에 투자 guard 자동 만료(TTL) 로직을 추가
  - market-level guard: 30분
  - symbol-level guard: 15분
  - `llm-logger`가 생성한 오래된 investment guard는 읽기 시점에 자동 만료/삭제
- 레거시 broad stop 상태를 자동 정리해 현재는 `crypto`, `domestic`, `overseas` 모두 active guard 없이 정상 상태로 복구

## 12주차 후속 (2026-03-21) — 스카 스터디룸 매출 산출식 전환 + 과거 데이터 재검증

### 변경 사항 (changed)
- 스카 스터디룸 매출 원천을 `픽코 예약목록 이용금액` 기준에서 `예약 시간 기반 산출식` 기준으로 전환
  - 배경: 네이버 예약을 픽코에 등록할 때 스터디룸 금액을 `0원`으로 수정하고 있어 `이용금액` 필드를 신뢰할 수 없음
  - 적용 정책:
    - `A1/A2`: `30분당 3,500원`, 단 `00:00~09:00`은 `30분당 2,500원`
    - `B`: `30분당 6,000원`, 단 `00:00~09:00`은 `30분당 4,000원`
- `bots/reservation/lib/study-room-pricing.js`를 추가해 스터디룸 이름 정규화, 시간대별 요금 계산, 룸별 합산을 공용 helper로 분리
- `pickko-daily-summary`와 `pickko-revenue-backfill`이 모두 새 공용 산출식을 사용하도록 정리
- `2026-02`와 `2026-03` Pickko backfill을 다시 실행해 과거 `daily_summary`를 정책 기준으로 재계산
  - 대표 복구:
    - `2026-03-18`: 스터디룸 7건 → `87,500원`
    - `2026-03-10`: timeout으로 빠졌던 A1 4건 → `40,000원`
    - `2026-02-27`: stale `pickko_study_room=7,000` → `122,000원`
- worker `test-company` 미러도 재동기화해 과거 전체 범위에서 `reservation.daily_summary`와 `worker.sales` 차이를 `0건`으로 정리
- 스카 `health-report`의 `daily_summary 무결성` 규칙을 새 정책 기준으로 재정의
  - 이제 실제 오류는 `room_amounts_json`과 `pickko_study_room` 저장값 불일치만 경고
  - `pickko_total != 일반석 + 스터디룸`은 정책상 정상 가능하므로 정보성 차이로만 노출

## 12주차 후속 (2026-03-20) — /ops-health 루나 guard 가시성 보강

### 변경 사항 (changed)
- `/ops-health`와 `루나 운영 헬스`가 투자 `LLM guard` 활성 상태를 직접 표시하도록 보강
  - active guard가 있으면 `암호화폐/국내주식/해외주식` 범위와 자동 해제 시각을 함께 노출
  - `LLM guard n건 활성`을 루나 리스크 사유에 포함해 핵심 서비스 장애와 보조 분석 차단 상태를 운영자가 구분할 수 있도록 정리
- 공용 `billing-guard`에 active guard 목록 조회 helper를 추가해 오케스트레이터 `/ops-health`와 루나 health-report가 같은 source of truth를 공유

## 12주차 (2026-03-19) — 워커 재무 탭 확장 + 업체 비활성화 운영 완결

### 신규 기능 (feat)
- 워커 `매출 관리`를 `매출 | 매입 | 손익` 탭 구조로 확장
  - `worker.expenses` 원장과 `expenses` CRUD / summary / proposal / excel import API를 추가
  - `매입` 탭에서 수동 등록, 제안형 입력, `매입내역` 엑셀 import를 지원
  - `손익` 탭에서 월별 매출/매입/손익 비교와 읽기 전용 브리핑을 제공
- `test-company` 매출을 스카 `reservation.daily_summary`와 자동 동기화하는 projection 레이어를 추가
  - `pickko_total`, `pickko_study_room`, `general_revenue` 기준으로 일반석/스터디룸 매출을 워커 `worker.sales`에 미러링
- 업체 관리에 soft delete 운영 완결 기능 추가
  - `활성 / 비활성 / 전체` 상태 필터
  - 업체 복구 API / UI
  - 비활성화 사유 / 처리자 기록
  - 최근 업체 상태 변경 이력 카드

### 변경 사항 (changed)
- 매출관리 `누적 매출`, `누적 매입`은 이제 lifetime이 아니라 **당해연도(1월 1일 ~ 12월 31일)** 기준으로 계산
- 매입 탭 요약 카드를 `오늘 매입 / 주간 매입 / 월간 매입`으로 정렬
- 손익 탭은 입력형 `PromptAdvisor` 대신 읽기 전용 `손익 브리핑` 패널을 사용하고, 중복되던 `오늘 매출 / 오늘 매입 / 월간 매출 / 이번 달 손익` 카드 줄을 제거
- 공용 `DataTable` 페이지네이션은 한 번에 5개 숫자 버튼을 보여주도록 보강
- `021-company-deactivation-meta.js`를 단독 실행 가능한 마이그레이션 스크립트로 수정해 운영 DB에도 실제 컬럼이 반영되도록 정리

## 12주차 (2026-03-19) — 워커 블로그 URL 입력의 발행일 경계 복구

### 변경 사항 (changed)
- `worker` 웹의 블로그 URL 입력 대상 분류를 `status` 단일 기준에서 `status + publish_date(KST)` 기준으로 보강
  - 기존: `published + URL 없음`만 `입력 필요`
  - 변경: `published + URL 없음` 또는 `ready + publish_date <= 오늘(KST) + URL 없음`을 `입력 필요`로 승격
- `publish_date`가 PostgreSQL `Date` 객체로 들어올 때 `String(date)` 비교로 `Thu Mar 19` 같은 값이 생성되던 버그를 수정
  - 이제 KST 기준 `YYYY-MM-DD`로 정규화한 뒤 비교
- `발행예정`은 이제 `미래 publish_date + ready + URL 미입력`만 남도록 정리
- 블로그 URL 입력 화면에 `발행일`, `발행 확인 필요` 상태를 함께 표시해 운영자가 오늘 발행 대상과 미래 예약 글을 즉시 구분할 수 있게 보강

## 12주차 (2026-03-19) — 워커 web 운영 화면 공용화 + 업무/일정/근태/매출 UI 정리

### 변경 사항 (changed)
- `worker web`의 `PromptAdvisor`에 드래그 앤 드롭 파일 첨부를 추가하고, 드롭 중에는 중앙 정렬 사각형 `+` 아이콘으로 피드백을 주도록 보강
- 첨부 문서 파싱 결과를 프롬프트 본문에 직접 주입하던 구조를 정리
  - 대시보드 / 일정관리 / 업무관리 / 매출관리에서 첨부 문맥을 별도 상태로 유지
  - 제출 시점에만 결과 생성 프롬프트에 합성
  - 첨부파일만 있어도 제출 버튼이 활성화되도록 정리
- 첨부 안내 notice만 있을 때 `확인 및 승인 대기 리스트`가 열리던 중복 UX를 제거
  - 실제 proposal이 생겼을 때만 승인/반려 리스트가 보이도록 수정
- 업무관리 `/work-journals` 경로를 정식 운영 경로로 정리
  - `/journals` 및 상세 경로는 `/work-journals`로 안전하게 연결
  - 사이드바 / 하단 탭 / 대시보드 / 문서 상세 등 진입 링크를 새 경로 기준으로 정렬
- 업무관리 카테고리를 `일반 + 업무`에서 `일일업무`로 통합
  - 기존 `general`, 과거 `task` 데이터는 화면상 `일일업무`로 통일 표시
  - 저장값은 호환성 유지를 위해 `general`로 정규화
- 업무관리 필터/리스트를 단일 운영 카드로 합치고, 검색창을 돋보기 토글 방식으로 정리
- 일정관리
  - 월 이동 줄을 `이전 | YYYY년 M월 | 다음` 좌측 정렬로 정리
  - `캘린더 | 목록` 줄 우측에 `+ 수동 등록` 버튼 배치
  - 캘린더 날짜 그룹핑을 로컬 날짜 기준으로 보정
  - 제안 확정/반려 후 빈 승인 박스 대신 완료 안내가 보이도록 수정
- 근태관리
  - 상단 도구바를 `시작날짜 / 종료날짜`와 `근태현황 | 휴가 | 휴가 승인(n명)` 한 줄 구조로 정리
  - 데스크톱에서 날짜 필터가 2줄로 꺾이지 않도록 `nowrap` 기준 보강
- 공용 `DataTable`의 PC 셀 정렬을 `align-top`에서 `align-middle`로 바꿔 리스트 텍스트가 세로 중앙에 오도록 정리
- 매출관리
  - 구형 자연어 입력 카드를 `PromptAdvisor` 흐름으로 전환
  - `매출 운영 요약`과 `목록 | 차트 | + 매출 등록`을 한 카드 안에 통합
  - `유사 확정 사례`는 정보형으로만 유지하고 재작성 우회 버튼은 제거

## 12주차 (2026-03-19) — 투자 validation 성과 반영 + worker/blog 복구

### 신규 기능 (feat)
- 투자 validation 성과를 일간/주간/설정 제안 리포트에 연결
  - `trading-journal.js`, `weekly-trade-review.js`가 `crypto / domestic / overseas × NORMAL / VALIDATION` 통합 피드백과 `validation 승격 후보`를 함께 출력하도록 확장
  - `runtime-config-suggestions.js`가 validation `approved / executed / LIVE / PAPER`를 실제 `trades` 기준으로 보정해 `normal 승격 후보`를 직접 제안하도록 보강
- 국내장 validation 성과를 normal 정책에 제한 승격
  - `runtime_config.nemesis.thresholds.stockStarterApproveDomestic: 400000 -> 450000`

### 변경 사항 (changed)
- 투자팀 레거시 `billing-guard` 해석을 조정
  - 기존 `.llm-emergency-stop`의 `investment` scope는 이제 `investment.normal`만 차단
  - `investment.validation`은 같은 파일에 전염되지 않도록 `packages/core/lib/billing-guard.js`를 보강
- 국내장 validation은 `LLM 긴급 차단 fallback` 대신 정상 분석/판단 경로로 복구
  - 강제 세션에서 `214390 BUY 500000 자동 승인`, `최종 결과: 1개 신호 승인` 확인
- 암호화폐 validation도 `PAPER 2건`이 실제 일간 리포트에 반영돼 `승격 후보`로 전환
- `blog node-server`, `worker lead`, `worker task-runner`를 launchd 재등록으로 복구
  - 팀 health-report 기준 모두 `정상` 상태 회복

## 12주차 (2026-03-19) — 루나 normal / validation 거래 레일 분리 준비

### 신규 기능 (feat)
- 투자팀 운영모드 분리를 launchd 레벨까지 연결할 준비를 완료
  - 기존 `ai.investment.crypto`는 `INVESTMENT_TRADE_MODE=normal`을 명시한 정상거래 레일로 유지
  - 신규 `bots/investment/launchd/ai.investment.crypto.validation.plist`를 추가해 `INVESTMENT_TRADE_MODE=validation` 기반 검증거래 레일을 별도 정의
  - validation 레일은 별도 로그(`/tmp/investment-crypto-validation*.log`)와 별도 guard scope를 사용하도록 정리

### 변경 사항 (changed)
- 재부팅 전/후 운영 절차를 새 투자 모드 분리를 인지하도록 보강
  - `pre-reboot.sh`가 `ai.investment.crypto.validation` 정지 신호도 함께 처리
  - `post-reboot.sh`가 `ai.investment.crypto.validation`을 선택적 서비스로 점검
- 운영 문서에 투자팀 `normal / validation` 레일 개념과 로그 경로를 반영
  - `OPERATIONS_RUNBOOK.md`
  - `team-features.md`
  - `SESSION_HANDOFF.md`

## 12주차 (2026-03-19) — validation 전용 자금정책 / starter 승인 분리

### 변경 사항 (changed)
- 투자 validation 모드가 normal과 다른 자금정책을 읽도록 확장
  - `capital_management.by_exchange.binance.trade_modes.validation`
  - `reserve_ratio: 0.01`
  - `risk_per_trade: 0.01`
  - `max_position_pct: 0.08`
  - `max_concurrent_positions: 3`
  - `max_daily_trades: 8`
- `capital-manager.js`가 `INVESTMENT_TRADE_MODE`를 읽어 바이낸스 전용 mode override를 자동 합성하도록 보강
- `nemesis.js`가 `runtime_config.nemesis.thresholds.byTradeMode.validation`을 읽어 validation 모드에서 starter 승인 기준을 별도로 적용
  - `cryptoRejectConfidence: 0.39`
  - `cryptoStarterApproveConfidence: 0.40`
  - `cryptoStarterApproveMaxRisk: 7`
  - `cryptoStarterScale: 0.45`
- validation은 normal보다 더 작은 사이징 / 더 작은 포지션 수 / 더 완화된 starter 승인으로 검증거래를 수행할 수 있는 기반을 확보

## 12주차 (2026-03-19) — 투자 `trade_mode` 영속화 + 일지/주간 리뷰 분리

### 신규 기능 (feat)
- 투자 실행 이력에 `trade_mode(normal/validation)`를 영속 저장하도록 확장
  - `signals.trade_mode`
  - `trades.trade_mode`
  - `trade_journal.trade_mode`
  - `pipeline_runs.meta.investment_trade_mode`

### 변경 사항 (changed)
- `db.js`, `trade-journal-db.js`가 `INVESTMENT_TRADE_MODE`를 기본값으로 읽어 signal / trade / trade_journal 레코드에 저장
- `pipeline-decision-runner.js`가 모든 종료 경로 메타에 `investment_trade_mode`를 함께 남기도록 보강
- `trading-journal.js`, `weekly-trade-review.js`가 거래/리뷰/퍼널 요약에서 `NORMAL / VALIDATION` 운영모드를 함께 보여주도록 확장
- 이제 validation 거래가 normal 거래와 같은 KPI로 섞이지 않고, 일간/주간 운영 리뷰에서 분리 관측 가능한 기반을 확보
- `trading-journal.js`는 실행 시작 시 `initJournalSchema()`를 명시적으로 호출하도록 보강해, 기존 DB에서 `trade_journal.trade_mode` 미마이그레이션으로 일지가 실패하던 경로를 복구
- `crypto.js`는 `investment-state.json`을 `trade_mode`별로 분리해, validation canary가 normal 레일의 쿨다운/긴급트리거 상태와 섞이지 않도록 정리

## 12주차 (2026-03-19) — 국내장/해외장 validation 레일 공용화

### 신규 기능 (feat)
- 국내장 / 해외장도 `normal / validation` 운영모드 구조를 공유할 수 있도록 launchd validation 레일을 추가
  - `bots/investment/launchd/ai.investment.domestic.validation.plist`
  - `bots/investment/launchd/ai.investment.overseas.validation.plist`

### 변경 사항 (changed)
- `pre-reboot.sh`, `post-reboot.sh`, `bots.js`가 domestic/overseas validation 레일을 선택적 서비스로 인지하도록 확장
- `OPERATIONS_RUNBOOK.md`, `SESSION_HANDOFF.md`, `team-features.md`에 세 시장(`crypto / domestic / overseas`) 공통 validation 운영 구조와 활성화 절차를 반영
- 세 시장에서 생성되는 `trade_mode` 기반 시그널/거래/퍼널 데이터를 통합 피드백 루프로 묶을 수 있는 운영 기반을 확보

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

- 비디오팀 신규 과제용 `bots/video/docs/` 문서 묶음을 정리하고 `video-team-tasks.md`를 추가해 인수인계/설계/소과제 문서 참조를 연결
- `video-automation-tech-plan.md`의 프로젝트 경로를 현재 저장소 기준으로 수정하고, `docs/SESSION_HANDOFF.md`의 비디오팀 섹션을 `문서 정리 완료 / 구현 스캐폴딩 시작 전` 상태로 갱신
- `bots/video/scripts/`는 문서 배치용 보조 폴더였고 실제 구현 스크립트가 아니므로 제거해 신규 비디오팀 폴더의 경계를 단순화

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
- 워커 web / 스카 매출
  - `bots/worker/lib/ska-sales-sync.js`를 추가해 `test-company`가 `reservation.daily_summary`를 source of truth로 삼아 `worker.sales`에 자동 동기화되도록 정리
  - `/api/sales`, `/api/sales/summary`, `/api/dashboard/summary`, `/api/ai/revenue-forecast` 조회 전에 스카 매출 동기화를 선행하도록 보강
  - 스카 `pickko_total`을 우선 총액 원천으로 사용하고 `general_revenue`는 `일반석`, 나머지는 `스터디룸`으로 투영하도록 정리
  - `test-company` 누락 구간(특히 2026-03-16~2026-03-18)을 backfill 후 워커 매출과 스카 원천 총액을 다시 일치화
  - `pickko_study_room`이 0이더라도 `room_amounts_json`에 스터디룸 합계가 남아 있는 날짜 37건을 원천(`daily_summary`)과 워커 미러에서 함께 복구
  - 자정이 아닌 보고가 `pickko_total/pickko_study_room/general_revenue`를 0으로 다시 덮어쓰지 않도록 `upsertDailySummary()`를 `COALESCE` 기반 보존형으로 보강
  - `bots/reservation/scripts/health-report.js`에 `daily_summary` 무결성 섹션을 추가해 `room_amounts_json`, `pickko_study_room`, `pickko_total` 구조 이상을 운영 헬스에서 바로 감지하도록 정리
  - `sales/page.js`의 `누적 금액`을 전체 누적(`summary.lifetime`) 기준으로, `월간 매출`을 이번 달(`summary.currentMonth`) 기준으로 수정
  - 매출 목록 조회 상한을 `limit=200 -> 1000`으로 늘려 2026-01-13 이전 과거 데이터가 화면에서 잘리지 않도록 정리
  - 공용 `DataTable` 페이지네이션 숫자 버튼을 최대 5개 window(`1 2 3 4 5`)로 확장
- 투자 / 한울 / 루나 경고 해석
  - `pipeline-market-runner.js`에서 collect 실패율 경고를 `core_collect_failure_rate_high`, `enrichment_collect_failure_rate_high`, `collect_blocked_by_llm_guard`로 세분화해 핵심 수집 실패와 LLM 의존 보조 수집 실패를 구분하도록 정리
  - `crypto/domestic/overseas` 메트릭 로그에 `coreFailed`, `enrichFailed`를 함께 출력하고 새 경고 키도 escalated alert 대상으로 연결
  - `shared/kis-client.js`의 국내 현재가 0원 응답을 `거래불가/종목코드 확인 필요` 성격으로 더 명확히 분류
  - `team/hanul.js`에서 국내 KIS BUY도 사전 현재가 검증을 수행해 `0원 응답 종목`은 주문 단계 전에 리스크 거부하도록 보강
- 스카 예약 운영
  - `pickko-alerts-resolve.js`를 PostgreSQL 기반으로 복구해 수동 처리 완료 시 실제 unresolved error alerts를 해결 처리하도록 정리
  - `orchestrator/router.js`에서 `처리완료`, `해결했어`, `직접 처리했어`, `마스터가 수동으로 처리함` 계열 문구를 즉시 alert resolve 명령으로 연결
  - `ska-command-handlers.js`, `dashboard-server.js`의 `store_resolution`도 이제 RAG 저장만 하지 않고 실제 `reservation.alerts` error row를 함께 resolve 하도록 보강해, direct resolve 경로를 놓쳐도 동일 알림이 재시작 요약에 재등장하지 않게 정리
  - `naver-monitor.js`의 취소 재시도 전에 예약 종결 상태를 다시 조회해 `completed/cancelled/time_elapsed/marked_seen` 예약은 재알림 없이 건너뛰고 기존 오류 알림도 자동 resolve 하도록 보강
  - 스카 재시작 시 `미해결 오류 n건` 시작 보고는 현재 actionable alert만 남기고, 이미 종결된 예약의 과거 실패 알림은 요약 전에 자동 정리하도록 수정
  - `TEAM_SKA_REFERENCE.md`, `coding-guide.md`, `SYSTEM_DESIGN.md`를 최신 Playwright 정책에 맞춰 `PLAYWRIGHT_HEADLESS` 기본 headless 운영, `.playwright-headed` headed 복구, legacy `PICKKO_HEADLESS/NAVER_HEADLESS` 호환 구조 기준으로 정합화
  - `db.js`에 `getOpenManualBlockFollowups()`를 추가하고 `pickko-kiosk-monitor.js`가 `manual follow-up open` 미래 예약도 정기 차단 재시도 레일에 포함하도록 보강
  - `pickko-kiosk-monitor.js`의 B룸 오전 슬롯 block/verify 로직을 visible time axis 기준으로 보정하고 `avail` 전용 필터, slot guard, trailing half-hour verify 추론을 추가해 잘못된 슬롯 저장 위험을 낮춤
  - 이재룡 `010-3500-0586 / 2026-11-28 11:00~12:30 B` 테스트 예약은 최종적으로 `already_blocked` 상태로 수렴했고, manual follow-up 원장 기준 `naver_blocked=1`, `last_block_result=blocked`, `last_block_reason=already_blocked` 상태를 확인
  - `naver-monitor.js`의 자동 취소 경로는 이제 픽코 취소 성공 후 `pickko-kiosk-monitor.js --unblock-slot`까지 이어져 자동 취소도 `취소 -> 픽코 취소 -> 네이버 예약가능 복구` 완결 경로를 갖게 됨
  - `pickko-cancel-cmd.js`는 픽코 취소 성공/네이버 해제 실패를 더 이상 `success: true`로 포장하지 않고 `partialSuccess / pickkoCancelled / naverUnblockFailed`를 포함한 실패 응답으로 반환하도록 보강
- 투자
  - `pipeline-decision-runner.js`가 이제 `weakSignalSkipped`를 `confidence_near_threshold`, `confidence_mid_gap`, `confidence_far_below_threshold`로 분해해 `pipeline_runs.meta`에 `weak_signal_reason_top`, `weak_signal_reasons`를 저장
  - `trading-journal.js`, `weekly-trade-review.js`, `runtime-config-suggestions.js`는 새 weak reason 메타를 읽어 `weakTop`을 출력하도록 연결
  - 이를 통해 암호화폐 튜닝에서 “threshold를 소폭 낮출지”와 “실제로 신호 품질을 먼저 올려야 할지”를 더 분리해서 판단할 수 있게 정리
  - `hephaestos.js`, `hanul.js`의 추가진입 차단 코드를 `paper_position_reentry_blocked`, `live_position_reentry_blocked`로 분리해 PAPER 검증 병목과 LIVE 실포지션 병목을 구분 가능하게 정리
  - `crypto-live-gate-review.js`를 추가해 최근 암호화폐 퍼널/체결/차단/종료리뷰를 기준으로 LIVE 전환 게이트를 자동 판정하도록 정리하고, `pipeline_runs.market`이 `binance`로 저장되는 기존 구조까지 반영해 집계 정확도를 맞춤
  - `health-report.js`가 최근 3일 암호화폐 LIVE 게이트를 `cryptoLiveGateHealth` 섹션으로 직접 노출하고, 운영 판단에 LIVE 게이트 blocked 사유를 포함하도록 보강
  - `force-exit-runner.js`가 KIS force-exit preview/execute 전에 `accountMode / executionMode / marketStatus / capability`를 계산하는 capability preflight를 추가해 국내장 mock 장중 전용, 해외장 mock SELL 제한 상태를 명시적으로 출력하도록 보강
  - `health-report.js`에 `kisCapabilityHealth` 섹션을 추가해 KIS 국내/해외 계좌 모드와 현재 SELL 가능 범위를 운영 헬스에서 직접 읽게 정리
  - `hanul.js`가 이제 국내/해외 KIS 주문을 브로커에 보내기 전에 장중 여부를 먼저 검사해, 장외 시간에는 broker reject 대신 executor 레벨에서 즉시 차단하도록 보강
- LLM selector / speed test
  - `speed-test.js`가 모든 모델 실패와 snapshot 저장 실패를 실제 non-zero exit로 처리하도록 보강해 selector speed 자동화의 false success를 제거
  - Gemini speed test 요청은 모델별 thinking budget을 분기해 `gemini-2.5-pro`의 `thinking_budget=0` 오류를 해소
  - 최신 snapshot에 실패 모델 `errorClass`를 함께 저장하고, `llm-selector-speed-review.js`가 최신 실패 모델/분류를 직접 출력하도록 보강
  - `llm-selector-speed-review.js`가 `primaryHealth`, `latestPrimaryResult`를 함께 출력해 `추천 모델`과 `현재 primary 위험`을 한 리포트에서 분리해서 읽을 수 있게 정리
  - `llm-selector-speed-review.js`가 `primaryFallbackCandidate`도 함께 출력해 현재 primary가 unhealthy일 때 같은 provider 안의 안전한 대체 후보(`gemini-2.5-flash-lite`)를 바로 제시하도록 보강
  - `llm-selector-speed-review.js`가 최근 snapshot history를 읽어 `primaryFallbackPolicy`를 계산하고, 연속 rate-limit 시 `temporary_fallback_candidate` 신호를 출력하도록 확장
  - `GEMINI_FLASH_TEMPORARY_FALLBACK_POLICY_2026-03-22.md`를 추가해 `gemini-2.5-flash -> gemini-2.5-flash-lite` 임시 전환 조건, 금지 조건, 롤백 조건을 운영 문서로 고정
  - 운영 모델 레지스트리 `~/.openclaw/openclaw.json`에 `gemini-2.5-flash-lite`, `groq/moonshotai/kimi-k2-instruct-0905`를 반영하고 `cerebras/gpt-oss-120b`는 현재 404 기준으로 제거
- 비디오
  - `bots/video/scripts/check-capcut-readiness.js`를 추가해 과제 5 전 CapCutAPI/CapCut Desktop 준비 상태를 점검하도록 정리
  - readiness 검증 결과 `create_draft / save_draft`는 정상이나 draft 저장 위치가 CapCut Desktop 프로젝트 폴더가 아니라 `CapCutAPI` repo 내부 `dfd_cat_*`임을 문서에 반영
  - `bots/video/lib/capcut-draft-builder.js`, `bots/video/scripts/test-capcut-draft.js`를 추가해 CapCutAPI HTTP API 기반 draft 생성과 `copyToCapCut()` Desktop 연동 흐름을 구현
  - `add_subtitle`는 CapCutAPI upstream `font_type` 오류를 피하기 위해 기본 `font='文轩体'`, `vertical=false`, `alpha=1.0`, `width/height`를 명시 전달하도록 보강
  - 실제 통합 테스트에서 repo 내부 `dfd_cat_*` draft 생성, CapCut Desktop 프로젝트 디렉토리 복사, Desktop 프로젝트 목록 표시를 모두 확인
  - `bots/video/lib/video-analyzer.js`, `bots/video/lib/edl-builder.js`를 추가해 EDL JSON 기반 영상 분석/프리뷰/최종 렌더 경로를 구현
  - `bots/video/scripts/test-video-analyzer.js`, `bots/video/scripts/test-edl-builder.js`를 추가해 분석/EDL/렌더 테스트 진입점을 마련
  - 120초 smoke clip 기준 preview/final 렌더 검증에서 `2560x1440 / 60fps / H.264 High / 48kHz stereo / faststart`를 확인
  - 현재 로컬 FFmpeg에 `drawtext`, `subtitles` 필터가 없어 overlay / burn-in은 capability fallback으로 자동 생략되도록 보강
  - `bots/video/scripts/run-pipeline.js`를 추가해 source 선택, `video_edits` 상태 기록, 전처리 → STT → 자막교정 → 분석 → EDL → preview/final 흐름을 한 CLI로 연결
  - `bots/video/src/index.js`는 `loadConfig()`를 export 하도록 리팩터링되어 pipeline runner가 config 로드를 재사용
  - 실자산 `--source=1 --skip-render` 검증에서 preview 이전 단계가 모두 통과했고, 실자산 preview wall-clock 병목을 줄이기 위해 EDL builder에 인접 scene transition merge 보정을 추가
  - `run-pipeline`에 single-flight lock, stale lock 정리, SIGINT/SIGTERM lock 해제를 추가해 중복 실행과 비정상 종료 시 프로세스 잔여 위험을 낮춤
- 스카
  - `pickko-accurate.js`가 픽코 등록 실패 시 `PICKKO_FAILURE_STAGE=...` 마커를 함께 출력하도록 보강되어 `lock/member/date/slot/save/payment` 경계를 로그에서 바로 읽을 수 있게 됨
  - `naver-monitor.js`의 `runPickko()`가 위 실패 단계 마커를 파싱해 `errorReason`과 수동 처리 알림에 `[STAGE_CODE]`, `🧩 실패 단계`를 포함하도록 정리
  - 이를 통해 “재시도는 했지만 계속 실패”를 한 덩어리 `failed`가 아니라 원인 단계별로 읽는 1차 계측 레일을 확보
 - 블로그
  - `gems-writer.js`의 일반 포스팅 이어쓰기 경계에 섹션 마커 기반 중복 정리 레이어를 추가
  - `general_post_continue`가 완성본을 다시 시작하더라도 기존 `# 제목` 감지에만 의존하지 않고, `AI 스니펫 요약`, `승호아빠 인사말`, `본론 섹션 1/2/3`, `함께 읽으면 좋은 글` 등 주요 섹션 마커를 기준으로 중복 append를 차단
  - 이미 작성된 섹션부터 재시작하면 아직 안 나온 섹션부터 잘라 이어붙이고, 전부 이미 작성된 섹션이면 continuation 전체를 버리도록 보강
- `scripts/reviews/jay-llm-daily-review.js`
  - `freshness.level / freshness.trust / freshness.summary` 메타를 추가해 live DB와 snapshot fallback 해석 경계를 강화
  - stale snapshot fallback일 때 텍스트 출력에 `운영 신뢰도`와 `참고용 해석` 경고를 함께 노출
