# 세션 핸드오프

> 다음 세션은 먼저 [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)를 읽고 이 문서를 보세요.
> 현재 active risk / watch / recently resolved만 빠르게 보려면 [ACTIVE_OPS_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/docs/ACTIVE_OPS_SUMMARY.md)를 함께 확인하세요.

> 세션 마감 준비 메모 (2026-03-22)
> `bots/claude/.checksums.json`은 이번 세션 말미에 다시 갱신됐다.
> 다만 현재 워킹트리에는 비디오 외 `orchestrator / reservation / ska`의 미커밋 변경이 함께 남아 있으므로, 체크섬은 “현재 dirty workspace 기준 최신 상태”로 해석해야 한다.

---

## 2026-03-23 — 루나 암호화폐 TP/SL 실패 추적 계측 1차

- 투자 운영 점검 결과, 현재 LIVE 확대 병목은 `entry`보다 `exit / protection` 경계다.
  - 실제 open 포지션은 누적돼 있지만 최근 7일 `closed trade / closed review`는 사실상 0건이었다.
  - 특히 crypto는 코드상 OCO/SL-only 보호 주문 경로가 존재하지만 실제 DB 기준 `tp_sl_set=0`, `protective_order_count=0` 상태다.
- 이를 추적하기 위해 `trade_journal`에 crypto TP/SL 결과를 직접 남기는 1차 계측을 추가했다.
  - [trade-journal-db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/trade-journal-db.js)
    - `tp_sl_mode`
    - `tp_sl_error`
  - [hephaestos.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hephaestos.js)
    - BTC 직접 매수
    - 미추적 잔고 흡수
    - 일반 BUY
    세 경로 모두 `protection.ok / mode / tp/sl orderId / error`를 `trade_journal`에 남기도록 보강
- 의미:
  - 이제 “TP/SL이 왜 0%인가”를 감으로 보지 않고
  - `oco`, `oco_list`, `stop_loss_only`, `failed`와 실제 에러 문자열 기준으로 추적 가능
- 현재 운영 판단은 유지:
  - crypto LIVE 확대 금지
  - domestic LIVE는 현 수준 유지까지만 가능
  - overseas LIVE 확대 금지
- 다음 자연스러운 단계:
  1. 실제 crypto BUY 한두 사이클에서 `trade_journal.tp_sl_mode / tp_sl_error` 누적 확인
  2. `stop_loss_only`가 반복되면 브로커 호환/주문 파라미터 경계 점검
  3. domestic/overseas는 `force-exit` 최소 정책 별도 설계

## 2026-03-23 — 루나 crypto TP/SL capability-first 정책 반영

- [hephaestos.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hephaestos.js)는 이제 보호 주문에서 `capability-first` 분기를 사용한다.
  - `safeFeatureValue()` / `getProtectiveExitCapabilities()`로 CCXT capability를 먼저 읽는다.
  - 우선순위는 다음과 같다.
    1. raw Binance OCO
    2. raw Binance `orderListOco`
    3. CCXT `stopLossPrice` 기반 `ccxt_stop_loss_only`
    4. exchange-specific `stop_loss_limit` 기반 `exchange_stop_loss_only`
- 의미:
  - 기존 raw OCO fallback을 버리지 않고,
  - 공식 CCXT capability가 보이는 경우에는 표준 stop-loss 경로까지 탐색하도록 정리한 것이다.
- 현재 운영 판단은 동일하다.
  - 이 단계는 성공률 개선 실험이 아니라 `공식 우선 + 실패 원인 추적 강화` 단계
  - crypto LIVE 확대 금지는 그대로 유지

## 2026-03-23 — 루나 Binance 자본 스코프 경계 복구

- crypto TP/SL 실표본 확보를 위해 `ETH/USDT` 소액 LIVE probe를 다시 태우는 과정에서, 보호 주문 이전에 `capital-manager` 경계 버그가 먼저 드러났다.
  - 기존 `preTradeCheck()`는 바이낸스 BUY를 검토하면서도 `getTotalCapital()`에 국내장/해외장 포지션까지 함께 합산했다.
  - 그 결과 Binance reserve 계산이 KIS 포지션을 USDT 자본처럼 읽어 `예비금 111298.75 USDT` 같은 비정상 요구치가 생기고, 실주문이 `실잔고 부족 → PAPER 폴백`으로 잘못 내려가고 있었다.
- [capital-manager.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/capital-manager.js)는 이제 거래소 스코프를 분리한다.
  - `getAvailableBalance(exchange)`는 바이낸스가 아닌 경우 `0`으로 반환
  - `getTotalCapital(exchange)`는 해당 거래소 `open positions`만 평가금액에 포함
  - `preTradeCheck()` / `calculatePositionSize()`도 모두 `exchange` 인자를 넘겨 같은 스코프를 사용
- 재검증 결과:
  - `getAvailableBalance('binance') = 521.56`
  - `getTotalCapital('binance') = 713.46`
  - `preTradeCheck('ETH/USDT', 'BUY', 15, 'binance', 'normal') => allowed=true`
- 같은 `ETH/USDT` probe를 다시 실행했을 때는 더 이상 PAPER 폴백이 아니라 LIVE 레일로 들어갔고, 이번엔 다음 경계인 `최대 포지션 도달: 6/6`에서 중단됐다.
  - 의미: TP/SL 보호 주문 경계를 보기 전, 먼저 자본관리 입력 경계가 복구됐음을 확인했다.
- 현재 운영 판단:
  - crypto LIVE 확대 금지 유지
  - 추가 LIVE probe도 기존 open position을 줄이기 전까지는 불가
  - 다음 우선순위는 `포지션 6/6` 경계와 오래된 open 포지션 정리 정책 점검

## 2026-03-23 — 루나 PAPER→LIVE 승격 슬롯 잠식 경계 복구

- `ETH/USDT` 소액 LIVE probe를 다시 태우는 과정에서, 이번엔 자본관리 경계는 통과했지만 BUY 직전 `maybePromotePaperPositions()`가 PAPER normal 포지션 5건(`KAT/USDT`, `OPN/USDT`, `SAHARA/USDT`, `TAO/USDT`, `KITE/USDT`)을 한꺼번에 LIVE로 승격시켰다.
- 그 결과 probe 자체는 보호 주문 단계까지 가지 못하고 `최대 포지션 도달: 6/6`에서 중단됐다.
  - 현재 Binance LIVE normal open 포지션은 `ROBO/USDT` + 위 승격 5건으로 정확히 6개다.
- [hephaestos.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hephaestos.js)는 이제 승격 시 `reserveSlots`를 받는다.
  - BUY 직전 호출은 `maybePromotePaperPositions({ reserveSlots: 1 })`
  - 즉 현재 처리 중인 BUY가 사용할 슬롯 1개는 반드시 남기고, 그 범위 안에서만 PAPER→LIVE 승격을 허용한다.
- 의미:
  - 기존에는 “신규 LIVE 진입을 위해 실행한 BUY”가 오히려 사전 승격 로직 때문에 자기 슬롯을 잃는 구조였다.
  - 이번 수정으로 `promotion`은 더 이상 현재 BUY를 굶기지 못한다.
- 운영 판단:
  - 구조 버그는 복구됐지만, 이미 열린 6개 LIVE 포지션은 그대로이므로 추가 probe는 아직 불가
  - 다음 단계는 오래된 LIVE open 포지션 정리 기준/force-exit 정책 점검

## 1. 현재 시스템 상태 요약

- 스카
  - `daily_summary`에서 `pickko_total` 컬럼을 제거했다. `v009 daily_summary_remove_pickko_total`까지 적용 완료됐고, 현재 저장 기준은 `general_revenue=payment_day|general`, `pickko_study_room=use_day|study_room`이다.
  - 관련 write/read 경로(`db.js`, `pickko-daily-summary.js`, `pickko-revenue-backfill.js`, `ska-sales-sync.js`, `ska-read-service.js`, `dashboard-server.js`, `health-report.js`, `feature_store.py`, `etl.py`, CSV/model export`)는 모두 `pickko_total` 의존을 제거했다.
  - `node bots/reservation/scripts/migrate.js --status` 기준 현재 스키마 버전은 `v9`이며, `v008 pickko_order_raw_cleanup`, `v009 daily_summary_remove_pickko_total`까지 모두 적용됐다.
  - `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365`를 재실행해 예측 ETL도 새 스키마로 다시 동기화했다. 현재 최근 5일 preview 기준 `2026-03-22 actual_revenue=309800`, `2026-03-21 actual_revenue=288000`, `2026-03-20 actual_revenue=379800`으로 반영된다.
  - `study-room-pricing.js`를 문서 기준으로 다시 맞췄다. 현재 스터디룸 계산식은 `A1/A2: 30분당 3,500원, 00:00~09:00은 2,500원`, `B: 30분당 6,000원, 00:00~09:00은 4,000원`이며, 픽코 시간 왜곡을 고려해 `30분 슬롯 시작 시각` 기준으로 합산한다.
  - `use_day|study_room`는 여전히 `raw_amount > 0`이면 raw 금액을 우선 사용하고, 없을 때만 위 슬롯 계산식을 사용한다. `payment_day|study_room` row와 `amount_delta` 컬럼은 제거된 상태를 유지한다.
  - 수정된 계산식으로 `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03`를 다시 실행했고, 이후 `syncSkaSalesToWorker('test-company')`를 재실행했다. worker sync 결과는 `updated=12`, `expectedRows=299`였다.
  - 대표 검증값은 다음과 같다.
    - `2026-03-01`: `pickko_study_room=113000`, `general_revenue=113800`
    - `2026-03-12`: `pickko_study_room=135000`, `general_revenue=265000`
    - `2026-03-17`: `pickko_study_room=74500`, `general_revenue=290000`
    - `2026-03-21`: `pickko_study_room=156000`, `general_revenue=132000`
    - `2026-03-22`: `pickko_study_room=136000`, `general_revenue=173800`
  - 운영 검증 기준도 다시 고정했다. 스터디카페 매출은 `payment_day|general`을 픽코 `매출현황` 기준으로 보고, 스터디룸 매출은 `use_day|study_room`을 픽코 `예약/이용 검색` 기준으로 본다. `2026-03-17`의 `pickko_study_room=74,500원`은 예약기준 화면의 5건과 일치한다.
  - 스카 매출 source of truth 변경 영향 범위를 다시 점검했고, `daily_summary.total_amount`를 총매출처럼 읽던 경로들을 현재 정책 기준으로 정렬했다.
  - `bots/reservation/lib/ska-read-service.js`, `bots/reservation/scripts/dashboard-server.js`, `bots/reservation/scripts/dashboard.html`, `scripts/collect-kpi.js`는 이제 총매출을 `general_revenue + pickko_study_room` 기준으로 읽는다. 기존 `total_amount`는 호환용으로 유지하되, 조회 응답에는 `total_revenue`를 함께 노출한다.
  - 위 합산값은 현재 `combined_revenue` / `내부 합산매출`로도 함께 노출한다. 의미는 `payment_day|general + use_day|study_room`의 내부 운영 총합이며, 운영자 화면에서 스터디카페/스터디룸 축과 분리해 표시한다.
  - `bots/ska/src/etl.py`도 새 기준으로 정렬했다. `studyroom_revenue=pickko_study_room`, `general_revenue=general_revenue`, `actual_revenue=studyroom_revenue+general_revenue`를 기준으로 `ska.revenue_daily`를 다시 적재하며, `room_amounts_json`과 `total_amount`는 fallback 경계로만 사용한다.
  - `scripts/reviews/ska-sales-forecast-daily-review.js`는 `daily_summary` 보조 표시값을 `total_revenue / studyRoomRevenue / generalRevenue` 기준으로 다시 노출한다. `forecast_date::text`를 사용하도록 바꿔 review 날짜가 하루 밀려 보이던 경계도 함께 복구했다. 주간 리뷰도 같은 날짜 캐스팅 경계를 맞췄다.
  - `collect-kpi.js`와 `etl.py`에도 같은 의미 주석을 추가했다. 합산 로직은 유지하되, KPI/예측 actual이 `결제축 일반매출 + 예약축 스터디룸매출`의 내부 운영 총합이라는 점을 코드에 명시했다.
  - `ska-sales-forecast-weekly-review.js`, `export-ska-sales-csv.js`, `health-report.js`도 같은 용어로 맞췄다. 주간 리뷰는 `실매출` 대신 `내부 합산매출`을 쓰고, CSV는 `study_cafe_revenue / study_room_revenue / combined_revenue` 컬럼으로 내보내며, health는 `daily_summary 무결성(스터디룸 축)`으로 표기한다.
  - `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365`를 재실행해 `revenue_daily`와 `training_feature_daily`까지 새 기준으로 동기화했다. 현재 최근 5일 미리보기 기준 `2026-03-22 actual_revenue=309800`, `2026-03-21 actual_revenue=288000`, `2026-03-20 actual_revenue=379800`으로 반영됐다.
  - 현재 ETL 기준 actual은 `general_revenue + pickko_study_room` 합산값이며, `2026-03-22`는 `173800 + 136000 = 309800`, `2026-03-21`은 `132000 + 156000 = 288000`으로 읽는다.
  - 예측엔진 후속 정리 기준은 [SKA_FORECAST_ENGINE_UPDATE_STRATEGY_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_FORECAST_ENGINE_UPDATE_STRATEGY_2026-03-22.md)에 문서화했다.
  - 2026-03-23 예측엔진 1차 정리에서 `feature_store.py`의 stale feature를 다시 점검했다. `payment_day|study_room` 축은 운영 DB에서 이미 제거됐으므로, `study_room_payment_*` 컬럼은 학습 스키마 호환용으로만 유지하고 더 이상 raw source를 읽지 않도록 바꿨다. 현재 `training_feature_daily`에서는 해당 컬럼들이 전부 `0`으로 고정된다.
  - 같은 정리에서 `total_amount`는 예측 target의 source of truth가 아니라 `legacy compatibility / fallback trace` 필드로만 취급하도록 의미를 명시했다. 현재 active target은 여전히 `actual_revenue = reservation_general_revenue + pickko_study_room`이다.
  - `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365` 재실행 기준 `training_feature_daily` 365행 동기화가 정상 완료됐다. 샘플 검증(`2026-03-17 ~ 2026-03-23`)에서 `study_room_payment_count`, `study_room_payment_revenue_raw`, `study_room_payment_a1/a2/b_count`는 모두 `0`으로 들어가고, `study_room_use_count / study_room_use_policy_revenue`만 실제 use 축 값을 유지한다.
  - 예측엔진 2차에서는 보정 강도를 runtime-config로 승격했다. `forecast.py`는 이제 `calibrationMaxRatio`, `bookedHoursAdjustmentWeight`, `roomSpreadAdjustmentWeight`, `peakOverlapAdjustmentWeight`, `morning/afternoon/eveningPatternAdjustmentWeight`, `reservationTrendAdjustmentWeight`, `bookedHoursTrendAdjustmentWeight`를 모두 `bots/ska/config.json` / `runtime_config.py`에서 읽는다.
  - 현재 기본값은 underprediction 완화 목적의 보수적 상향으로 맞췄다. 핵심 변경은 `reservationAdjustmentWeight 0.42 -> 0.55`, `calibrationMaxRatio 0.12 -> 0.22`, `bookedHoursAdjustmentWeight 0.30 -> 0.40`, `reservationTrendAdjustmentWeight 0.18 -> 0.24`, `bookedHoursTrendAdjustmentWeight 0.16 -> 0.22`다.
  - `bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=daily --json` 재실행 기준 `2026-03-24` 예측은 `31,020원 -> 238,053원`으로 상향됐고, calibration note는 `weekday_bias:+34,912`, `samples:11`로 기록됐다. 다만 이 값은 아직 운영 관찰이 필요하다.
  - `node scripts/reviews/ska-sales-forecast-daily-review.js --json` 재확인 기준 최신 상태는 `avgMape=33.44`, `avgBias=-75,194`, `hitRate20=41.7%`이며, shadow `knn-shadow-v1`은 `availableDays=3`, `avgMapeGap=-7.32`로 우위지만 아직 canary guard를 넘지 못한 상태다.
  - shadow 3차에서는 canary 편입 경로를 추가했다. `forecast.py`는 이제 shadow actual 비교일수 / MAPE gap / shadow confidence가 모두 기준을 넘을 때만 낮은 비중으로 blend를 적용한다.
  - 현재 기본 canary 가드는 `shadowBlendEnabled=true`, `shadowBlendWeight=0.25`, `shadowBlendMinConfidence=0.35`, `shadowBlendMinCompareDays=5`, `shadowBlendRequiredMapeGap=5.0`이다.
  - 현재 실측 기준 `2026-03-24` 예측은 shadow가 더 좋지만 `available_days=3`이라 `shadow_compare_days_insufficient`로 아직 blend가 발동하지 않는다. 운영 예측은 아직 primary-only 상태다.
  - daily/weekly review는 이제 `shadow canary` 상태를 함께 보여주며, 두 review 모두 canary guard와 같은 `requiredDays=5`, `requiredGap=5.0` 기준으로 shadow readiness를 읽는다.
  - `health-report.js`의 `daily_summary 무결성(스터디룸 축)` 경계도 보정했다. 당일 KST row는 09:00 예약현황 보고가 먼저 저장되며 `room_amounts_json`만 채워질 수 있으므로, 무결성 경고는 마감 완료된 과거 일자만 대상으로 보도록 바꿨다. 이로써 `2026-03-23 room_amounts_json 76500원 != pickko_study_room 0원` false warning이 해소됐다.
  - 스카 매출 DB 적재 마무리 작업을 진행했다. `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03`로 3월 전체 `daily_summary`를 재집계했고, stale 상태였던 `2026-03-21`, `2026-03-22` source row를 현재 정책 기준으로 복구했다.
  - 복구 후 현재 대표 row는 `2026-03-21 = pickko_study_room 156000 / general_revenue 132000 / total_amount 156000`, `2026-03-22 = pickko_study_room 136000 / general_revenue 173800 / total_amount 136000`으로 읽는다.
  - `bots/worker/lib/ska-sales-sync.js`의 `syncSkaSalesToWorker('test-company')`를 재실행해 `worker.sales` 미러도 source에 다시 맞췄다. 현재 `2026-03-21`은 `스터디룸 156000`, `2026-03-22`는 `스터디룸 136000 + 일반석 37800`으로 반영됐다.
  - `node bots/reservation/scripts/health-report.js --json` 재검증 기준 `dailySummaryIntegrityHealth.issueCount=0`으로 복구됐다. 현재 스카 health의 주요 경고는 매출 적재가 아니라 `naver-monitor 미로드 / 로그 무활동`으로 다시 좁혀졌다.
  - 픽코 모니터링 심층 코드점검에서 해제(unblock) 경계 버그 3개를 추가로 수정했다. `unblockNaverSlot()`는 이제 최종 검증이 실패하면 `false`를 반환하고, `fillAvailablePopup()`는 `설정변경` 이후 패널이 실제로 닫혔는지 확인한 뒤에만 성공 처리한다.
  - `--unblock-slot` 단독 모드는 실패 시 더 이상 `naverBlocked=false`를 써서 DB 원장을 오염시키지 않는다. 성공 시에만 `false`로 내리고, 실패 시에는 기존 차단 상태를 유지한다.
  - 취소 후 네이버 해제 성공 알림은 다시 `report` 레벨로 정렬했다. 즉 성공은 `publishKioskSuccessReport()`, 실패만 `alert`로 읽는 기존 운영 계약을 복구했다.
  - 같은 슬롯(`2026-04-20 11:00~12:30 A1`) 기준으로 block/unblock를 다시 재실행한 결과, `PATCH /schedules` `200 OK`, 패널 닫힘 확인, 최종 검증 성공까지 모두 재확인됐다.
  - 네이버 슬롯 처리 안정화 1차를 진행했다. `pickko-kiosk-monitor.js`는 이제 네이버 일간 캘린더의 가상 스크롤/transform 구조를 전제로 `row-index + room column` 방식으로 슬롯을 찾는다. 잘못된 시간축 fallback으로 저녁 슬롯을 누르던 경계를 제거했고, `Calendar__row-wrap` 스크롤을 직접 제어해 목표 시간 row를 화면으로 끌어온 뒤 처리한다.
  - `clickRoomAvailableSlot()`, `clickRoomSuspendedSlot()`, `verifyBlockInGrid()`는 같은 캘린더 parser 전제를 쓰도록 맞췄다. 그 결과 `2026-04-20 11:00~12:30 A1` 기준으로 `block/unblock` 모두 정확한 슬롯 선택과 최종 검증까지 실측 확인됐다.
  - 네이버 내부 schedule API trace 계측을 추가했다. `NAVER_TRACE_SCHEDULE_API=1` 환경에서 `/tmp/naver-schedule-trace.log`에 `api-partner.booking.naver.com/.../schedules` request/response JSONL이 남는다.
  - 실측 기준 `block`과 `unblock` 모두 같은 endpoint로 `PATCH /schedules`가 발생했고 응답 `200 OK`를 확인했다. 즉 API 경로는 사라진 것이 아니라, 이전에는 UI 슬롯 선택/검증이 그 직전 단계에서 막히고 있었던 것으로 정리됐다.
  - `block` 경로는 이미 `예약불가` 상태인 슬롯이면 추가 조작 없이 idempotent 성공 처리하고, `unblock` 경로는 `예약불가` 슬롯이 사라졌음을 최종 성공 조건으로 읽는다. 현재 테스트 기준으로 실행 레이어(UI) / 내부 API / 검증 레이어가 모두 닫혔다.
  - 현재 `kiosk-monitor`는 여전히 의도적으로 꺼둔 상태다. 이번 phase는 headed `naver-monitor` 수동 세션에서 브라우저를 보면서 디버깅한 controlled test이며, 상시 재가동은 아직 하지 않았다.
  - `pickko-kiosk-monitor.js`의 `toBlockEntries` dedupe key는 이제 `phone|date|start|end|room`을 사용한다. 같은 사람/같은 날짜/같은 시작시각이라도 종료시각이 다른 재예약을 같은 사이클에서 합쳐버리지 않도록 보강했다.
  - `manual/manual_retry` 후속 차단은 `kiosk-monitor` 자동 차단 루프에서 분리했다. 자동 모니터링은 이제 `픽코 직접 감지 신규 예약 + 미차단 재시도`만 담당하고, 수동 예약 후속은 `manual-block-followup-report.js` / `manual-block-followup-resolve.js` 수동 레일에서 관리한다.
  - `manual` 픽코 작업이 진행 중이면 `kiosk-monitor`는 이제 `isPickkoLocked()`로 선확인 후 즉시 스킵한다. 수동 락 TTL도 20분으로 늘려, 운영자가 수동 등록/수정 중일 때 자동 모니터가 중간에 끼어들지 않도록 `수동 우선` 불변식을 코드로 고정했다.
  - 같은 고객의 연속 예약/취소 충돌을 줄이기 위해 `kiosk-monitor`에 고객 단위 cooldown을 추가했다. 현재 기준 key는 `phone|date`이며, 같은 고객/같은 날짜 작업은 정렬 후 직전 작업 완료 시각 기준 `customerOperationCooldownMs`만큼 대기한 뒤 다음 작업을 수행한다.
  - 픽코 자동 취소 감지는 이제 `상태=환불`과 `상태=취소`를 각각 따로 조회한 뒤 합산/중복제거한다. 픽코 화면 상태 필터는 중복 선택이 되지 않으므로, 취소 입력은 반드시 이중 조회 구조여야 한다.
  - 픽코 자동 취소 절차는 [SKA_PICKKO_CANCEL_FLOW_RUNBOOK_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_PICKKO_CANCEL_FLOW_RUNBOOK_2026-03-22.md)에 고정했다.
  - 픽코 자동 예약 감지 절차는 [SKA_PICKKO_RESERVATION_FLOW_RUNBOOK_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_PICKKO_RESERVATION_FLOW_RUNBOOK_2026-03-22.md)에 고정했다. 현재 자동 범위는 `결제완료 예약 -> 신규/미차단 재시도 -> 네이버 차단`이며, `manual follow-up`은 포함하지 않는다.
  - `operation_queue`는 아직 구현하지 않았고, 현재는 in-memory 고객 직렬화를 먼저 적용했다. 차후 큐 도입 기준과 스키마 초안은 [SKA_OPERATION_QUEUE_DESIGN_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_OPERATION_QUEUE_DESIGN_2026-03-22.md)에 정리했다.
  - 운영 의미: 자동 write-path 범위를 줄여 false block과 중복 후속 시도를 낮추고, 사람이 개입한 예약은 운영 확인을 거친 뒤 별도 원장으로 닫는 구조로 정리됐다.

- 공통 운영 리포트
  - `daily-ops-report.js`는 이제 `runtimeRestrictions` 섹션으로 `db_sandbox_restricted` 팀을 별도 분리해, 런타임 제약과 실제 장애를 같은 축으로 읽지 않도록 보강됐다.
  - 같은 리포트는 selector 보조 입력을 읽어 현재 primary(`google-gemini-cli/gemini-2.5-flash`)가 `rate_limited`이고 `gemini-2.5-flash-lite`가 `temporary_fallback_candidate`임을 active issue로 직접 노출한다.
  - gateway 쪽은 24시간 누적 경고를 그대로 유지하되, `post-restart` 창이 깨끗한 경우 recommendation에서 과거 잔상과 현재 상태를 분리해 해석하도록 안내한다.
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
  - Phase 2 전환: `syncVideoAudio()` 폐기 → AI 싱크 매칭 파이프라인으로 전환 (2026-03-21)
  - 신규 모듈: `scene-indexer.js`, `narration-analyzer.js`, `sync-matcher.js`, `intro-outro-handler.js`
  - 워커 웹 UX는 `업로드 → 인트로 → 아웃트로 → 의도 → 시작`의 5단계로 확장됐고, file_type도 `video/audio/intro/outro/logo`를 지원한다.
  - 비디오팀 Phase 2는 `6732396 feat(video): add ai sync matching pipeline`까지 `main` 반영이 끝나 있어, 다음 세션에서는 scene-index 정밀 검증이나 preview 품질 보강부터 바로 이어서 진행하면 된다.
  - 2026-03-22 검증 기준선은 `scene_count=42`, `segment_count=5`, `sync_confidence=0.6`, `keyword=5`, `unmatched=0`까지 올라왔다. 오프라인 `narration-analyzer` fallback 세그먼트 granularity 보강이 효과를 냈고, 이제 `video_edits.preview_ms` 원장화까지 반영됐다. 다음 1순위는 preview/final render 품질 검증이다.
  - preview/final render 검증 1차에서 `test-full-sync-pipeline --render-preview`의 실제 병목이 `intro 2560x1440`와 `main 1920x1080` concat 해상도 불일치, 그리고 V2 sync clip에서 narration 오디오를 speed에 맞춰 잘못 늘리던 경계라는 점을 확인했다.
  - `edl-builder.js`는 이제 V2 concat 전에 모든 clip 비디오를 공통 캔버스로 정규화하고, narration 오디오는 clip speed와 무관하게 timeline 길이에 맞춰 유지한다. speed floor 때문에 영상 길이가 narration보다 짧아질 때는 마지막 프레임 hold(`tpad=stop_mode=clone`)로 길이를 맞춘다.
  - 재검증 결과 `preview-fixed.mp4`는 `1280x720 / 60fps / 264s`, `AAC 48kHz stereo / 264s`, 파일 크기 `6.96MB`, preview wall-clock `103527ms`로 A/V 길이 정합성이 복구됐다.
  - `reference-quality.js`, `test-reference-quality.js`가 추가돼 자동 결과와 `samples/edited` 실제 편집본을 구조/시각 유사도 기준으로 비교할 수 있다. 현재 파라미터 baseline은 `overall=70.43`, `duration=64.26`, `resolution=25.18`, `visual_similarity=79.61`이다.
  - 5세트 batch baseline은 `averageOverall=68.88`, `averageDuration=54.30`, `averageResolution=25.11`, `averageVisualSimilarity=83.76`로 나왔다. 세트별 overall은 파라미터 `72.77`, 동적데이터 `73.15`, 컴포넌트스테이트 `69.88`, DB생성 `64.77`, 서버인증 `63.85`다.
  - 단일 세트 final render 검증도 성공했다. 파라미터 세트 `final.mp4`는 `2560x1440 / 60fps / 264s`, `AAC 48kHz stereo / 264s`, `faststart=true`, `file_size=46,555,622`, `duration_ms=249452`로 확인됐다.
  - final reference quality는 `overall=81.62`, `duration=64.26`, `resolution=99.30`, `visual_similarity=79.82`다. preview 대비 해상도 점수는 회복됐고, 현재 남은 핵심 차이는 사람 편집본 대비 `길이/구조`다.
  - `test-final-reference-quality-batch.js`가 추가돼 temp 산출물 없이도 샘플 5세트를 직접 순회하는 final batch 검증 레일이 생겼고, 이번 세션에서 5세트 전체 final baseline까지 완료했다.
  - `edl-builder.js`에는 `computeFinalWatchdogOptions()`가 추가돼 긴 세트가 고정 2분 stall timeout으로 잘리는 false failure를 줄였다. `서버인증` 세트는 이 보강 후 단일/배치 둘 다 final render를 끝까지 통과했다.
  - final 5세트 baseline:
    - `averageOverall=79.00`
    - `averageDuration=54.67`
    - `averageResolution=99.58`
    - `averageVisualSimilarity=80.41`
  - 세트별 overall:
    - 파라미터 `81.62`
    - 컴포넌트스테이트 `80.16`
    - 동적데이터 `85.12`
    - 서버인증 `72.96`
    - DB생성 `75.12`
  - 현재 남은 핵심 차이는 해상도보다 사람 편집본 대비 `길이/구조`이며, 다음 1순위는 낮은 점수 세트의 duration/structure 튜닝이다.
  - `analyze-final-structure-gap.js`를 추가해 `final.mp4 + edit_decision_list.json + reference` 기준으로 구조 병목을 재현 가능하게 분석할 수 있게 했다.
    - `서버인증`: `duration_ratio=0.4126`, `speed_floor_ratio=0.8`, `hold=1`, `10초 window(900~910s)` 4회 재사용
    - `DB생성`: `duration_ratio=0.3803`, `speed_floor_ratio=0.8`, `hold=0`, `30초 window(1370~1400s)` 2회 재사용
  - 해석: 다음 1순위는 transition 재도입보다 먼저 `fallback narration 세분화`, `speed floor 의존 완화`, `짧은 source window 반복 제한`이다.
  - duration/structure 튜닝 1차를 적용했다.
    - offline narration fallback을 길이 비례형 `4/5/6/7` segment로 확장
    - `서버인증`, `DB생성`은 sample-aware fallback 키워드로 보강
    - `sync-matcher`에 짧은 source window 반복 감점을 추가
  - sync-level 재검증:
    - `서버인증`: `segments=7`, `keyword=7`, `hold=0`, `unmatched=0`
    - `DB생성`: `segments=6`, `keyword=4`, `hold=2`, `unmatched=0`
  - duration/structure 튜닝 2차로 pacing policy를 추가했다.
    - `syncMapToEDL()`는 이제 `hold / low confidence / speed floor` 구간에 추가 체류 시간을 반영한다.
    - `edl-builder.js`는 main clip 오디오에 `apad`를 추가해 timeline 확장 시 무음 패딩으로 final render를 유지한다.
    - `서버인증` EDL 재계산: `duration=1008.129`, `pacing_extra_total=162.129`
    - `DB생성` EDL 재계산: `duration=629.8`, `pacing_extra_total=125.8`
  - final 재렌더 재측정:
    - `서버인증`: `overall=75.61`, `duration=49.13`, `visual_similarity=75.30`, `duration_ratio=0.4913`
    - `DB생성`: `overall=78.77`, `duration=47.47`, `visual_similarity=85.75`, `duration_ratio=0.4747`
  - 해석: pacing policy는 두 저점 세트 모두에서 실제 점수 개선으로 이어졌다. 다음 1순위는 `hold 완화`와 `반복 source window` 감소다.
- 스카
  - `pickko-alerts-query.js`를 최신 `pgPool` 기반 reservation DB에 맞게 복구했다. 기존 SQLite `getDb()` 경로는 더 이상 유효하지 않았다.
  - 복구 후 실제 DB 조회 기준 `--type=error --unresolved`는 `0건`, `--phone=01089430972 --hours=48`도 `0건`으로 확인됐다.
  - 즉 `010-8943-0972` 관련 실패/포기 알림은 현재 미해결 장애가 아니라 과거 실패 알림 잔상으로 해석하는 것이 맞다.
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
  - `pickko-kiosk-monitor.js`는 이제 성공한 네이버 차단/해제 완료를 `event_type=report`, `alert_level=1`로 발송한다. 이전처럼 성공 메시지가 `⚠️ jimmy 집약 알림`으로 묶이지 않도록 경계를 복구했다.
  - 같은 날짜 저녁 `kiosk-monitor` 반복 성공 알림의 직접 원인은 `blockNaverSlot()` 반환 객체 `{ ok, reason }`를 상위 루프가 truthy 객체 자체로 성공 판정하던 버그였다. 현재는 `blockResult?.ok`만 성공으로 해석하도록 hotfix가 반영됐고, `kiosk-monitor`는 다시 꺼둔 상태다.
  - 운영자 실사 결과 manual follow-up 12건 중 정상 차단은 6건, 원장 오류는 6건으로 정리됐다. 취소/예약없음 3건은 `operator_invalidated`로 정정했고, 시간 불일치 3건(`2026-04-01~03 A1 08:00~10:50`)은 기존 row를 invalidated 처리한 뒤 실제 차단 슬롯 `09:00~11:20` row를 새로 기록했다.
  - `manual-block-followup-report.js`는 이제 exact `getKioskBlock(phone,date,start)` lookup과 `operator_confirmed_actual_slot` corrected row를 함께 보여준다. 현재 출력 기준선은 `count=12`, `openCount=6`, `correctedCount=3`이다.
  - 구조 리스크 후속 조치: `kiosk_blocks` 식별키는 `phone|date|start|end|room` 기반 v2로 승격했고, 마이그레이션 `v007 kiosk_block_key_v2`를 적용했다. 이제 같은 사람/같은 날짜/같은 시작시각 재예약(`09:00~13:00` 취소 후 `09:00~11:00` 재예약)은 키 수준에서 분리된다. 다만 일부 조회/리포트는 여전히 `date/start` 관성에 의존할 수 있어 다음 단계는 재예약 충돌 회귀 테스트와 남은 join 정리다.
  - 최근 운영에서는 픽코/네이버 관리자 화면을 사람이 직접 쓰는 동안 자동화가 같은 세션을 건드리며 `detached Frame`, `Session closed`, `ECONNREFUSED`가 발생한 정황이 확인됐다. 운영 규칙은 [SKA_MANUAL_ADMIN_CONCURRENCY_RULE_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_MANUAL_ADMIN_CONCURRENCY_RULE_2026-03-22.md)를 따른다.
  - 현재는 `naver-monitor`만 안정화해 유지하고 `kiosk-monitor`는 의도적으로 미로드 상태다. 재개 전 확인과 재투입 순서는 [SKA_KIOSK_MONITOR_REENABLE_CHECKLIST_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_KIOSK_MONITOR_REENABLE_CHECKLIST_2026-03-22.md)를 기준으로 본다.
  - 기존 예측 엔진은 유지되고 있다.
  - `knn-shadow-v1` shadow 비교 모델이 `forecast_results.predictions`에 저장되기 시작했다.
  - 일일/주간 예측 리뷰와 자동화는 shadow 비교를 읽도록 확장됐다.
  - `naver-monitor` 취소 감지 루프에서 `pendingCancelMap` shape 충돌로 `bookingId` 예외가 반복되던 버그를 수정했다.
  - `today cancelledCount`가 증가했는데 실제 신규 취소 처리 0건이면 `cancel counter drift` 경고를 즉시 alert로 올리도록 보강했다.
  - `reservation health-report`는 이제 `cancelCounterDriftHealth`와 샘플 메시지를 함께 보여준다.
  - `duplicate slot audit`가 reservation health-report에 추가돼, 같은 슬롯 duplicate를 `risky(활성 중복)`와 `historical(과거 취소/재예약 이력)`로 분리해서 보여준다.
  - `bots/reservation/scripts/audit-duplicate-slots.js --json`가 추가돼 duplicate group의 실제 row id / status / 권장 조치를 health summary보다 자세히 볼 수 있다.
  - `naver-monitor`와 `kiosk-monitor`는 다시 launchd 백그라운드 운영 모드로 복귀했다. `health-report --json` 기준 현재 `commander / naver-monitor / kiosk-monitor / health-check` 모두 정상이며, `naver-monitor 로그: 최근 0분 이내 활동`까지 확인된다.
  - `naver-monitor` 취소 감지 2/2E에는 새로운 가드가 추가됐다. 이제 취소 탭에서 읽은 항목이라도 DB에 이미 추적 중인 예약(`bookingId / compositeKey / phone+date+start+room`)일 때만 자동 픽코 취소 대상으로 넘긴다.
  - 이 변경은 조민정 케이스처럼 `같은 고객 / 같은 날짜 / 같은 룸`에서 과거 취소건과 현재 재예약건이 함께 존재할 때, 모니터가 “오늘 처음 본 historical cancel”을 바로 자동 취소로 오인하던 경계를 복구한 것이다.
  - 대표 사례: `2026-04-04 A1`에서 과거 취소건 `16:30~18:30`과 현재 확정건 `15:30~18:30`이 함께 보이는 상황에서, 기존 로직은 취소 탭의 `16:30` 건을 즉시 픽코 취소 대상으로 넘겨 `[4단계] 취소 대상 예약 미발견`을 냈다. 현재는 DB 추적이 없는 과거 취소건이면 `미추적 과거 취소건 스킵` 로그를 남기고 자동 취소를 건너뛴다.
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
  - `jay-llm-daily-review.js`는 이제 `freshness.level / freshness.trust / freshness.summary`를 함께 노출한다. `snapshot_fallback`일 때는 단순 partial 대신 `운영 신뢰도: medium/low`, `stale snapshot fallback`를 직접 보여줘 live DB 리뷰와 fallback 리뷰를 더 명확히 구분한다.
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
  - 2026-03-23 운영 조정으로 `~/.openclaw/openclaw.json`의 `agents.defaults.heartbeat.every`를 `30m -> 60m`으로 완화했고, `ai.openclaw.gateway`를 launchd 운영모드에서 재기동했다. 현재 live health는 `hold / recommended=false`, `gateway PID=34576`으로 정상이다.
  - 이번 조정의 목적은 모델 교체가 아니라 `30분 cadence heartbeat -> embedded run -> 동일 runId 4회 retry burst` 패턴 완화다. 현재 `maxConcurrent=1`, `subagents.maxConcurrent=2`, ready fallback만 남아 있어 1차 병목은 concurrency나 fallback보다 heartbeat pacing으로 본다.
  - 다음 자동화 리포트 체크리스트:
    - `jay-gateway-experiment-review.js`: `activeRateLimitCount`, `embeddedRetryBurstCount`, `postRestartRateLimitCount`, `postRestartRetryBurstCount` 감소 여부 확인
    - `daily-ops-report.js`: gateway 권고가 여전히 `compare`인지, live 장애가 아니라 historical pressure인지 확인
    - `gateway.log` / `gateway.err.log`: `google tool schema snapshot` cadence가 실제 `60분`으로 늘었는지, 같은 `runId` 4회 재시도 묶음이 줄었는지 확인
  - 다음 판정 기준:
    - `hold 유지`: live 정상, `activeRateLimitCount=0`, retry burst 감소
    - `compare 유지`: live 정상이나 누적 pressure 지속
    - `2차 조정`: active rate limit 재발 또는 burst 유지 시 내부 retry spacing/count 추가 점검
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
- 이번 세션에서는 `제이/OpenClaw gateway fallback hygiene + concurrency 보수화`가 핵심 운영 안정화 축이었다.
- 전사 `daily ops report`는 이번 세션에서 `runtime restriction / historical gateway noise / selector primary policy signal`을 분리해서 읽는 구조로 보강됐다.

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
5. 제이/OpenClaw gateway post-prune 관찰
   - 라이브 `openclaw.json`은 fallback `11 -> 4`로 정리됐고, 현재 fallback은 `openai/gpt-4o-mini`, `openai/gpt-4o`, `openai/o4-mini`, `openai/o3-mini`만 남아 있다.
   - concurrency는 `maxConcurrent=1`, `subagents.maxConcurrent=2`로 보수화됐다.
   - 최신 실험 스냅샷에서 남은 진짜 병목은 `Gemini rate limit` 이후 동일 run 재시도 burst이며, `embedded unique runs=14`, `retry burst runs=13`, `max attempts per run=4`로 관찰됐다.
   - 다음은 post-prune/post-tune 24시간 창에서 `provider auth missing`, `retry burst`, `active rate limit`이 실제로 감소하는지 확인하는 단계다.
   - 전사 `daily-ops-report.js`도 이제 selector primary 건강도(`rate_limited`)와 same-provider fallback 후보(`gemini-2.5-flash-lite`)를 함께 노출하므로, gateway와 selector 운영 판단을 같은 리포트에서 읽을 수 있다.
6. 남은 자동화 확정
  - 스카 shadow 일일/주간
  - 워커 문서 효율 일일/주간
  - 투자 설정 제안 일일/주간
7. 자동화 리포트 운영 데이터 관찰
8. 비디오 품질 루프 확장
  - 과제 10 Critic, 과제 11 Refiner, 과제 12 Evaluator/quality-loop, 과제 13 5세트 preview 검증까지 완료
  - 다음은 preview wall-clock을 원장에 따로 저장하는 구조 보강, 세션 1 프리뷰 재검증, transition 렌더 재설계, final render 다세트 실검증
  - 제이 Gateway `persisted` 상태
  - 제이 일일 리뷰 `dbSource=db / snapshot_fallback` 전환 패턴

---

## 4. 세션 마감 메모

- 이번 세션의 문서/코드 커밋은 `8c73f64 feat(reports): enrich daily ops interpretation`까지 `main` 반영 완료다.
- `bots/claude/.checksums.json`은 이번 턴에서 다시 갱신됐지만, 아래 unrelated 로컬 변경을 함께 반영한 상태라 별도 커밋하지 않았다.
  - `bots/orchestrator/lib/night-handler.js`
  - `bots/reservation/context/HANDOFF.md`
  - `bots/reservation/lib/study-room-pricing.js`
  - `bots/reservation/scripts/collect-pickko-order-raw.js`
- 다음 체크섬 마감은 위 변경들의 소유 세션이 정리된 뒤, 실제 커밋 대상 파일 집합 기준으로 `node bots/claude/src/dexter.js --update-checksums`를 다시 실행하는 것이 기준이다.
  - 일일 운영 분석의 `activeIssues / historicalIssues / inputFailures` 축적 패턴
  - investment / reservation `local fallback 활동 신호`가 실제 운영 상태를 안정적으로 대변하는지
  - 투자 `no-trade high-cost` 경고 발생 여부
  - 스카 `actionItems`가 실제 튜닝 판단에 충분한지 확인
9. 제이 DB 접근 컨텍스트 복구
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

## 2026-03-22 — 스카 자동 모니터링 로직 정렬 / kiosk-monitor 재가동

- 사용자 운영 로직에 맞춰 자동 4경로를 다시 정렬했다.
  - 네이버 예약 감지 -> 픽코 등록
  - 네이버 취소 감지 -> 픽코 취소
  - 픽코 예약 감지 -> 네이버 예약불가
  - 픽코 취소 감지 -> 네이버 예약가능
- 이에 따라 `bots/reservation/auto/monitors/naver-monitor.js`에서 네이버 신규 예약 후 픽코 등록을 막던 `OBSERVE_ONLY`, `PICKKO_ENABLE`, `SAFE_DEV_FALLBACK` 가드를 제거했다.
- 같은 파일의 자동 취소 경로에서는 `pickko-kiosk-monitor.js --unblock-slot` 후속 호출을 제거했다. 네이버 취소 시 슬롯은 이미 예약가능 상태로 복구된다는 운영 전제를 기준으로, 취소 후속은 `픽코 취소`까지만 수행한다.
- 수동 취소 write-path도 같은 기준으로 정리했다.
  - `bots/reservation/manual/reservation/pickko-cancel-cmd.js`는 이제 `pickko-cancel.js`만 실행하고 성공 시 바로 `success: true`를 반환한다.
  - `bots/reservation/lib/manual-cancellation.js`와 `bots/reservation/context/N8N_COMMAND_CONTRACT.md`도 같은 계약으로 단순화했다.
- `ai.ska.kiosk-monitor`는 다시 launchd에 등록하고 `kickstart`까지 완료했다.
  - `launchctl print gui/$(id -u)/ai.ska.kiosk-monitor` 기준 `pid=49161`, `state=xpcproxy`
  - `node bots/reservation/scripts/health-report.js --json` 기준 `kiosk-monitor: 정상 (PID 49161)`
  - `/tmp/pickko-kiosk-monitor.log` 기준 실제 `pickko-kiosk-monitor.js` 프로세스(`PID 49169`)가 기동되어 네이버 캘린더 차단 시도까지 진행했다.
- 현재 남은 핵심은 실전 관찰이다.
  1. 네이버 신규 예약 1건에서 픽코 자동 등록이 기대대로 수행되는지 확인
  2. 네이버 취소 1건에서 추가 `unblock-slot` 없이 픽코 취소만 수행되는지 확인
  3. 픽코 예약/취소 감지 1건씩에서 네이버 차단/해제가 정상 동작하는지 확인
- 후속 코드 점검에서 추가로 확인된 점:
  - 네이버 신규 예약 경로의 3가지 가드는 제거됐지만, 취소 감지 1/2/2E/4 경로에는 `OBSERVE_ONLY` 화이트리스트 필터가 남아 있었다.
  - 이는 사용자 정의 4경로와 어긋나는 경계라서 같은 날짜 후속 패치에서 제거했다.
  - 최신 기준으로 `naver-monitor.js`에는 OPS 자동 경로에서 `OBSERVE_ONLY`, `PICKKO_ENABLE`, `SAFE_DEV_FALLBACK`가 더 이상 남아 있지 않다.

## 2026-03-22 — 스카 수동등록 후속 차단 / 취소 완결성 보강

- 수동등록 후 네이버 예약불가 후속 차단의 silent failure를 더 이상 방치하지 않도록 `kiosk_blocks` 원장에 `last_block_attempt_at`, `last_block_result`, `last_block_reason`, `block_retry_count`를 남기는 구조를 붙였고, `manual-block-followup-report.js`, `manual-block-followup-resolve.js`로 운영 점검/수동 확인 반영 루프를 만들었다.
- 최근 미래 `manual/manual_retry` 예약 중 네이버 차단 미완료 후보 8건을 실제 네이버 예약관리에서 확인 후 처리했고, `manual-block-followup-resolve.js`로 `manually_confirmed / operator_confirmed_naver_blocked` 상태를 원장에 반영해 `openCount=0` 기준점을 확보했다.
- `pickko-kiosk-monitor.js`는 이제 `manual follow-up open` 건도 정기 재시도 레일에 포함하며, B룸 오전 슬롯의 잘못된 시간대/잘못된 셀을 건드리는 문제를 줄이기 위해 visible time axis 기준 Y축 보정, available-only 필터, slot guard, trailing half-hour verify 보강을 적용했다.
- 이재룡 `010-3500-0586 / 2026-11-28 11:00~12:30 B` 테스트 예약은 block 경로 기준 `already_blocked`로 수렴했고, `manual-block-followup` 원장 기준 `naver_blocked=1`, `last_block_result=blocked`, `last_block_reason=already_blocked` 상태로 정리됐다.
- 위 취소 완결성 보강 메모는 같은 날짜 후속 세션에서 조정됐다.
  - 최신 기준은 `취소 감지 -> 픽코 취소`까지만 수행한다.
  - 네이버 슬롯은 네이버 취소 시 자동 복구된다는 운영 전제를 사용하며, 추가 `unblock-slot` 후속은 더 이상 수행하지 않는다.
- 이번 세션에서는 문서에만 있던 취소 write-path를 실제 command contract에 복구했다.
  - `cancel_reservation`이 `ska-command-handlers.js`, `dashboard-server.js`, `orchestrator/router.js`, `intent-parser.js`, `COMMANDER_IDENTITY.md`, `N8N_COMMAND_CONTRACT.md`까지 연결돼, 이제 스카 취소도 등록과 같은 수준의 정식 command로 처리된다.
- 현재 남은 핵심은 두 가지다.
  1. 네이버 신규 예약 1건에서 픽코 자동 등록이 가드 없이 실제로 수행되는지 실전 확인
  2. `naver-monitor`의 미래 취소 스캔 범위가 현재 11월 테스트 예약을 직접 커버하지 못하므로, 자동 취소 테스트는 더 가까운 날짜 예약 또는 scan window 확장 기준으로 다시 검증 필요

## 2026-03-22 — 루나 암호화폐 weak signal 계측 1차 보강

- `bots/investment/shared/pipeline-decision-runner.js`가 이제 `weakSignalSkipped`를 단순 카운트로만 남기지 않고 `weak_signal_reason_top`, `weak_signal_reasons`를 함께 저장한다.
- 현재 분류 기준은 `confidence_near_threshold`, `confidence_mid_gap`, `confidence_far_below_threshold` 3단이다. 목적은 threshold를 미세조정해야 하는 상황과 실제 신호 품질이 낮은 상황을 분리하는 것이다.
- `bots/investment/scripts/trading-journal.js`, `bots/investment/scripts/weekly-trade-review.js`, `bots/investment/scripts/runtime-config-suggestions.js`는 새 메타를 읽어 `weakTop`을 함께 표시하도록 연결했다.
- 현재 일지/주간리뷰에서 `weakTop`이 바로 안 보일 수 있는 것은 정상이다. 과거 `pipeline_runs.meta`에는 새 필드가 없고, 다음 암호화폐 파이프라인 실행부터 누적된다.
- LIVE 전환 판단은 여전히 보류다. 이번 계측은 튜닝 근거를 더 정교하게 만드는 단계이며, `PAPER -> LIVE` 승격 게이트는 [CRYPTO_TUNING_AND_LIVE_GATE_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/CRYPTO_TUNING_AND_LIVE_GATE_2026-03-22.md)를 기준으로 유지한다.

## 2026-03-22 — 루나 암호화폐 재진입 차단 코드 세분화

- `bots/investment/team/hephaestos.js`, `bots/investment/team/hanul.js`에서 기존 `position_reentry_blocked` 단일 코드를 `paper_position_reentry_blocked`, `live_position_reentry_blocked`로 분리했다.
- 목적은 같은 “추가매수 차단”이라도 검증용 PAPER 포지션 과밀인지, 실제 LIVE 포지션 보유인지 운영 리포트와 자동화 리뷰에서 분리해서 읽게 만드는 것이다.
- 이번 단계는 정책 완화가 아니라 계측/원장 정밀화 단계다. 실제 scale-in 허용이나 cooldown 완화는 새 block code 분포가 1~2일 누적된 뒤 판단한다.

## 2026-03-22 — 루나 암호화폐 LIVE 게이트 리뷰 자동화

- `bots/investment/scripts/crypto-live-gate-review.js`를 추가해 최근 N일 암호화폐 `decision / BUY / approved / executed / PAPER-LIVE 체결 / weakSignalSkipped / reentry block / 종료 리뷰 수`를 한 번에 읽고 LIVE 게이트를 자동 판정하도록 정리했다.
- 초기 구현에서 `pipeline_runs.market='crypto'`로 좁게 잡아 decision이 0으로 보이던 문제를 바로 수정했고, 현재는 `binance` market을 포함해 기존 원장 구조와 맞춘다.
- 실제 최근 3일 검증 결과는 `decision 2236 / BUY 344 / approved 247 / executed 48 / 체결 48건(PAPER 48, LIVE 0) / weak 99 / 종료 리뷰 0`이었다.
- 이 기준으로 현재 LIVE 게이트는 여전히 `blocked`다. 이유는 **신호와 PAPER 체결은 충분하지만, LIVE 체결과 종료 리뷰가 아직 없기 때문**이다.

## 2026-03-22 — 루나 운영 헬스에 암호화폐 LIVE 게이트 반영

- `bots/investment/scripts/health-report.js`는 이제 최근 3일 암호화폐 LIVE 게이트를 `cryptoLiveGateHealth` 섹션으로 함께 출력한다.
- 실제 `health-report --json` 기준 현재 값은 `warnCount=1`, `liveGate.decision=blocked`, `사유=PAPER 체결 또는 청산 검증이 아직 부족함`이다.
- 따라서 `/ops-health`나 투자 헬스 리포트만 봐도 “서비스는 정상인데, 암호화폐 LIVE 전환은 아직 막혀 있다”는 상태를 한 번에 읽을 수 있다.
- 참고로 오늘 `signalBlockHealth`에 보이는 `position_reentry_blocked`는 과거 데이터 잔상이며, 새 `paper/live` 차단 코드 분리는 이후 신규 신호부터 누적된다.

## 2026-03-22 — LLM speed test 실패 원인 분류 / 지원 모델 레지스트리 정리

- `scripts/speed-test.js`는 이제 모든 모델 측정 실패를 더 이상 정상 종료로 숨기지 않는다. 전 모델 실패는 `exit 2`, snapshot/history 저장 실패는 `exit 3`으로 종료해 selector automation이 false success를 기록하지 않도록 보강했다.
- 최신 snapshot에는 각 실패 모델의 `errorClass`를 함께 저장한다. 현재 분류는 `rate_limited`, `network_unavailable`, `gemini_thinking_budget_unsupported`, `unsupported_or_no_access`, `auth_or_access_failed`, `request_failed` 등을 포함한다.
- Gemini 경로는 `thinkingBudget=0` 고정으로 깨지던 문제를 수정했다. `gemini-2.5-pro`는 `thinkingBudget=-1`, `gemini-2.5-flash / flash-lite`는 `thinkingBudget=0`으로 보내도록 분기해 `gemini-2.5-pro` 속도 측정이 다시 정상화됐다.
- `scripts/reviews/llm-selector-speed-review.js`는 최신 실패 모델과 `errorClass`를 함께 보여주도록 보강됐다. 현재 최신 기준 실패는 `google-gemini-cli/gemini-2.5-flash | rate_limited` 1건만 남아 있다.
- 운영 모델 레지스트리 `~/.openclaw/openclaw.json`도 정리했다.
  - 추가: `google-gemini-cli/gemini-2.5-flash-lite`
  - 교체: `groq/moonshotai/kimi-k2-instruct` → `groq/moonshotai/kimi-k2-instruct-0905`
  - 제거: `cerebras/gpt-oss-120b` (실측 `HTTP 404: Model ... does not exist or you do not have access`)
- 현재 속도 해석은 다음과 같다.
  - 최신 recommended: `groq/openai/gpt-oss-20b`
  - Gemini primary `gemini-2.5-flash`는 현재 속도 최적화 이슈가 아니라 `429 capacity exhausted` 상태
  - 따라서 immediate switch가 아니라 `compare` 유지가 맞고, primary health와 selector recommendation을 분리해서 읽어야 한다
- `scripts/reviews/llm-selector-speed-review.js`는 이제 `primaryHealth`, `latestPrimaryResult`를 함께 보여준다. 즉 현재는 `recommended=compare`이면서 동시에 `current primary=rate_limited`라는 운영 상태를 한 리포트에서 분리해 읽을 수 있다.
- 추가로 현재 primary가 unhealthy일 때 같은 provider 안에서 즉시 쓸 수 있는 `primaryFallbackCandidate`도 함께 보여준다. 최신 기준 Gemini 레일의 안전 후보는 `google-gemini-cli/gemini-2.5-flash-lite`다.
- 후속으로 최근 snapshot 이력을 읽어 `primaryFallbackPolicy`도 계산한다. 현재 기준 `gemini-2.5-flash`는 최근 2회 이상 연속 `rate_limited`로 관측되어 `temporary_fallback_candidate` 상태다. 다만 이는 운영 신호이며 자동 전환을 뜻하지는 않는다.
- 임시 전환 기준은 [GEMINI_FLASH_TEMPORARY_FALLBACK_POLICY_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/GEMINI_FLASH_TEMPORARY_FALLBACK_POLICY_2026-03-22.md)에 따로 정리했다. 현재 자연스러운 다음 단계는 quota reset 이후 `gemini-2.5-flash` 재측정이며, 동일 상태가 이어질 때만 `flash-lite` 임시 primary를 검토한다.

## 2026-03-22 — 스카 픽코 등록 실패 단계 분해 계측

- `pickko-accurate.js`는 이제 실패 시 단순 에러 문자열만 남기지 않고 `PICKKO_FAILURE_STAGE=...` 마커를 함께 출력한다.
- 현재 표준화한 실패 단계는 `INPUT_NORMALIZE_FAILED`, `LOCK_CONFLICT`, `MEMBER_SELECT_FAILED`, `MEMBER_REGISTER_OR_SEARCH_FAILED`, `DATE_SELECT_FAILED`, `ROOM_MAPPING_FAILED`, `TIME_SLOT_SELECT_FAILED`, `SAVE_*`, `PAYMENT_*`, `TIME_ELAPSED`, `ALREADY_REGISTERED` 등이다.
- `naver-monitor.js`의 `runPickko()`는 child stdout/stderr에서 위 마커를 파싱해 `errorReason` 앞에 `[STAGE_CODE]`를 붙여 저장하고, 수동 처리 알림에도 `🧩 실패 단계:`를 함께 노출한다.
- 의미: 이제 “재시도는 계속 했는데 왜 한 번도 성공 못 했는가”를 감으로 보지 않고, `member/date/slot/lock/payment` 경계별로 바로 읽을 수 있다.
- 이번 단계는 DB 스키마 변경 없이 `errorReason`/알림 계약만 강화한 1차 계측이다. 다음 자연스러운 단계는 실패 단계 분포를 1~2일 관찰한 뒤 `slot 선택` 또는 `lock 충돌`에 맞는 재시도 정책을 분리하는 것이다.
- 네이버 취소 자동화의 실제 분기 절차는 [SKA_NAVER_CANCEL_FLOW_RUNBOOK_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_NAVER_CANCEL_FLOW_RUNBOOK_2026-03-22.md)에 별도 고정했다. 다음 세션에서 취소 live 점검 시 이 문서를 source of truth로 사용한다.

## 2026-03-22 — 스카 manual block follow-up 원장 정정 / corrected slot 리포트 보강

- `kiosk-monitor` 반복 성공 알림 hotfix 후 운영자 실사 결과를 기준으로 `kiosk_blocks` 12건을 재검증했다.
- 취소/예약없음/테스트 취소 3건과 시간 불일치 3건의 기존 row는 `operator_invalidated`로 정정했다.
- `2026-04-01~03 A1 / 01037410771`는 실제 차단된 `09:00~11:20` 슬롯 row를 `operator_confirmed_actual_slot`로 새로 기록했다.
- `manual-block-followup-report.js`는 단순 `reservations LEFT JOIN kiosk_blocks` 대신 exact `getKioskBlock(phone,date,start)` lookup을 사용하고, corrected slot row를 `correctedRows`로 함께 출력한다.
- 현재 기준선:
  - `count=12`
  - `openCount=6`
  - `correctedCount=3`
- 남은 구조 리스크:
  - 다음 단계는 `v2 키` 기준 회귀 테스트와 남은 query/join이 `end/room`까지 일관되게 반영되는지 점검하는 것이다.

## 2026-03-22 — 스카 kiosk_blocks 키 v2 재설계 / 재예약 충돌 완화

- `kiosk_blocks` 식별키를 `phone|date|start`에서 `phone|date|start|end|room` 기반 v2로 승격했다.
- `bots/reservation/lib/crypto.js`는 `hashKioskKeyLegacy()`와 v2 `hashKioskKey()`를 함께 지원하고, `db.js`는 조회 시 v2 우선 + legacy fallback으로 읽는다.
- `bots/reservation/migrations/007_kiosk_block_key_v2.js`를 추가해 기존 `kiosk_blocks` row를 v2 id로 재키잉했다. 현재 스키마는 `v7`이다.
- `pickko-kiosk-monitor.js`, `manual-block-followup-report.js`, `getOpenManualBlockFollowups()`는 `end/room`까지 반영해 같은 사람/같은 날짜/같은 시작시각 재예약에서도 다른 row로 다루도록 보강했다.
- 검증상 `09:00~13:00`와 `09:00~11:00`는 v2 해시가 서로 다르며, legacy 단일 키와 달리 충돌하지 않는다.
- 추가로 `test-kiosk-block-key-v2.js`를 통해 실제 `reservation.kiosk_blocks` 트랜잭션 안에서 `09:00~13:00`와 `09:00~11:00` 두 row를 삽입/조회 후 rollback하는 비파괴 검증을 수행했고, `rowCount=2`, `v2Keys.distinct=true`를 확인했다.
- 후속 운영 검증 절차는 [SKA_REBOOK_REGRESSION_TEST_2026-03-22.md](/Users/alexlee/projects/ai-agent-system/docs/SKA_REBOOK_REGRESSION_TEST_2026-03-22.md)를 기준으로 본다.
