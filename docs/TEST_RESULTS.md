# 테스트 결과 이력

> Day별 테스트 통과/실패 누적 기록

## 2026-03-26

### crypto soft budget runtime suggestion 보강

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/scripts/runtime-config-suggestions.js` | ✅ today soft-cap block snapshot / reserve slot suggestion 로직 추가 후 문법 통과 |
| `node bots/investment/scripts/runtime-config-suggestions.js --json` | ✅ `validationBudgetSnapshots.cryptoValidation`에 `normalCount`, `softCapBlocks`, `capitalGuardBlocks`가 포함되고 현재 `3/8`, `normal 0`, `soft-cap blocks 0` 확인 |
| `node bots/investment/scripts/runtime-config-suggestions.js` | ✅ text report에 `normal`, `soft-cap blocks`가 함께 출력되는 것 확인 |

### crypto validation reentry preflight

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/team/nemesis.js` | ✅ `validation_live_position_reentry_preflight` 분기 추가 후 문법 통과 |
| `node --input-type=module ... SELECT ... FROM signals WHERE exchange='binance' AND block_code='live_position_reentry_blocked' ...` | ✅ 최근 차단 심볼이 `RENDER/USDT`, 과거 누적은 `ROBO/USDT`임을 확인 |
| `node --input-type=module ... SELECT ... FROM positions WHERE exchange='binance' ...` | ✅ `RENDER/USDT` live 포지션이 실제로 열려 있어 validation BUY 재진입 차단이 정상 정책임을 확인 |

### 해외장 mock SELL capability 실검증 후 blocked 정책 복구

| 테스트 | 결과 |
|--------|------|
| `env PAPER_MODE=false node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --execute --confirm=force-exit` | ✅ 실검증 기준 `KIS API 오류 [90000000]: 모의투자에서는 해당업무가 제공되지 않습니다.` 확인 |
| `node --check bots/investment/team/hanul.js` | ✅ `mock_operation_unsupported` 분류 추가 후 문법 통과 |
| `node --check bots/investment/scripts/force-exit-candidate-report.js` | ✅ 해외장 readiness를 `blocked_by_capability`로 되돌린 뒤 문법 통과 |
| `node --check bots/investment/scripts/force-exit-runner.js` | ✅ 해외장 preflight blocked 복구 후 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ 해외장 capability 문구 수정 후 문법 통과 |
| `node --check bots/investment/scripts/backfill-signal-block-reasons.js` | ✅ 해외장 `90000000` 재분류 추가 후 문법 통과 |
| `node bots/investment/scripts/force-exit-candidate-report.js --json` | ✅ `blockedByCapability=4`, 해외장 4건 모두 `mock SELL 미지원 (KIS 90000000)` 확인 |
| `node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --json` | ✅ preview가 `preflight.ok=false`, `level=blocked`로 변경된 것 확인 |
| `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=7` | ✅ `ORCL` 2건을 `mock_operation_unsupported`, `375500` 1건을 `market_closed`로 재분류 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `recentSignalBlockHealth.top[0].code = mock_operation_unsupported`, 해외장 capability `mock SELL 미지원 (KIS 90000000)` 확인 |

### 투자팀 국내장 collect pressure 최신 cycle 정렬

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/scripts/health-report.js` | ✅ 최신 domestic cycle window 집계 로직 추가 후 문법 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `domesticCollectPressure.windowLines=4`, `latestMetrics.symbols=11`, `latestMetrics.tasks=34`, `dataSparsity=2` 확인 |
| `node bots/investment/scripts/health-report.js` | ✅ text report가 `최신 cycle / 로그 4줄` 기준으로 domestic collect pressure를 출력함 확인 |

### 투자팀 국내장 dynamic universe 2차 축소

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/secrets.js` | ✅ 국내장 dynamic cap fallback `8` 반영 후 문법 통과 |
| `node --input-type=module -e "import { getDomesticScreeningMaxDynamic } from './bots/investment/shared/secrets.js'; console.log(getDomesticScreeningMaxDynamic());"` | ✅ 현재 기준 `8` 출력 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ health JSON 정상 출력, 기존 `domesticCollectPressure` / `cryptoLiveGateHealth` / `mockUntradableSymbolHealth` 섹션 유지 확인 |

### worker-web `/video`, `/video/editor` 단계형 편집 워크스페이스 1차

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/cut-proposal-engine.js` | ✅ 컷 제안 엔진 문법 통과 |
| `node --check bots/video/lib/media-binary-env.js` | ✅ media binary PATH 보강 모듈 문법 통과 |
| `node --check bots/video/scripts/render-from-edl.js` | ✅ finalize/render 경계 수정 후 문법 통과 |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ editor-ready / media env 반영 후 문법 통과 |
| `node --check bots/video/scripts/test-phase3-batch.js` | ✅ batch 종료/단계 로그 보강 후 문법 통과 |
| `node --check bots/worker/web/app/_shell.js` | ✅ 비디오 작업화면 provisional render 경계 문법 통과 |
| `node --check bots/worker/web/app/video/page.js` | ✅ `useSearchParams` 제거 후 문법 통과 |
| `node --check bots/worker/web/app/video/editor/page.js` | ✅ `useSearchParams` 제거 및 editor entry 경계 수정 후 문법 통과 |
| `node --check bots/worker/web/components/ChatCard.jsx` | ✅ intro/outro/edit intent 입력 확장/버튼 분기 후 문법 통과 |
| `node --check bots/worker/web/components/EditorChatPanel.jsx` | ✅ 컷 단계 액션 세로 배열/요약 패널 정리 후 문법 통과 |
| `node --check bots/worker/web/components/TwickEditorWrapper.js` | ✅ 상단 플레이어/하단 타임라인 분리 및 시간축 동기화 1차 후 문법 통과 |
| `node --check bots/worker/web/components/VideoChatWorkflow.jsx` | ✅ `/video` 초기 설정/수정 모드 분기 정리 후 문법 통과 |
| `node --check bots/worker/web/routes/video-api.js` | ✅ editor-ready / source-video 관련 경계 보강 후 문법 통과 |
| `node --check bots/worker/web/routes/video-step-api.js` | ✅ cut/effect review API 및 EDL/sync_map 반영 후 문법 통과 |
| `npx next build` (`bots/worker/web`) | ✅ `/video`, `/video/editor`, shell/auth/searchParams/editor layout 보강 이후 빌드 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ 편집기 반영본 재기동 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ worker-web 반영본 재기동 성공 |
| `curl -I http://127.0.0.1:4001/video` | ✅ `200` |
| `curl -I http://127.0.0.1:4001/video/editor` | ✅ `200` |

## 2026-03-24

### worker-web `/video`, `/video/editor` 실브라우저 검증

| 테스트 | 결과 |
|--------|------|
| `npx next build` (`bots/worker/web`) | ✅ `/video` phase guard, intro/outro explicit submit guard, favicon metadata 추가 후 반복 빌드 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ build 완료본 기준 재기동 성공 |
| Puppeteer/Chrome: `/video/editor` desktop | ✅ 좌측 Twick, 우측 AI 편집 채팅 패널, `twickError=false`, 콘솔/네트워크 오류 없음 |
| Puppeteer/Chrome: mobile `/dashboard` → bottom nav `영상` 클릭 | ✅ alert `PC 전용 메뉴입니다. PC에서 이용해주세요` 확인 |
| Puppeteer/Chrome: `/video` state restore | ✅ 메뉴 왕복 후 summary/편집의도 유지 확인 |
| Puppeteer/Chrome: `/video` bubble scroll | ✅ `scrollHeight > clientHeight`, `scrollTop 0 -> 120` 실제 변경 확인 |
| Puppeteer/Chrome: `/video` upload flow | ⚠️ 업로드 카드 유지와 outro 단계 표시는 확인했지만, intro 단계가 건너뛰어지는 현상이 계속 재현됨 |
| Puppeteer/Chrome: `/video` after build-before-restart | ⚠️ build 완료 전 재기동 시 chunk 404 재현. build 완료 후 재재기동으로 해소 |
| Puppeteer/Chrome: `/video` favicon/network | ✅ `public/favicon.ico` 추가 후 favicon 404 해소 |
| `node` DB 조회: `video_upload_files.original_name` 최신 12건 | ✅ 최신 한글 파일명이 `áá¯...` 패턴으로 저장되는 것을 확인 |
| `node` filename recovery sample | ✅ `latin1 -> utf8 -> NFC` 복구 시 `원본_나레이션_파라미터.m4a`, `원본_나레이션_컴포넌트스테이트.m4a`로 정상 변환 확인 |
| `npx next build` (`bots/worker/web`) after filename fix | ✅ 분해형 한글/NFC 정규화 반영 후 재빌드 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` / `ai.worker.web` | ✅ filename fix 반영본 재기동 성공 |

### 비디오팀 Phase 3 5세트 batch 검증

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/scripts/test-phase3-batch.js` | ✅ Phase 3 batch 스크립트 문법 통과 |
| `node bots/video/scripts/test-phase3-batch.js --title=파라미터 --json` | ✅ 단일 세트 sanity check 기준 `autoConfirmRate=60.0%`, `overall=76.88`, `visual_similarity=80.90` 확인 |
| `node bots/video/scripts/test-phase3-batch.js --json` | ✅ `bots/video/temp/phase3_batch_report.json` 생성, `successfulSets=2`, `skippedSets=3`, `averageAutoConfirmRate=55.0%`, `averageOverall=75.07`, `averageVisualSimilarity=78.97` 확인 |

## 2026-03-25

### 헤파이스토스 BUY 직후 TP/SL 보호주문 수량 정합성 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/team/hephaestos.js` | ✅ 보호주문 수량 reconciliation 추가 후 문법 통과 |
| `node bots/investment/manual/balance/binance-balance.js RENDER` | ✅ `RENDER free = 30.38958` 확인, 보호주문 실패가 잔고 0이 아니라 BUY 체결 수량과 실잔고 어긋남 문제였음을 재확인 |

### 투자팀 국내/해외 dynamic universe cap + data sparsity 분리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/secrets.js` | ✅ 국내장/해외장 `max_dynamic` getter 추가 후 문법 통과 |
| `node --check bots/investment/shared/universe-fallback.js` | ✅ 공용 `capDynamicUniverse()` 추가 후 문법 통과 |
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ `data_sparsity_watch` 계측 추가 후 문법 통과 |
| `node --check bots/investment/markets/domestic.js` | ✅ 국내장 dynamic cap 적용 후 문법 통과 |
| `node --check bots/investment/markets/overseas.js` | ✅ 해외장 dynamic cap 적용 후 문법 통과 |
| `node --input-type=module -e \"... getDomesticScreeningMaxDynamic/getOverseasScreeningMaxDynamic ...\"` | ✅ config 기준 `domestic=15`, `overseas=15` 확인 |
| `node --input-type=module -e \"... capDynamicUniverse(['A','B','C','D'], 2, 'test') ...\"` | ✅ `4개 -> 2개` cap 로그와 결과 배열 확인 |
| `node --input-type=module -e \"... summarizeCollectWarnings(['data_sparsity_watch'], { dataSparsityFailures: 7 }) ...\"` | ✅ `신규/희소 심볼의 이력 부족...` 경고 문구 확인 |

## 2026-03-26

### 루나 trade_review false warning 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/scripts/validate-trade-review.js` | ✅ ratio-scale 판정 로직 수정 후 문법 통과 |
| `node bots/investment/scripts/validate-trade-review.js --days=30` | ✅ `closedTrades=12`, `findings=0`, `items=[]` 확인 |
| `node --input-type=module -e \"... SELECT trade_id, symbol, entry_value, pnl_amount, pnl_percent FROM investment.trade_journal WHERE trade_id='TRD-20260319-001' ...\"` | ✅ `pnl_percent=0.2747`, `pnl_amount=0.0274725...`, `entry_value=10`으로 정상 저수익 퍼센트 저장값 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `tradeReview.findings=0`, health decision에서 `trade_review 정합성 이슈` 사라짐 확인 |

### 덱스터 investment resolved pattern 정리 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/claude/lib/checks/database.js` | ✅ `investment 미처리 신호 (2h+)` 0건일 때 `ok` 항목 추가 후 문법 통과 |
| `node --input-type=module -e \"... clearPatterns('investment 미처리 신호 (2h+)'); clearPatterns('investment trade_review 무결성') ...\"` | ✅ stale pattern 직접 정리 결과 `clearedPending=1`, `clearedTradeReview=1` |
| `node --input-type=module -e \"... SELECT check_name,label FROM dexter_error_log WHERE label LIKE ...\"` | ✅ 대상 stale pattern 조회 결과 `[]` |

## 2026-03-23

### 비디오팀 Phase 3 과제 F `step-proposal-engine`

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/step-proposal-engine.js` | ✅ 문법 통과 |
| `find bots/video/temp -maxdepth 2 -name 'sync_map.json'` | ✅ 현재 temp에 실산출 `sync_map.json` 없음 확인 |
| `node - <<'NODE' ... generateSteps(dummySyncMap, ..., { introClip, outroClip }) ... NODE` | ✅ 총 `4`스텝, `autoConfirm=3`, `manual=1`, intro/sync_match/outro 구조 확인 |
| `node - <<'NODE' ... stepsToSyncMap(generateSteps(syncMap)) ... NODE` | ✅ 원본 `matches=2`, 역변환 `matches=2`, count 일치 확인 |
| `node - <<'NODE' ... normalizeConfidence({ match_score: 'high' }) ... NODE` | ✅ 문자열 `match_score='high'`가 `0.85`로 정규화됨을 확인 |
| `node - <<'NODE' ... generateSteps({ match_score: 'high' }) ... stepsToSyncMap(...) ... NODE` | ✅ `proposal.match_score=0.85`, `proposal.match_score_raw='high'`, 역변환 `match_score=0.85`로 원본 confidence 보존 확인 |

### 비디오팀 Phase 3 과제 G `video-feedback-service`

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/video-feedback-service.js` | ✅ 문법 통과 |
| `node - <<'NODE' ... ensureVideoFeedbackTables/createVideoStepFeedbackSession/markVideoFeedbackConfirmed ... NODE` | ✅ 로컬 PostgreSQL 실검증 기준 `sessionId=1`, `feedbackStatus=confirmed`, `acceptedWithoutEdit=true` 확인 |
| `node --check bots/video/lib/step-proposal-engine.js` | ✅ Task F와 조합되는 기본 엔진 문법 유지 |
| `node - <<'NODE' ... markVideoFeedbackConfirmed({ sessionId: 999999999 }) ... NODE` | ✅ 더 이상 FK 오류가 아니라 도메인 오류 `feedback_session_id=999999999 를 찾을 수 없습니다.` 반환 |
| `node - <<'NODE' ... createVideoStepFeedbackSession() + markVideoFeedbackConfirmed() ... NODE` | ✅ guard 추가 후에도 정상 세션 `sessionId=2`, `feedbackStatus=confirmed`, `acceptedWithoutEdit=true` 유지 |

### 비디오팀 Twick CSS scoped 로딩 전환

| 테스트 | 결과 |
|--------|------|
| `node bots/worker/web/scripts/scope-twick-css.js` | ✅ `public/twick-editor-scoped.css` 생성 (`40.8KB`) |
| `node --check bots/worker/web/scripts/scope-twick-css.js` | ✅ scoped CSS 생성 스크립트 문법 통과 |
| `node --check bots/worker/web/app/video/editor/page.js` | ✅ page에서 전역 Twick CSS import 제거 후 문법 통과 |
| `node --check bots/worker/web/components/TwickEditorWrapper.js` | ✅ 동적 scoped CSS 로더 추가 후 문법 통과 |
| `npx next build` (`bots/worker/web`) | ✅ scoped CSS 생성 후 빌드 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 서비스 재기동 성공 |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/dashboard` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/video` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/video/editor` | ✅ `200` |

### 비디오팀 Twick CSS 경계 복구 1차

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/app/video/editor/page.js` | ✅ `/video/editor` 테스트 페이지 문법 유지 |
| `node --check bots/worker/web/components/TwickEditorWrapper.js` | ✅ Twick 래퍼 문법 유지 |
| `npx next build` (`bots/worker/web`) | ✅ `globals.css` 전역 media reset 축소 후에도 빌드 성공 |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/video` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/video/editor` | ✅ `200` |

### 비디오팀 Twick React SDK 통합 1차

| 테스트 | 결과 |
|--------|------|
| `test -d bots/worker/web/node_modules/tailwindcss && echo INSTALLED || echo MISSING` | ✅ 초기 상태 `MISSING` 확인 |
| `npm install tailwindcss` (`bots/worker/web`) | ✅ `39 packages` 추가, PostCSS/Tailwind 패키지 복구 완료 |
| `npx next build` (`bots/worker/web`) | ✅ Twick CSS import 방식 수정 + `transpilePackages` 보강 후 빌드 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 서비스 재기동 성공 |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/video` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/video/editor` | ✅ `200` |
| `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/video/editor` | ✅ 현재 worker-web live 포트가 아님을 확인 (`404`) |

### 비디오팀 Phase 2 final batch rerun

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/scripts/test-final-reference-quality-batch.js` | ✅ per-set timeout/skip, report 저장 경계 추가 후 문법 통과 |
| `node /Users/alexlee/projects/ai-agent-system/bots/video/scripts/test-final-reference-quality-batch.js --json --timeout-ms=300000` | ✅ `bots/video/temp/final_batch_report.json` 생성, 5세트 모두 `skipped_timeout`, 각 세트 `processing_time_ms ≈ 300000` 기록 |
| `node --input-type=module -e "...read bots/video/temp/final_batch_report.json..."` | ✅ summary `totalSets=5`, `completedSets=0`, `skippedSets=5`, `failedSets=0`, `timeoutMs=300000` 확인 |

### 스카 예측엔진 feature cleanup 1차

| 테스트 | 결과 |
|--------|------|
| `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365` | ✅ `174건 upsert`, `training_feature_daily 365행 동기화`, 새 semantics 기준 재적재 완료 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --json` | ✅ review 재실행 성공, summary는 여전히 `avgMape=32.31`, `avgBias=-78837`로 품질 보정 필요 구간 유지 |
| `node --input-type=module ... SELECT ... FROM ska.training_feature_daily ...` | ✅ `2026-03-17 ~ 2026-03-23` 샘플에서 `study_room_payment_*` 계열이 모두 `0`으로 고정되고, `study_room_use_*` 계열만 실제 use 축 값을 유지함을 확인 |

### 스카 예측엔진 bias 보정 2차

| 테스트 | 결과 |
|--------|------|
| `python3 -m py_compile bots/ska/src/forecast.py bots/ska/src/runtime_config.py` | ✅ calibration/runtime-config 외부화 후 문법 통과 |
| `node --check bots/ska/lib/runtime-config.js` | ✅ JS runtime-config 동기화 후 문법 통과 |
| `bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=daily --json` | ✅ `2026-03-24 predictedRevenue=238053`, `calibration_adjustment=34912`, `calibration_notes=weekday_bias:+34,912,samples:11` 저장 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --json` | ✅ daily review 재실행 기준 `avgMape=33.44`, `avgBias=-75194`, `hitRate20=41.7%`, shadow 우위(`avgMapeGap=-7.32`) 확인 |

### 루나 암호화폐 TP/SL 실패 추적 계측 1차

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/team/hephaestos.js` | ✅ `buildProtectionSnapshot()` 추가 후 문법 통과 |
| `node --check bots/investment/shared/trade-journal-db.js` | ✅ `trade_journal.tp_sl_mode / tp_sl_error` 추가 후 문법 통과 |
| `rg -n "tp_sl_mode|tp_sl_error|buildProtectionSnapshot" bots/investment/team/hephaestos.js bots/investment/shared/trade-journal-db.js` | ✅ 보호 주문 결과 계측 지점과 journal 컬럼 연결 확인 |

### 루나 crypto TP/SL capability-first 정책 반영

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/team/hephaestos.js` | ✅ capability-first 분기(`safeFeatureValue`, `getProtectiveExitCapabilities`) 추가 후 문법 통과 |
| `rg -n "getProtectiveExitCapabilities|safeFeatureValue|ccxt_stop_loss_only|exchange_stop_loss_only|isStopLossOnlyMode" bots/investment/team/hephaestos.js` | ✅ raw OCO → CCXT stopLossPrice → exchange stop-loss fallback 우선순위와 새 모드 분기 확인 |

### 루나 Binance 자본 스코프 경계 복구

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/shared/capital-manager.js` | ✅ 거래소 스코프 분리 후 문법 통과 |
| `node --input-type=module ... getAvailableBalance('binance'), getTotalCapital('binance'), preTradeCheck('ETH/USDT', 'BUY', 15, 'binance', 'normal') ...` | ✅ `binanceBalance=521.56`, `binanceTotalCapital=713.46`, `buyCheck.allowed=true` 확인 |
| `env PAPER_MODE=false INVESTMENT_TRADE_MODE=normal node bots/investment/team/hephaestos.js --action=BUY --symbol=ETH/USDT --amount=15` | ✅ 더 이상 `실잔고 부족 → PAPER 폴백`으로 내려가지 않고, 이번엔 `최대 포지션 도달: 6/6` 경계에서 중단됨 |

### 루나 PAPER→LIVE 승격 슬롯 잠식 방지

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/team/hephaestos.js` | ✅ `reserveSlots` 기반 승격 제한 추가 후 문법 통과 |
| `node --input-type=module ... SELECT ... FROM investment.positions WHERE exchange='binance' AND paper=false AND trade_mode='normal' ...` | ✅ 현재 LIVE normal open 6건(`ROBO/USDT` + `KAT/USDT`, `OPN/USDT`, `SAHARA/USDT`, `TAO/USDT`, `KITE/USDT`) 확인 |
| `env PAPER_MODE=false INVESTMENT_TRADE_MODE=normal node bots/investment/team/hephaestos.js --action=BUY --symbol=ETH/USDT --amount=15` | ✅ BUY 직전 PAPER→LIVE 승격이 5건 발생해 슬롯이 잠식됐음을 확인했고, 이후 코드에서 `reserveSlots: 1`로 현재 BUY용 슬롯 1개를 남기도록 보수화 |

### 루나 장기 미결 LIVE 포지션 health 경고 추가

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/scripts/health-report.js` | ✅ `stalePositionHealth` 추가 후 문법 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `stalePositionHealth.warnCount=7`, `decision.reasons`에 장기 미결 LIVE 포지션 경고 포함 확인 |
| `node bots/investment/scripts/health-report.js` | ✅ 텍스트 리포트에 `■ 장기 미결 LIVE 포지션` 섹션과 stale 샘플 7건이 직접 출력됨을 확인 |

### 루나 force-exit 후보 리포트 추가

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/scripts/force-exit-candidate-report.js` | ✅ force-exit 후보 리포트 문법 통과 |
| `node bots/investment/scripts/force-exit-candidate-report.js --json` | ✅ 운영 DB 기준 총 후보 `7건`, strong 후보 `5건`, 시장별 요약(`해외장 4 / 국내장 2 / 암호화폐 1`) 확인 |
| `node bots/investment/scripts/force-exit-candidate-report.js` | ✅ 텍스트 리포트에 후보 상세(`ORCL`, `NVTS`, `HIMS`, `NBIS`, `ROBO/USDT`, `006340`, `375500`)와 priority 출력 확인 |

### 루나 force-exit 승인형 runner 추가

| 명령 | 결과 |
| --- | --- |
| `node --check bots/investment/scripts/force-exit-runner.js` | ✅ 승인형 runner 문법 통과 |
| `node --check bots/investment/team/hephaestos.js` | ✅ `exit_reason_override` 추가 후 문법 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ `exit_reason_override` 추가 후 문법 통과 |
| `node bots/investment/scripts/force-exit-runner.js --json` | ✅ preview-only 모드에서 후보 7건과 실행 예시 명령이 출력됨을 확인 |
| `node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas` | ✅ 특정 후보 preview가 `ORCL / strong_force_exit_candidate / 278.2h` 기준으로 정상 출력되고, 실제 실행 명령 안내가 함께 노출됨을 확인 |

### 스카 shadow canary 편입 경로 추가

| 테스트 | 결과 |
|--------|------|
| `python3 -m py_compile bots/ska/src/forecast.py bots/ska/src/runtime_config.py` | ✅ shadow compare/blend guard 추가 후 Python 문법 통과 |
| `node --check bots/ska/lib/runtime-config.js` | ✅ shadow canary runtime-config 기본값 동기화 후 문법 통과 |
| `bots/ska/venv/bin/python bots/ska/src/forecast.py --mode=daily --json` | ✅ `2026-03-24 predictedRevenue=238598`, `shadow_model.yhat=283075`, `shadow_blend.applied=false`, `reason=shadow_compare_days_insufficient`, `available_days=3`, `avg_mape_gap=-7.32` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --json` | ✅ daily review가 `shadowCompareDays=3`, `shadowBlendReason=shadow_compare_days_insufficient`를 출력하고, 승격 판단도 canary guard 기준으로 정렬됨을 확인 |
| `node scripts/reviews/ska-sales-forecast-weekly-review.js --json` | ✅ weekly review가 `requiredDays=5`, `shadow canary 비교 데이터 누적 유지`, `availableDays=3`를 일관되게 출력함을 확인 |

### 스카 daily_summary 당일 false warning 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/scripts/health-report.js` | ✅ 당일 row 예외 처리 추가 후 문법 통과 |
| `node --input-type=module -e \"... select ... from reservation.daily_summary where date='2026-03-23'\"` | ✅ `total_amount=76500`, `room_amounts_json={A1:31500,A2:21000,B:24000}`, `pickko_study_room=0`, `general_revenue=0` 확인 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `dailySummaryIntegrityHealth.issueCount=0`, `decision.level=hold`, `recommended=false`로 회복 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ reservation 팀은 다시 `local fallback 활동 신호` 기준 hold로 읽히고, 스카 `daily_summary` 경고가 active issue에서 빠짐 |

### 스카 취소 감지 재예약 교차 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ 취소 감지 2/2E에 tracked reservation 가드 추가 후 문법 통과 |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ `naver-monitor` 재기동 완료, 새 PID `70952`로 launchd 운영 반영 |
| `launchctl list | grep 'ai.ska.naver-monitor'` | ✅ `ai.ska.naver-monitor` launchd 등록/실행 확인 |
| `launchctl print gui/$(id -u)/ai.ska.kiosk-monitor` | ✅ `ai.ska.kiosk-monitor` launchd running, PID 확인 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `commander / naver-monitor / kiosk-monitor / health-check` 모두 정상, `warnCount=0` 확인 |
| `/tmp/naver-ops-mode.log` 조민정 케이스 로그 대조 | ✅ 현재 확정 예약 `2026-04-04 15:30~18:30 A1`와 과거 취소건 `16:30~18:30`이 교차되며, 기존 실패 원인이 취소 탭 historical cancel 오인임을 확인 |

### 스카 daily_summary `pickko_total` 제거 / ETL 재동기화

| 테스트 | 결과 |
|--------|------|
| `node bots/reservation/scripts/migrate.js --status` | ✅ 스키마 버전 `v9`, `v008 pickko_order_raw_cleanup`, `v009 daily_summary_remove_pickko_total` 포함 총 9개 적용 확인 |
| `node --check bots/reservation/lib/db.js` | ✅ `daily_summary` write/read path에서 `pickko_total` 제거 후 문법 통과 |
| `node --check bots/reservation/scripts/pickko-revenue-backfill.js` | ✅ `pickko_total` 저장 제거 후 문법 통과 |
| `node --check bots/reservation/scripts/health-report.js` | ✅ `pickko_total` 없는 `daily_summary` 기준 무결성 검사 문법 통과 |
| `node --check bots/worker/lib/ska-sales-sync.js` | ✅ worker 미러가 `pickko_total` 없이도 동작하도록 정리 후 문법 통과 |
| `python3 -m py_compile bots/ska/src/etl.py bots/ska/lib/feature_store.py` | ✅ 예측 ETL/feature store 스키마 정렬 후 문법 통과 |
| `node - <<'EOF' ... syncSkaSalesToWorker('test-company') ... EOF` | ✅ worker `test-company` 재동기화 결과 `updated=0`, `expectedRows=299` 확인 |
| `bots/ska/venv/bin/python bots/ska/src/etl.py --days=365` | ✅ `174건 upsert`, `training_feature_daily 365행 동기화`, 최근값 `2026-03-22 actual_revenue=309800`, `2026-03-21 actual_revenue=288000` 확인 |

### 스카 스터디룸 계산식 문서 기준 재정렬

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/study-room-pricing.js` | ✅ `A1/A2 00:00~09:00 = 2,500원` 반영 후 문법 통과 |
| `node - <<'EOF' ... calcStudyRoomAmount(...) ... EOF` | ✅ `A1 08:00~09:00 = 5,000`, `A1 09:00~11:20 = 17,500`, `B 10:30~13:20 = 36,000`, `A1 17:30~18:20 = 7,000` 확인 |
| `env PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ 3월 전체 재집계 완료, 오류 `0건`, CSV `/Users/alexlee/.openclaw/workspace/revenue-history.csv` 31행 갱신 |
| `node - <<'EOF' ... syncSkaSalesToWorker('test-company') ... EOF` | ✅ worker `test-company` 미러 재동기화 `updated=12`, `expectedRows=299` |
| `node --input-type=module - <<'EOF' ... SELECT date, pickko_study_room, general_revenue FROM reservation.daily_summary ... EOF` | ✅ 대표 값 재확인: `2026-03-01 113000/113800`, `2026-03-12 135000/265000`, `2026-03-17 74500/290000`, `2026-03-21 156000/132000`, `2026-03-22 136000/173800` |

### 스카 downstream 합산 표기 정렬

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/ska-read-service.js` | ✅ `combined_revenue`, `study_cafe_revenue`, `study_room_revenue` 응답 필드 추가 후 문법 통과 |
| `node --check bots/reservation/scripts/dashboard-server.js` | ✅ 대시보드 summary query가 `combined_revenue`를 함께 노출하도록 변경 후 문법 통과 |
| `node --check scripts/collect-kpi.js` | ✅ 스카 KPI 합산값 의미 주석 추가 후 문법 통과 |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ 일일 리뷰 출력이 `내부 합산매출` 표기 기준으로 정렬된 후 문법 통과 |
| `dashboard.html` diff 검토 | ✅ 요약 카드가 `내부 합산매출 + 스터디카페/스터디룸 분리` 구조로 변경됨을 확인 |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ 주간 리뷰가 `실매출` 대신 `내부 합산매출` 기준 문구로 정렬된 후 문법 통과 |
| `node --check bots/reservation/scripts/export-ska-sales-csv.js` | ✅ CSV export에 `study_cafe_revenue / study_room_revenue / combined_revenue` 컬럼 추가 후 문법 통과 |
| `node --check bots/reservation/scripts/health-report.js` | ✅ 무결성 문구가 `스터디룸 축` 기준임을 명시하도록 변경 후 문법 통과 |

## 2026-03-22

### 스카 픽코 모니터링 unblock 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ `unblockNaverSlot()` return contract, `fillAvailablePopup()` 패널 닫힘 확인, 단독모드 DB 상태 경계 수정 후 문법 통과 |
| `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --block-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ `PATCH /schedules` `200 OK`, 최종 검증 성공 재확인 |
| `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --unblock-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ 패널 닫힘 확인, `PATCH /schedules` `200 OK`, 최종 해제 검증 성공 재확인 |

### 스카 네이버 슬롯 UI 안정화 1차

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ row-index 기반 slot selection / verify 보강 후 문법 통과 |
| `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --block-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ 정확한 `오전 11:00 A1` 슬롯 선택, 내부 `PATCH /schedules` 실측, 최종 검증 성공 |
| `env NAVER_TRACE_SCHEDULE_API=1 node bots/reservation/auto/monitors/pickko-kiosk-monitor.js --unblock-slot --date=2026-04-20 --start=11:00 --end=12:30 --room=A1 --phone=01000000000 --name=테스트` | ✅ 정확한 `예약불가` 슬롯 선택, `예약가능` 전환, 내부 `PATCH /schedules` `200 OK`, 최종 해제 검증 성공 |
| `/tmp/naver-schedule-trace.log` 확인 | ✅ `PATCH https://api-partner.booking.naver.com/v3.1/businesses/596871/biz-items/4132466/schedules` request/response trace 확보 |

### 스카 operation_queue 설계 문서

| 테스트 | 결과 |
|--------|------|
| 문서 반영 | ✅ `SKA_OPERATION_QUEUE_DESIGN_2026-03-22.md` 추가, 현재 in-memory 직렬화와 차후 queue 확장 구조를 분리 문서화 |

### 스카 고객 단위 연속 작업 cooldown

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ `phone|date` 기준 고객 cooldown 및 순차 처리 보강 후 문법 통과 |
| `node --check bots/reservation/lib/runtime-config.js` | ✅ `customerOperationCooldownMs` 추가 후 문법 통과 |

### 스카 픽코 자동 예약 감지 runbook

| 테스트 | 결과 |
|--------|------|
| 문서 반영 | ✅ `SKA_PICKKO_RESERVATION_FLOW_RUNBOOK_2026-03-22.md` 추가, 최신 `pickko-kiosk-monitor.js` 경계(`newEntries/retryEntries`, `manual follow-up` 분리) 반영 |

### 스카 픽코 자동 취소 감지 이중 조회

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ `상태=환불 + 상태=취소` 이중 조회, 합산/중복제거 후 문법 통과 |

### 스카 kiosk-monitor 자동 차단 경계 조정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ `toBlockEntries` dedupe key에 `end` 포함, `manualFollowupEntries` 제거 후 문법 통과 |
| `node --check bots/reservation/manual/reservation/pickko-accurate.js` | ✅ `manual` 락 TTL 20분 보강 후 문법 통과 |

### 스카 취소 command contract 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/manual-cancellation.js` | ✅ |
| `node --check bots/reservation/lib/ska-command-handlers.js` | ✅ |
| `node --check bots/reservation/scripts/dashboard-server.js` | ✅ |
| `node --check bots/orchestrator/lib/intent-parser.js` | ✅ |
| `node --check bots/orchestrator/src/router.js` | ✅ |
| `node - <<'NODE' ... parseCancellationCommand({ raw_text: '강보영 4월 5일 오전 9시~11시 A1 예약 취소해줘 010-2317-4540' }) ... NODE` | ✅ `phone/date/start/end/room/name` 정상 추출 |
| `node - <<'NODE' ... parseIntent('강보영 4월 5일 오전 9시~11시 A1 예약 취소해줘 010-2317-4540') ... NODE` | ✅ `ska_action`, `command=cancel_reservation` 파싱 확인 |

### 2026-03-22 — 스카 매출 source 영향 경로 정렬 / 예측엔진 입력 복구

| 명령 | 결과 |
| --- | --- |
| `node --check bots/reservation/lib/ska-read-service.js` | ✅ `total_revenue` 노출 추가 후 문법 통과 |
| `node --check bots/reservation/scripts/dashboard-server.js` | ✅ dashboard summary에 `total_revenue` 추가 후 문법 통과 |
| `node --check scripts/collect-kpi.js` | ✅ KPI 집계가 `general_revenue + pickko_study_room` 기준으로 바뀐 후 문법 통과 |
| `python3 -m py_compile bots/ska/src/etl.py` | ✅ ETL 문법 통과 |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ 보조 표시값/날짜 캐스팅 수정 후 문법 통과 |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ 날짜 캐스팅 수정 후 문법 통과 |
| `node --input-type=module - <<'EOF' ... createSkaReadService().queryTodayStats({ date: '2026-03-22' }) ... EOF` | ✅ `total_revenue=173800`, `pickko_study_room=136000`, `general_revenue=37800` 확인 |
| `node --input-type=module - <<'EOF' ... SUM(general_revenue + pickko_study_room) ... EOF` | ✅ `2026-03-22` KPI 총매출 기준 `173800원`, `entries_count=25` 확인 |
| `bots/ska/venv/bin/python bots/ska/src/etl.py --days=120` | ✅ `revenue_daily 121건 upsert`, `training_feature_daily 365행 대상 동기화`, 최근 5일 actual 재적재 완료 |
| `node --input-type=module - <<'EOF' ... SELECT ... FROM ska.revenue_daily WHERE date IN ('2026-03-21','2026-03-22') ... EOF` | ✅ `2026-03-21 actual_revenue=156000`, `2026-03-22 actual_revenue=173800` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ 최신 actual이 `2026-03-22`, `actualRevenue=173800`, `totalRevenue=173800`으로 정렬된 것 확인 |

### 2026-03-22 — 스카 매출 DB 적재 마무리 / source-mirror 정합성 복구

| 명령 | 결과 |
| --- | --- |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ 3월 전체 재집계 완료, `2026-03-21`, `2026-03-22` stale `daily_summary` 복구 |
| `node --input-type=module - <<'EOF' ... syncSkaSalesToWorker('test-company') ... EOF` | ✅ `inserted=1`, `updated=27`, `deleted=2`, `expectedRows=290`으로 worker 미러 재동기화 완료 |
| `node --input-type=module - <<'EOF' ... SELECT ... FROM reservation.daily_summary WHERE date IN ('2026-03-21','2026-03-22') ... EOF` | ✅ `2026-03-21 pickko_study_room=156000`, `2026-03-22 pickko_study_room=136000 / general_revenue=37800 / pickko_total=173800` 확인 |
| `node --input-type=module - <<'EOF' ... SELECT ... FROM worker.sales WHERE company_id='test-company' AND date IN ('2026-03-21','2026-03-22') ... EOF` | ✅ `2026-03-21 스터디룸 156000`, `2026-03-22 스터디룸 136000 + 일반석 37800` 확인 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `dailySummaryIntegrityHealth.issueCount=0`, `daily_summary 무결성` 경고 해소 확인 |

### Jimmy 성공 알림 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ |
| `node --check bots/reservation/manual/reports/pickko-alerts-query.js` | ✅ |
| `node bots/reservation/manual/reports/pickko-alerts-query.js --type=error --unresolved` | ✅ 실제 DB 기준 `count=0` |
| `node bots/reservation/manual/reports/pickko-alerts-query.js --phone=01089430972 --hours=48` | ✅ 실제 DB 기준 `count=0` |

### 비디오팀 Phase 2 — AI 싱크 매칭 파이프라인

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/scene-indexer.js` | ✅ |
| `node --check bots/video/lib/narration-analyzer.js` | ✅ |
| `node --check bots/video/lib/sync-matcher.js` | ✅ |
| `node --check bots/video/lib/intro-outro-handler.js` | ✅ |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ |
| `node --check bots/video/scripts/test-scene-indexer.js` | ✅ |
| `node --check bots/video/scripts/test-narration-analyzer.js` | ✅ |
| `node --check bots/video/scripts/test-sync-matcher.js` | ✅ |
| `node --check bots/video/scripts/test-intro-outro.js` | ✅ |
| `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅ |
| `node bots/video/scripts/test-sync-matcher.js` | ✅ `matched_keyword=2`, `overall_confidence=0.8334`, `edl_clip_count=2` 확인 |
| `node bots/video/scripts/test-intro-outro.js` | ✅ 로컬 ffmpeg `drawtext` 미지원 환경에서도 fallback title card 생성 확인 |
| `node bots/video/scripts/test-narration-analyzer.js --source-audio=...` | ✅ 샌드박스 네트워크 제약 시 오프라인 fixture fallback으로 `duration_s=261`, `total_segments=5` 확인 |
| `node bots/video/scripts/test-scene-indexer.js --source-video=...` | ✅ `duration_s=1410.45`, `total_frames_captured=141`, `unique_frames=42`, `scene_count=42` 확인 |
| `node bots/video/scripts/test-full-sync-pipeline.js --source-video=... --source-audio=... --edited=...` | ✅ `scene_count=42`, `segment_count=5`, `keyword=5`, `unmatched=0`, `sync_confidence=0.6`, `intro_prompt.mp4` 생성 확인 |
| `node bots/video/scripts/test-full-sync-pipeline.js --source-video=... --source-audio=... --edited=... --render-preview` | ✅ preview render 완료, `preview.mp4` 생성 확인 |
| `ffprobe .../preview.mp4` | ⚠️ 초기 검증에서 `video=103s`, `audio=524.863s` 불일치 확인 → V2 clip speed/audio 경계 추가 보강 필요성 확인 |
| `node - <<'NODE' ... renderPreview(loadEDL(...), 'preview-fixed.mp4') ... NODE` | ✅ 수정 후 `preview-fixed.mp4` 렌더 성공, `duration_ms=103527` |
| `ffprobe .../preview-fixed.mp4` | ✅ `1280x720`, `60fps`, `video=264.000s`, `audio=264.000s`, `48000Hz stereo`, A/V 정합성 회복 확인 |
| `node --check bots/video/lib/reference-quality.js` | ✅ |
| `node --check bots/video/scripts/test-reference-quality.js` | ✅ |
| `node bots/video/scripts/test-reference-quality.js --generated=.../preview-fixed.mp4 --sample=파라미터 --json` | ✅ `overall=70.43`, `duration=64.26`, `resolution=25.18`, `visual_similarity=79.61` baseline 확인 |
| `node --check bots/video/scripts/test-reference-quality-batch.js` | ✅ |
| `node bots/video/scripts/test-reference-quality-batch.js --json` | ✅ 5세트 batch baseline `averageOverall=68.88`, `averageDuration=54.30`, `averageResolution=25.11`, `averageVisualSimilarity=83.76` 확인 |
| `node bots/video/scripts/test-full-sync-pipeline.js --source-video=... --source-audio=... --edited=... --render-final` | ✅ `final.mp4` 생성, `2560x1440`, `60fps`, `264s`, `AAC 48kHz stereo`, `file_size=46,555,622`, `duration_ms=249452` 확인 |
| `ffprobe .../final.mp4` | ✅ `video=264.000s`, `audio=264.000s`, `2560x1440`, `60fps`, `faststart` 메타데이터 확인 |
| `node bots/video/scripts/test-reference-quality.js --generated=.../final.mp4 --sample=파라미터 --json` | ✅ final baseline `overall=81.62`, `duration=64.26`, `resolution=99.30`, `visual_similarity=79.82` 확인 |
| `node --check bots/video/scripts/test-final-reference-quality-batch.js` | ✅ |
| `node bots/video/scripts/test-final-reference-quality-batch.js --title=파라미터 --json` | ✅ batch 레일 1세트 sanity check, `averageOverall=81.62`, `averageFinalRenderMs=210767` 확인 |
| `node --check bots/video/lib/edl-builder.js` | ✅ final render watchdog 가변화 문법 확인 |
| `node bots/video/scripts/test-final-reference-quality-batch.js --title=서버인증 --json` | ✅ false stall 복구 후 `overall=72.96`, `duration=41.26`, `visual_similarity=74.49`, `duration_ms=754867` 확인 |
| `node bots/video/scripts/test-final-reference-quality-batch.js --json` | ✅ final 5세트 baseline 완료, `averageOverall=79.00`, `averageDuration=54.67`, `averageResolution=99.58`, `averageVisualSimilarity=80.41` 확인 |
| `node bots/video/scripts/test-reference-quality.js --generated=.../final.mp4 --sample=컴포넌트스테이트 --json` | ✅ `overall=80.16`, `duration=59.95`, `visual_similarity=79.33` |
| `node bots/video/scripts/test-reference-quality.js --generated=.../final.mp4 --sample=동적데이터 --json` | ✅ `overall=85.12`, `duration=69.85`, `visual_similarity=85.02` |
| `node bots/video/scripts/test-reference-quality.js --generated=.../final.mp4 --sample=서버인증 --json` | ✅ `overall=72.96`, `duration=41.26`, `visual_similarity=74.49` |
| `node bots/video/scripts/test-reference-quality.js --generated=.../final.mp4 --sample=db생성 --json` | ✅ `overall=75.12`, `duration=38.03`, `visual_similarity=83.41` |
| `node --check bots/video/scripts/analyze-final-structure-gap.js` | ✅ |
| `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-S73v5p/final.mp4 --edl=.../video-sync-pipeline-S73v5p/edit_decision_list.json --sample=서버인증 --json` | ✅ `duration_ratio=0.4126`, `speed_floor_ratio=0.8`, `hold=1`, `main:900~910s` 4회 재사용 확인 |
| `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-037yYC/final.mp4 --edl=.../video-sync-pipeline-037yYC/edit_decision_list.json --sample=db생성 --json` | ✅ `duration_ratio=0.3803`, `speed_floor_ratio=0.8`, `hold=0`, `main:1370~1400s` 2회 재사용 확인 |
| `node -e "... buildOfflineNarrationFixture(server auth sample) ..."` | ✅ `segments=7`, 인증 특화 topic/keywords 확인 |
| `node -e "... buildOfflineNarrationFixture(db sample) ..."` | ✅ `segments=6`, DB 특화 topic/keywords 확인 |
| `node -e "... buildSyncMap(server scene_index + auth fixture) ..."` | ✅ `서버인증` sync-level `keyword=7`, `hold=0`, `unmatched=0` 확인 |
| `node -e "... buildSyncMap(db scene_index + db fixture) ..."` | ✅ `DB생성` sync-level `keyword=4`, `hold=2`, `unmatched=0` 확인 |
| `node --check bots/video/lib/edl-builder.js` | ✅ pacing policy 오디오 패딩(`apad`) 문법 확인 |
| `node --check bots/video/lib/sync-matcher.js` | ✅ pacing policy EDL 길이 보정 문법 확인 |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ `syncMapToEDL(..., config)` 호출 경계 확인 |
| `node --check bots/video/scripts/test-full-sync-pipeline.js` | ✅ validation 레일 pacing 호출 경계 확인 |
| `node --check bots/video/scripts/test-sync-matcher.js` | ✅ 더미 검증 레일 pacing 호출 경계 확인 |
| `node bots/video/scripts/test-sync-matcher.js` | ✅ `matched_keyword=2`, `overall_confidence=0.8334`, `edl_clip_count=2` 유지 |
| `node -e \"... syncMapToEDL(server auth sync_map) ...\"` | ✅ `서버인증` EDL `duration=1008.129`, `pacing_extra_total=162.129` |
| `node -e \"... syncMapToEDL(db sync_map) ...\"` | ✅ `DB생성` EDL `duration=629.8`, `pacing_extra_total=125.8` |
| `node bots/video/scripts/test-full-sync-pipeline.js --source-video=...원본_서버인증.mp4 --source-audio=...원본_나레이션_서버인증.m4a --edited=...편집_서버인증.mp4 --render-final` | ✅ `duration_ms=675045`, `scene_count=13`, `segment_count=7`, `keyword=7`, `hold=0` |
| `node bots/video/scripts/test-reference-quality.js --generated=.../video-sync-pipeline-6qDyBJ/final.mp4 --sample=서버인증 --json` | ✅ `overall=75.61`, `duration=49.13`, `visual_similarity=75.30`, `duration_ratio=0.4913` |
| `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-6qDyBJ/final.mp4 --edl=.../video-sync-pipeline-6qDyBJ/edit_decision_list.json --sample=서버인증 --json` | ✅ `hold=0`, `speed_floor_ratio=0.7143`, `900~910s`/`1620~1660s` 반복 window 2개 확인 |
| `node bots/video/scripts/test-full-sync-pipeline.js --source-video=...원본_DB생성.mp4 --source-audio=...원본_나레이션_DB생성.m4a --edited=...편집_DB생성.mp4 --render-final` | ✅ `duration_ms=345379`, `scene_count=116`, `segment_count=6`, `keyword=4`, `hold=2` |
| `node bots/video/scripts/test-reference-quality.js --generated=.../video-sync-pipeline-mjrDSu/final.mp4 --sample=db생성 --json` | ✅ `overall=78.77`, `duration=47.47`, `visual_similarity=85.75`, `duration_ratio=0.4747` |
| `node bots/video/scripts/analyze-final-structure-gap.js --generated=.../video-sync-pipeline-mjrDSu/final.mp4 --edl=.../video-sync-pipeline-mjrDSu/edit_decision_list.json --sample=db생성 --json` | ✅ `hold=2`, `speed_floor_ratio=0.5`, `650~690s`/`860~910s` 반복 window 2개 확인 |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ `preview_ms` 저장 경로 문법 확인 |
| `node --input-type=module -e \"... preview_ms migration ...\"` | ✅ `video_edits.preview_ms` 컬럼 실제 반영 확인 |
| `node -e \"... ALTER TABLE video_sessions ADD COLUMN ...\"` | ✅ `video_sessions` intro/outro 컬럼 6종 실제 반영 확인 |

### 일일 운영 분석 리포트 해석 품질 보강

| 테스트 | 결과 |
|--------|------|
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ `runtimeRestrictions` 섹션, selector primary issue, gateway post-restart guidance 반영 확인 |

### 제이/OpenClaw gateway fallback readiness + concurrency 안정화

| 테스트 | 결과 |
|--------|------|
| `node --check bots/orchestrator/lib/openclaw-config.js` | ✅ |
| `node --check bots/orchestrator/scripts/check-jay-gateway-primary.js` | ✅ |
| `node --check bots/orchestrator/scripts/prepare-jay-gateway-switch.js` | ✅ |
| `node --check bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅ |
| `node --check scripts/reviews/jay-gateway-experiment-review.js` | ✅ |
| `node --check bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js` | ✅ |
| `node --check bots/orchestrator/scripts/tune-jay-gateway-concurrency.js` | ✅ |
| `node bots/orchestrator/scripts/check-jay-gateway-primary.js` | ✅ `ready fallback=4`, `unready fallback=0`, `Groq authReady=no` 확인 |
| `node bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js` | ✅ 현재 fallback `11`, ready fallback `4`, 권장 체인 계산 확인 |
| `node bots/orchestrator/scripts/prune-jay-gateway-fallbacks.js --apply` | ✅ 라이브 fallback chain `11 -> 4` 적용 |
| `node bots/orchestrator/scripts/tune-jay-gateway-concurrency.js --apply --max=1 --subagents=2` | ✅ 라이브 concurrency `1/2` 적용 |
| `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` | ✅ gateway 재기동 |
| `node scripts/reviews/jay-gateway-experiment-daily.js` | ✅ 최신 창에서 `rate limit=76`, `active=33`, `retry burst runs=13`, `max attempts per run=4` 확인 |
| `node bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅ `마지막 gateway 재기동 이후: rate limit 0 / auth missing 0 / retry burst 0` 확인 |
| `node scripts/reviews/jay-gateway-experiment-review.js` | ✅ `post-restart rate limit/auth missing/retry burst` 출력 확인 |

## 2026-03-21

### 스카 수동등록 후속 차단 원장화 + 취소 스킵 버그 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/db.js` | ✅ |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ |
| `node --check bots/reservation/manual/reservation/pickko-register.js` | ✅ |
| `node --check bots/reservation/migrations/006_kiosk_block_attempts.js` | ✅ |
| `node bots/reservation/scripts/check-n8n-command-path.js` | ✅ 이제 실제 nested error(`EPERM ... 5432`) 출력 확인 |
| `node bots/reservation/scripts/migrate.js --status` | ✅ `v006 kiosk_block_attempts` 미적용 상태 확인 |
| `node bots/reservation/scripts/migrate.js` | ✅ `v006 kiosk_block_attempts` 적용 완료, 스키마 `v6` 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.ska.naver-monitor` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.ska.kiosk-monitor` | ✅ |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `naver-monitor`, `kiosk-monitor`, `ska command webhook` 정상 유지 확인 |
| `민경수 2026-03-27 12:00~14:00 A1 원장 조회` | ✅ `manual 등록 완료 + naver_blocked=false` 확인, false alert가 아니라 실제 후속 차단 누락으로 분류 |
| `최근 manual 등록 미래 예약 8건 운영 점검` | ✅ 네이버 예약관리에서 직접 확인 후 모두 처리 완료 |
| `node --check bots/reservation/manual/reports/manual-block-followup-report.js` | ✅ |
| `node --check bots/reservation/manual/reports/manual-block-followup-resolve.js` | ✅ |
| `node bots/reservation/manual/reports/manual-block-followup-resolve.js --from=2026-03-21 --all-open --dry-run` | ✅ 대상 8건 일치 확인 |
| `node bots/reservation/manual/reports/manual-block-followup-resolve.js --from=2026-03-21 --all-open` | ✅ 8건을 `manually_confirmed`로 원장 반영 |
| `node bots/reservation/manual/reports/manual-block-followup-report.js --from=2026-03-21` | ✅ `count=11`, `openCount=0` 확인 |

---

## 2026-03-20

### 스카 세션 만료 알림 문구 개선 + headed 운영 가이드 보강

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `rg -n "playwright-headed|reload-monitor|네이버 로그인 세션 만료" bots/reservation/auto/monitors/naver-monitor.js bots/reservation/context/HANDOFF.md` | ✅ 알림 문구와 운영 가이드 반영 확인 |

### 스카 Playwright/Puppeteer headless 기본화

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/browser.js` | ✅ |
| `node --check packages/playwright-utils/src/browser.js` | ✅ |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `node --check bots/reservation/src/check-naver.js` | ✅ |
| `node --check bots/reservation/src/init-naver-booking-session.js` | ✅ |
| `node --check bots/reservation/src/inspect-naver.js` | ✅ |
| `node --check bots/reservation/src/analyze-booking-page.js` | ✅ |
| `node --check bots/reservation/src/get-naver-html.js` | ✅ |
| `bash -n bots/reservation/auto/monitors/start-ops.sh` | ✅ |
| `node -e "const b=require('./bots/reservation/lib/browser'); ..."` | ✅ 기본값 `headless='new'` 확인 |
| `PLAYWRIGHT_HEADLESS=false node -e "const b=require('./bots/reservation/lib/browser'); ..."` | ✅ headed 디버그 모드 전환 확인 |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ `ai.ska.naver-monitor` 재시작, PID `45377` 확인 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `naver-monitor`, `kiosk-monitor`, `health-check`, `daily_summary 무결성` 모두 정상 확인 |
| `node --check bots/reservation/lib/study-room-pricing.js` | ✅ 스터디룸 시간 기반 산출 helper 문법 확인 |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ 새 스터디룸 산출식 반영 후 문법 확인 |
| `node --check bots/reservation/scripts/pickko-revenue-backfill.js` | ✅ backfill 스크립트 문법 확인 (`exportCsv` await 포함) |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ 3월 전체 재집계, `2026-03-18` 스터디룸 7건 → `87,500원`, `2026-03-10` timeout 잔여 복구 기준 확보 |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-02 --to=2026-02` | ✅ 2월 전체 재집계, `2026-02-27` stale `pickko_study_room=7,000` → `122,000원` 복구 |
| `node --input-type=module -e \"... syncSkaSalesToWorker('test-company') ...\"` | ✅ worker `test-company` 미러 재동기화 (`expectedRows: 288`) |
| `node bots/reservation/scripts/health-report.js --json` | ✅ 새 정책 기준 `dailySummaryIntegrityHealth.issueCount=0`, `policyDivergenceCount=14` 확인 |
| `node --input-type=module -e \"... reservation.daily_summary vs worker.sales(test-company) 전체 diff ...\"` | ✅ 과거 전체 범위 diff `0건` 확인 |

### 비디오팀 과제 1 — 프로젝트 스캐폴딩 + DB 스키마 + config

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/src/index.js` | ✅ |
| `tail -n 3 bots/video/docs/CLAUDE.md` | ✅ 마지막 줄이 `24Mbps로 업로드하면 유튜브 재인코딩 후에도 디테일이 최대한 보존됨.` 으로 종료됨 확인 |
| `grep -n "\*.mp4\|\*.m4a\|\*.mp3\|\*.wav\|\*.srt\|dfd_\*/" .gitignore` | ✅ 비디오팀 미디어 ignore 규칙 반영 확인 |
| `mkdir -p bots/video/temp bots/video/exports` | ✅ 디렉토리 생성 완료 |
| `node --input-type=module -e "... pgPool.run('public', sql) ..."` | ✅ `bots/video/migrations/001-video-schema.sql`을 `jay` DB에 직접 적용 (`migration_ok`) |
| `node bots/video/src/index.js` | ✅ `config 로드 성공`, `DB 연결 성공` 출력 확인 |
| `node --input-type=module -e "... SELECT * FROM video_edits LIMIT 1 ..."` | ✅ `public.video_edits` 조회 성공, 빈 결과(`rowCount: 0`) 확인 |
| `rg -n "render_bitrate: 24M" bots/video/config/video-config.yaml` | ✅ |
| `test -f bots/video/context/IDENTITY.md` | ✅ |
| `ls -ld bots/video/config bots/video/context bots/video/migrations bots/video/src bots/video/temp bots/video/exports` | ✅ 필요한 디렉토리/파일 존재 확인 |

### 비디오팀 과제 2 — FFmpeg 전처리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/ffmpeg-preprocess.js` | ✅ 통과 |
| `node --check bots/video/scripts/test-preprocess.js` | ✅ 통과 |
| `ffmpeg -version \| head -n 1 && ffprobe -version \| head -n 1` | ✅ FFmpeg/ffprobe 8.1 사용 가능 확인 |
| `node bots/video/scripts/test-preprocess.js` | ✅ `removeAudio`, `normalizeAudio`, `syncVideoAudio`, `preprocess 통합`, `LUFS 측정 -14.9` 전체 통과 |
| `test -f bots/video/temp/synced.mp4` | ✅ 생성 확인 |
| `ffprobe 기반 stream 검증` | ✅ `1920x1080 60fps` video + `48000Hz stereo AAC` audio 확인 |

### 비디오팀 과제 3 — Whisper STT

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/whisper-client.js` | ✅ 통과 |
| `node --check bots/video/scripts/test-whisper.js` | ✅ 통과 |
| `node bots/video/scripts/test-whisper.js` | ✅ 실제 OpenAI Whisper 호출, `67 segments`, `subtitle_raw.srt`, 비용 `$0.026119` 전체 통과 |
| `test -f bots/video/temp/subtitle_raw.srt` | ✅ 생성 확인 |
| `node --input-type=module -e "... llm_usage_log WHERE team='video' ..."` | ✅ `model=whisper-1`, `request_type=audio_transcription`, `cost_usd=0.026119` 확인 |

### 비디오팀 과제 4 — LLM 자막 교정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/subtitle-corrector.js` | ✅ 통과 |
| `node --check bots/video/scripts/test-subtitle-corrector.js` | ✅ 통과 |
| `node bots/video/scripts/test-subtitle-corrector.js` | ✅ 실제 LLM 호출 기준 `67 entries 유지`, `67/67 타임스탬프 보존`, `subtitle_corrected.srt`, 비용 `$0.002` 확인 |
| `test -f bots/video/temp/subtitle_corrected.srt` | ✅ 생성 확인 |
| `node --input-type=module -e "... llm_usage_log WHERE team='video' ..."` | ✅ `model=gpt-4o-mini`, `request_type=subtitle_correction`, 성공 로그 확인 |

### 아처 자동화 리포트 재검증 + 비용 표 source 보정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/claude/lib/archer/analyzer.js` | ✅ |
| `node bots/claude/src/archer.js` | ✅ 실네트워크 수집/분석 후 `archer-2026-03-20.md` 재생성 |
| `node --input-type=module -e "... from claude.billing_snapshots ..."` | ✅ 최근 10일 snapshot이 provider별 동일 누적값으로 저장됨 확인 (`anthropic=16.417`, `openai=3.564`) |
| `node --input-type=module -e "... from reservation.llm_usage_log ..."` | ✅ 실제 일별 사용량은 날짜별로 변동함 확인 |
| `sed -n '52,68p' bots/claude/reports/archer-2026-03-20.md` | ✅ 최근 7일 비용 표가 `YYYY-MM-DD` 형식과 usage 기반 일별 값으로 출력됨 확인 |

### 어제자 리포트 후속: KIS 과속 완화 + 아처 비용 리포트 정합성 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/kis-client.js` | ✅ |
| `node --check bots/claude/lib/archer/analyzer.js` | ✅ |
| `launchctl list \| egrep 'ai\.investment\.(commander\|crypto\|domestic\|overseas\|reporter)'` | ✅ `domestic`, `crypto`, `overseas`, `commander`, `reporter` launchd 라벨 존재 확인 |
| `tail -n 120 /tmp/investment-domestic.log` | ✅ 최신 국내 수집/판단 사이클에서 `failed=0`, `coreFailed=0`, `enrichFailed=0` 정상 마감 확인 |
| `tail -n 120 /tmp/investment-domestic.err.log` | ✅ 과거 `초당 거래건수를 초과하였습니다.` 오류 흔적은 남아 있으나, 최신 정상 사이클 존재 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `serviceHealth.okCount=13`, `guardHealth: 투자 LLM guard 없음` 확인 |

### 루나 LLM guard 범위 정밀화 + TTL 자동 해제

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ |
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --check packages/core/lib/llm-logger.js` | ✅ |
| `node --check bots/investment/shared/llm-client.js` | ✅ |
| `node --check bots/investment/shared/secrets.js` | ✅ |
| `node --check bots/investment/markets/crypto.js` | ✅ |
| `node --check bots/investment/markets/domestic.js` | ✅ |
| `node --check bots/investment/markets/overseas.js` | ✅ |

## 2026-03-21

### worker-web `/video` 세션 복원 + 프리뷰 렌더 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/app/_shell.js` | ✅ hydration 전 빈 화면 대신 로딩 셸 렌더 문법 확인 |
| `node --check bots/worker/web/app/video/page.js` | ✅ idle 업로드 노출, 세션 URL/localStorage 복원 로직 문법 확인 |
| `node --check bots/worker/web/routes/video-api.js` | ✅ 파일명 UTF-8 복원, start fallback, edit 생성 검증 문법 확인 |
| `node --check bots/video/lib/edl-builder.js` | ✅ transition 렌더 임시 비활성화 문법 확인 |
| `cd bots/worker/web && npx next build` | ✅ `/video`, `/video/history` 포함 build 재통과 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ worker API 재기동 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 재기동 |
| `SELECT id, status FROM public.video_sessions WHERE id = 1` | ✅ `id=1`, `status=processing` 세션 존재 확인 |
| `SELECT id, status, trace_id FROM public.video_edits WHERE session_id = 1` | ✅ 초기 `0건` 확인 후 direct recovery 뒤 `id=16`, `status=correction_done`, `trace=f84aa3f6-329e-43af-8eac-ae6f8eeaf474` 확인 |
| `ffprobe bots/video/temp/run-f84aa3f6/synced.mp4` | ✅ 원본 합성본은 정상 비디오 스트림 확인 |
| `ffprobe bots/video/temp/run-f84aa3f6/preview.mp4` | ✅ 프리뷰 파일 자체는 생성되지만 bitrate가 비정상적으로 낮아 검은 화면 의심 |
| `preview/synced 첫 프레임 추출 비교` | ✅ `synced.mp4`는 정상 화면, `preview.mp4`는 완전 검정으로 transition 필터 체인 원인 분리 확인 |

### 비디오팀 Phase 1 마감 — worker-web `/video` 빌드 반영

| 테스트 | 결과 |
|--------|------|
| `cd bots/worker/web && npx next build` | ✅ `/video`, `/video/history` 포함 production build 통과 |
| `launchctl list \| egrep 'ai\.worker\.(web\|nextjs)'` | ✅ 재기동 전 `ai.worker.nextjs`가 예전 빌드를 물고 있던 상태 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 런타임 재기동 |
| `curl -I http://127.0.0.1:4001/video` | ✅ `200 OK` |
| `curl -I http://127.0.0.1:4001/video/history` | ✅ `200 OK` |

### worker-web 비디오 업로드 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node --check bots/worker/web/app/video/page.js` | ✅ |
| `cd bots/worker/web && npx next build` | ✅ 업로드 UI 보강 후 build 통과 |
| `node --input-type=module -e \"... ALTER TABLE public.video_sessions ALTER COLUMN company_id TYPE TEXT ...\"` | ✅ `video_sessions.company_id`가 실제 `text`로 보정됨 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ worker API 재기동 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 재기동 |

### 비디오팀 과제 13 — 5세트 전체 파이프라인 검증 (`--skip-render`)

| 테스트 | 결과 |
|--------|------|
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_파라미터.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_파라미터.m4a" --skip-render` | ✅ `preview_ready`, trace `05b1bc91-7251-401f-a6db-2cd53604404c`, `total_ms=214732` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_컴포넌트스테이트.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_컴포넌트스테이트.m4a" --skip-render` | ✅ `preview_ready`, trace `5e18ef34-7841-4faa-9981-7023eef51d36`, `total_ms=522694` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_동적데이터.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_동적데이터.m4a" --skip-render` | ✅ `preview_ready`, trace `68c204d7-a99a-404d-bc23-8ed411e114b3`, `total_ms=417838` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_서버인증.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_서버인증.m4a" --skip-render` | ✅ `preview_ready`, trace `3017b788-e0b9-4e09-9235-dfce5127804b`, `total_ms=712327` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_DB생성.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_DB생성.m4a" --skip-render` | ✅ `preview_ready`, trace `a4acc396-b9bf-4a43-ae30-b8ddb296d566`, `total_ms=334298` |
| `ffprobe bots/video/temp/run-05b1bc91/synced.mp4 / preview.mp4` | ✅ 세트 1 `261.2s`, `1920x1080 -> 1280x720` 및 video/audio duration 정합성 확인 |
| `node - <<'NODE' ... runQualityLoop(...) ... NODE` (세트 1 최신 run 기준) | ✅ `iteration0 score=80`, `iteration1 score=80`, `recommendation=ACCEPT_BEST`, `final_score=80`, `pass=false` |
| `node - <<'NODE' ... estimateWithRAG(5, 481.9, 224.3) ... NODE` | ✅ `estimated_ms=373360`, `confidence=high`, `sample_count=5` |
| `SELECT COUNT(*) FROM reservation.rag_video` | ✅ `7건` 확인 |
| `bots/video/temp/validation_report.json` 재생성 | ✅ `successful=5`, `failed=0`, `avg_total_ms=440378`, `total_cost_usd=0.2756` |

### 비디오팀 과제 12 — Evaluator + quality loop

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/evaluator-agent.js` | ✅ |
| `node --check bots/video/lib/quality-loop.js` | ✅ |
| `node --check bots/video/scripts/test-quality-loop.js` | ✅ |
| `node bots/video/scripts/test-quality-loop.js` | ✅ 실제 quality loop 실행, `iteration0 score=80`, `iteration1 score=80`, `recommendation=ACCEPT_BEST`, `final_score=80`, `loop_result.json` 생성 |
| `node --input-type=module -e "... runEvaluator('./bots/video/temp/refiner_result.json', './bots/video/temp/synced.mp4', config) ..."` | ✅ standalone `refiner_result.json` 기준 `analysis.json` 자동 추론, `score=71`, `recommendation=ACCEPT_BEST` 확인 |

### 비디오팀 과제 9 — n8n 연동

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/n8n-runner.js` | ✅ |
| `node --check bots/video/n8n/setup-video-workflow.js` | ✅ |
| `node --check bots/worker/web/routes/video-internal-api.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/video/lib/video-n8n-config.js` | ✅ |
| `node --check bots/video/scripts/check-n8n-video-path.js` | ✅ |
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node -e "JSON.parse(fs.readFileSync('bots/video/n8n/video-pipeline-workflow.json','utf8'))"` | ✅ workflow JSON 파싱 확인 |
| `VIDEO_N8N_TOKEN=video-local-test-20260321 WORKER_API_INTERNAL_URL=http://127.0.0.1:4000 N8N_BASE_URL=http://127.0.0.1:5678 node bots/video/n8n/setup-video-workflow.js` | ✅ 기존 inactive workflow 정리 후 새 workflow 생성/활성화, live webhook path 출력 확인 |
| `curl -i -s -X POST http://127.0.0.1:4000/api/video/internal/run-pipeline -H 'Content-Type: application/json' -H 'X-Video-Token: video-local-test-20260321' -d '{"_healthProbe":true}'` | ✅ 내부 dispatch API `200 {"ok":true,"status":"probe_ok"}` 확인 |
| `VIDEO_N8N_TOKEN=video-local-test-20260321 node bots/video/scripts/check-n8n-video-path.js` | ✅ `n8nHealthy=true`, `webhookRegistered=true`, `webhookStatus=200`, live resolved webhook 확인 |
| `node --check bots/video/n8n/setup-video-workflow.js` (보강 후) | ✅ `N8N_BASE_URL` 파싱 + registry 실패 degrade 문법 확인 |
| `node bots/video/n8n/setup-video-workflow.js` | ✅ `bots/worker/secrets.json`의 `video_n8n_token` fallback만으로 workflow 재생성/활성화 성공 |
| `node bots/video/scripts/check-n8n-video-path.js` | ✅ env 없이도 `n8nHealthy=true`, `webhookRegistered=true`, `webhookStatus=200` 확인 |

### 비디오팀 RAG 피드백 루프

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/rag.js` | ✅ |
| `node --check bots/video/lib/video-rag.js` | ✅ |
| `node --check bots/video/lib/critic-agent.js` | ✅ |
| `node --check bots/video/lib/edl-builder.js` | ✅ |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ |
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node --check bots/video/scripts/test-video-rag.js` | ✅ |
| `node bots/video/scripts/test-video-rag.js` | ✅ `rag_video` 초기화, `storeEditResult`, `storeEditFeedback`, `searchSimilarEdits`, `searchEditPatterns`, `estimateWithRAG`, `enhanceCriticWithRAG`, `enhanceEDLWithRAG` 확인 |

### 비디오팀 과제 11 — Refiner Agent

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/refiner-agent.js` | ✅ |
| `node --check bots/video/scripts/test-refiner-agent.js` | ✅ |
| `node bots/video/scripts/test-refiner-agent.js` | ✅ `critic_report.json` 기준 실제 Refiner 실행, `subtitle changes=12`, `edl changes=0`, `audio=null`, `subtitle_corrected_v2.srt`, `refiner_result.json` 생성 |
| `node -e "... parseSrt(load subtitle_corrected_v2.srt) ..."` | ✅ 수정된 SRT `67 entries` 재파싱 확인 |
| `node -e "... loadEDL(edit_decision_list.json) ..."` | ✅ 수정 후 EDL 로드 확인 |

### 비디오팀 과제 10 — Critic Agent

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/critic-agent.js` | ✅ |
| `node --check bots/video/scripts/test-critic-agent.js` | ✅ |
| `node - <<'EOF' ... parseSrt / analyzeVideoStructure / calculateOverallScore ... EOF` | ✅ `67 entries`, `videoScore=100`, `sceneIssues=10` 확인 |
| `node bots/video/scripts/test-critic-agent.js` | ✅ 코드 점검 후 재실행, `score=78`, `pass=false`, `subtitle issues=18`, `audio LUFS=-14.96`, `scene issues=10`, `temp/critic_report.json` 생성 |

### 워커 웹 영상 편집 API + 프론트엔드

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node --check bots/video/scripts/render-from-edl.js` | ✅ |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ `--session-id`, `--pair-index` 확장 후 문법 확인 |
| `node --check bots/worker/web/server.js` | ✅ `/api/video` 라우터 연결 후 문법 확인 |
| `npm --prefix bots/worker/web run build` | ✅ `/video`, `/video/history` 포함 Next.js production build 통과 |
| `node -e "... 002-video-sessions.sql ..."` | ✅ `video_sessions`, `video_upload_files`, `video_edits` 확장 컬럼 마이그레이션 적용 |
| `node -e "... information_schema.columns ..."` | ✅ `video_sessions`, `video_upload_files`, `video_edits(session_id/pair_index/confirm_status/reject_reason)` 생성 확인 |
| `node --check bots/investment/team/athena.js` | ✅ |
| `node --check bots/investment/team/oracle.js` | ✅ |
| `node --check bots/investment/team/hermes.js` | ✅ |
| `node --check bots/investment/team/sophia.js` | ✅ |
| `node --check bots/investment/team/nemesis.js` | ✅ |
| `node --check bots/investment/team/luna.js` | ✅ |
| `node bots/investment/scripts/health-report.js --json` | ✅ `commander`, `crypto`, `domestic`, `overseas`, `reporter` 포함 13개 서비스 정상 확인 |
| `node --input-type=module -e "import { getBlockReason } from './packages/core/lib/billing-guard.js'; ..."` | ✅ `crypto`, `domestic`, `overseas` 모두 active guard 없음 확인 |
| `node --input-type=module -e "import fs from 'fs'; import billingGuard from './packages/core/lib/billing-guard.js'; ..."` | ✅ 오래된 `.llm-emergency-stop`가 자동 만료/삭제됨 확인 |

### /ops-health 루나 guard 범위·만료 시각 표시

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --check bots/orchestrator/lib/night-handler.js` | ✅ |
| `node --check bots/investment/scripts/health-report.js` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.orchestrator` | ✅ |
| `node bots/orchestrator/scripts/health-report.js --json` | ✅ `ai.orchestrator`, `gateway`, `ai.n8n.server` 정상 및 orchestrator health 정상 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `guardHealth.okCount=1`, `투자 LLM guard 없음` 정상 출력 확인 |
| `node --check bots/orchestrator/src/router.js` | ✅ |
| `node --check bots/orchestrator/lib/night-handler.js` | ✅ guard 본문 축약 포맷 유지 확인 |
| `node --check bots/investment/scripts/health-report.js` | ✅ guard 본문 축약 포맷 유지 확인 |

### 일간 매매 한도 차단 문구 명확화

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/capital-manager.js` | ✅ |
| `node --check bots/investment/team/hephaestos.js` | ✅ |
| `node --input-type=module -e "import { formatDailyTradeLimitReason } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ `초과: 현재 10건 / 한도 8건`, `도달: 현재 8건 / 한도 8건` 출력 확인 |

### 루나 알림 카드 구분선 10칸 축소

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --input-type=module -e "import { readFileSync } from 'fs'; ..."` | ✅ `DIVIDER='──────────'`, 길이 `10` 확인 |

### 모바일 알림 short-title 정리 + 스카 모니터 리로드 복구

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ |
| `node --check bots/investment/markets/crypto.js` | ✅ |
| `node --check bots/investment/markets/domestic.js` | ✅ |
| `node --check bots/investment/markets/overseas.js` | ✅ |
| `node --check bots/orchestrator/n8n/setup-ska-workflows.js` | ✅ |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `bash -n bots/reservation/scripts/reload-monitor.sh` | ✅ |
| `node bots/orchestrator/n8n/setup-ska-workflows.js` | ✅ `SKA-WF-01 일간 매출 요약`, `SKA-WF-03 주간 매출 트렌드` 재생성/활성화 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.crypto` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.domestic` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.overseas` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.commander` | ✅ |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ `ai.ska.naver-monitor` 재기동, PID `88807` 확인 |

### 워커 재무 탭 확장 + 업체 비활성화 운영 완결

| 테스트 | 결과 |
|--------|------|
| `node bots/worker/migrations/020-expenses.js` | ✅ `worker.expenses` 테이블 추가 완료 |
| `node bots/worker/migrations/021-company-deactivation-meta.js` | ✅ `deactivated_reason`, `deactivated_by` 컬럼 실제 반영 확인 |
| `node bots/worker/scripts/import-expenses-from-excel.js "...2025년 스터디카페_고정지출관리_월별.xlsx" "...2026년 스터디카페_고정지출관리_월별.xlsx"` | ✅ 2025 파일 `126건 적재 / 2건 skip`, 2026 파일 `63건 적재 / 0건 skip`, 총 매입 `189건 / 47,427,532원` 확인 |
| `node --input-type=module ... worker.companies count` | ✅ 활성 업체 `4건`, 비활성 `0건`, 전체 `4건` 확인 |
| `node --input-type=module ... worker.companies active rows` | ✅ `sssssss`, `test-company`, `test_company`, `master` 활성 업체 조회 확인 |
| `node --check bots/worker/lib/expenses-ai.js` | ✅ |
| `node --check bots/worker/lib/expenses-import.js` | ✅ |
| `node --check bots/worker/scripts/import-expenses-from-excel.js` | ✅ |
| `node --check bots/worker/web/app/sales/page.js` | ✅ |
| `node --check bots/worker/web/app/admin/companies/page.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ `web`, `nextjs`, `lead`, `task-runner`, API, websocket 정상 확인 |

### 워커 web 운영 화면 공용화 + 업무/일정/근태/매출 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/components/PromptAdvisor.js` | ✅ |
| `node --check bots/worker/web/components/DataTable.js` | ✅ |
| `node --check bots/worker/web/lib/document-attachment.js` | ✅ |
| `node --check bots/worker/web/app/dashboard/page.js` | ✅ |
| `node --check bots/worker/web/app/work-journals/page.js` | ✅ |
| `node --check bots/worker/web/app/schedules/page.js` | ✅ |
| `node --check bots/worker/web/app/attendance/page.js` | ✅ |
| `node --check bots/worker/web/app/sales/page.js` | ✅ |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ 프로세스(`web`, `nextjs`, `lead`, `task-runner`) 정상 확인. 재시작 직후 endpoint 경고는 warm-up 상태로 관측됨 |

### 워커 블로그 URL 입력의 발행일 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/server.js` | ✅ |
| `node --input-type=module ... blog.posts 54/55 정규화 재현` | ✅ `54`, `55`가 `publishDate=2026-03-19`, `needsUrl=true`, `publishDue=true`로 계산됨 확인 |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ `web`, `nextjs`, `lead`, `task-runner` 정상 확인 |

### 투자 validation 성과 반영 + 국내장 normal 2차 승격

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --input-type=module -e "import { isBlocked } from './packages/core/lib/billing-guard.js'; ..."` | ✅ 레거시 `investment` stop 파일 기준 `investment.normal=true`, `investment.validation=false` 확인 |
| `INVESTMENT_TRADE_MODE=validation node bots/investment/markets/domestic.js --force` | ✅ `214390 BUY 500000 자동 승인`, `최종 결과: 1개 신호 승인` 확인 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `crypto VALIDATION: PAPER 2건`, `domestic VALIDATION: LIVE 1건`, `validation 승격 후보` 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ 세 시장 `NORMAL / VALIDATION` 통합 피드백 및 validation 후보 출력 확인 |
| `node --check bots/investment/scripts/runtime-config-suggestions.js` | ✅ |
| `node bots/investment/scripts/runtime-config-suggestions.js --days=7` | ✅ domestic validation `approved 1 / executed 1 / LIVE 1` 반영 및 `normal 승격 후보` 출력 확인 |
| `node --input-type=module -e "import { getInvestmentRuntimeConfig } from './bots/investment/shared/runtime-config.js'; ..."` | ✅ `stockStarterApproveDomestic=450000`, `stockStarterApproveOverseas=300` 확인 |

### blog / worker 상시 서비스 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/blog/api/node-server.js` | ✅ |
| `node --check bots/worker/src/worker-lead.js` | ✅ |
| `node --check bots/worker/src/task-runner.js` | ✅ |
| `node bots/blog/scripts/health-report.js --json` | ✅ `node-server`, `node-server API` 정상 확인 |
| `node bots/worker/scripts/health-report.js --json` | ✅ `lead`, `task-runner` 정상 확인 |

### 재부팅 절차 개편

| 테스트 | 결과 |
|--------|------|
| `bash -n scripts/pre-reboot.sh` | ✅ |
| `bash -n scripts/post-reboot.sh` | ✅ |
| `bash scripts/post-reboot.sh --dry-run` | ✅ 드라이런 종료, `/tmp/post-reboot-followup.txt` 생성 및 전사 launchd 점검 흐름 확인 |
| `tail -n 80 /tmp/post-reboot.log` | ✅ 현재 로컬 상태 기준 `OK 5 / WARN 16 / FAIL 12`로 보고, 후속 `health-report --json` 재확인 필요 메시지 확인 |

### 루나 퍼널 계측 + 바이낸스 보수성 조정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ |
| `node --check bots/investment/team/luna.js` | ✅ |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `node --input-type=module -e "...getLunaRuntimeConfig(), getLunaParams()..."` | ✅ `binance live minConfidence=0.44`, `crypto debate=0.56/0.18`, `fastPath minCryptoConfidence=0.40` 확인 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `decision 퍼널 병목` 섹션에 시장별 `BUY / SELL / HOLD / executed / weak / risk / saved` 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ `의사결정 퍼널 병목` 섹션에 시장별 `BUY / SELL / HOLD / executed / weak / risk / saved` 출력 확인 |

## 2026-03-18

### 자동화 리포트 개선

| 테스트 | 결과 |
|--------|------|
| `node --check bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅ |
| `node --check scripts/reviews/jay-gateway-experiment-daily.js` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node scripts/reviews/jay-gateway-experiment-daily.js --json` | ✅ fallback 저장 보강 후 `snapshot / persisted / fallbackUsed / review` 확인 |
| `node -e "const {buildRun}=require('./scripts/reviews/jay-gateway-experiment-daily.js'); ..."` | ✅ `persisted=true`, `fallbackUsed=true`, `tmp/jay-gateway-experiments.jsonl` 확인 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ `activeIssues / historicalIssues / inputFailures` 분리 확인 |
| `node scripts/reviews/daily-ops-report.js` | ✅ 텍스트 리포트 섹션 분리 확인 |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `dbStatsStatus=partial`, `dbSourceErrors`, `llmUsageSource=session_usage_fallback` 확인 |
| `node scripts/reviews/jay-llm-daily-review.js` | ✅ partial 상태와 fallback 모델별 사용량 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ no-trade 운영 요약 + 주간 usage / 비용 경고 출력 확인 |
| `node scripts/reviews/ska-sales-forecast-weekly-review.js --days=7 --json` | ✅ `requestedDays / effectiveDays` 및 `actionItems` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ `actionItems` 출력 확인 |

### 모바일 알림 UX 정리

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/telegram-sender.js` | ✅ |
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --check bots/orchestrator/lib/batch-formatter.js` | ✅ |
| `node --check bots/investment/scripts/market-alert.js` | ✅ |
| `node --check bots/investment/scripts/pre-market-screen.js` | ✅ |
| 개인 Telegram 직접 전송 `ok=true` | ✅ |
| 그룹 Telegram 직접 전송 `ok=true` | ✅ |
| 루나 토픽 15 직접 전송 `ok=true` | ✅ |
| 실제 수신 화면에서 15자 구분선 1줄 유지 확인 | ✅ |
| 실제 수신 화면에서 테스트 메시지 헤더 중복 제거 확인 | ✅ |

### 워커 웹 `LLM API 현황` / `블로그 URL 입력` 운영 콘솔 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/worker/web/app/admin/monitoring/page.js` | ✅ |
| `node --check bots/worker/web/app/admin/monitoring/blog-links/page.js` | ✅ |
| `node --check bots/worker/web/components/Sidebar.js` | ✅ |
| `node --check bots/worker/web/components/AdminQuickNav.js` | ✅ |
| `cd bots/worker/web && npm run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |

### 워커 모니터링 + LLM API 선택

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/lib/llm-api-monitoring.js` | ✅ |
| `node --check bots/worker/lib/ai-client.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/worker/scripts/setup-worker.js` | ✅ |
| `cd bots/worker/web && npm run build` | ✅ |
| `node bots/worker/migrations/017-system-preferences.js` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ |
| `curl -s http://127.0.0.1:4001/admin/monitoring` | ✅ |

### 투자 실행 모드 / 실패 원인 구조화 / 덱스터 경고 보정

| 테스트 | 결과 |
|--------|------|
| `node bots/investment/scripts/trading-journal.js --days=7` | ✅ |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` (실제 PostgreSQL 환경) | ✅ |
| `node bots/claude/scripts/health-report.js --json` | ✅ |

### 스카 shadow 비교 모델 + 운영 리뷰 입력 구조

| 테스트 | 결과 |
|--------|------|
| `python3 -m py_compile bots/ska/src/runtime_config.py bots/ska/src/forecast.py` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ |
| 스카 daily forecast 실행 | ✅ |
| `forecast_results.predictions.shadow_model_name = knn-shadow-v1` 저장 확인 | ✅ |
| `forecast_results.predictions.shadow_yhat / shadow_confidence` 저장 확인 | ✅ |

### 워커 문서 재사용 상세/성과 추적

| 테스트 | 결과 |
|--------|------|
| `cd bots/worker/web && npm run build` | ✅ |
| `/documents` 목록 빌드 | ✅ |
| `/documents/[id]` 상세 빌드 | ✅ |
| 문서 재사용 이력/성과 카드 렌더링 경로 빌드 | ✅ |

### 문서 체계 정리

| 테스트 | 결과 |
|--------|------|
| `SESSION_CONTEXT_INDEX.md`에서 새 문서 체계 링크 확인 | ✅ |
| `README.md` 문서 시작 순서 반영 확인 | ✅ |
| `PLATFORM_IMPLEMENTATION_TRACKER.md` rename 후 링크 경로 확인 | ✅ |

---

## 2026-03-08

### RAG 활용 완성 테스트 (커밋: 7630fc8)

| 테스트 | 항목 | 결과 |
|--------|------|------|
| A-1 | reporter.js → rag_operations 코드 존재 | ✅ |
| A-2 | doctor.js → rag_operations 코드 존재 | ✅ |
| A-3 | archer.js → rag_tech 코드 존재 | ✅ |
| A-4 | luna.js → rag_trades 코드 존재 | ✅ |
| A-5 | nightly git log → rag_tech | 🚫 의도적 제거 (아처와 중복) |
| B-1 | claude-lead-brain.js RAG 검색→LLM 프롬프트 주입 | ✅ |
| B-3 | claude-lead-brain.js shadow_log 후 RAG 저장 | ✅ |
| B-5 | luna.js RAG 검색→getSymbolDecision 프롬프트 주입 | ✅ |
| C-1 | Python 프로세스 0개 | ✅ |
| C-2 | 기존 plist 없음 | ✅ |
| C-3 | rag-system.deprecated 존재 | ✅ |
| C-4 | rag-server /health 응답 | ✅ |
| C-5 | 컬렉션 통계 (ops:1, trades:1, tech:1, docs:12) | ✅ |
| C-6 | system_docs 검색 정상 | ✅ |
| D-1 | 5개 파일 try-catch 보호 패턴 | ✅ |
| D-2 | 핵심 파일 5개 Node.js 문법 검사 | ✅ |
| D-3 | TP/SL OCO 안전장치 (luna, hephaestus) | ✅ |
| D-4 | archer.js RAG 삽입 순서 정상 | ✅ |
| E-1 | trades/ops/tech 실 저장·검색 동작 | ✅ |
| E-2 | operations 컬렉션 검색 응답 | ✅ |

**총계: 19/19 PASS (A-5 의도적 제외)**

---

## 2026-03-07

### Day 4 — 루나팀 매매일지 (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| insertJournalEntry 기록 | ✅ |
| insertRationale (tradeId, review) 기록 | ✅ |
| closeJournalEntry 청산 | ✅ |
| insertReview 사후평가 | ✅ |
| DuckDB 5개 테이블 생성 확인 | ✅ |
| schema_migrations v4 등록 | ✅ |

### Day 5 — OpenClaw 멀티에이전트 (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| team-comm sendToTeamLead | ✅ |
| team-comm getPendingMessages 수신 | ✅ |
| heartbeat.js require 정상 | ✅ |
| openclaw.json teamLeads 등록 | ✅ |
| SOUL.md 3개 생성 (ska/claude-lead/luna) | ✅ |
| 통합 검증 24/24 | ✅ |

### Day 6 — 독터 + 보안 + OPS/DEV (2026-03-07)

| 테스트 | 결과 |
|--------|------|
| doctor.js 화이트리스트 5개 canRecover | ✅ |
| rm-rf 블랙리스트 차단 | ✅ |
| DROP TABLE 블랙리스트 차단 | ✅ |
| 미등록 작업 거부 | ✅ |
| doctor_log 테이블 생성 + 이력 기록 | ✅ |
| mode-guard ensureOps DEV에서 차단 | ✅ |
| mode-guard ensureDev DEV에서 통과 | ✅ |
| deploy-ops.sh 5단계 확인 | ✅ |
| pre-commit secrets.json/config.yaml 차단 | ✅ |
| .gitignore secrets/config.yaml/db/key | ✅ |
| security.js pre-commit 훅 점검 추가 | ✅ |
| Day 6 검증 15/15 | ✅ |

### Day 7 — 통합 테스트 (2026-03-07)

| 카테고리 | 테스트 | 결과 |
|----------|--------|------|
| 스카팀 State Bus | emitEvent→markProcessed 사이클 | ✅ |
| 스카팀 State Bus | createTask→completeTask 사이클 | ✅ |
| 클로드팀 | 덱스터 퀵체크 | ✅ 이상 없음 |
| 클로드팀 | 독터 canRecover / 블랙리스트 / getAvailableTasks | ✅ |
| 클로드팀 | DexterMode Normal→Emergency→Normal | ✅ |
| 루나팀 | 매매일지 전체 사이클 (기록→판단→청산→평가) | ✅ |
| 크로스팀 | team-comm 클로드→스카 메시지 | ✅ |
| LLM 인프라 | llm-router selectModel | ✅ |
| LLM 인프라 | llm-cache 저장→히트 | ✅ |
| LLM 인프라 | llm-logger logLLMCall | ✅ |

### 안정화 기준선 v3.2.0 (2026-03-07)

| 항목 | 값 | 비고 |
|------|-----|------|
| 버전 | v3.2.0 | |
| state.db 테이블 수 | 17개 | reservations~doctor_log |
| 덱스터 체크 모듈 수 | 15개 | 11 기존 + 4 v2 신규 |
| 덱스터 전시스템 점검 | ✅ 이상 없음 | 2026-03-07 실행 |
| 덱스터 퀵체크 | ✅ 이상 없음 | |
| 스카팀 E2E | ✅ | State Bus 포함 |
| 루나팀 크립토 | ✅ OPS | PAPER_MODE=false |
| TP/SL OCO 설정률 | 100% | OPS 진입 시 필수 |
| 독터 화이트리스트 | 5개 | |
| 독터 블랙리스트 | 9개 | |
| LLM 일간 비용 | $0.00 | 기준일 기준 |
| 월간 예산 사용률 | 0% / $10 | |
| secrets 노출 | 0건 | |
| pre-commit 훅 | 설치됨 | |

---

## 2026-03-06

### Day 1 — State Bus + TP/SL OCO (16/16 ✅)

| 테스트 | 결과 |
|--------|------|
| State Bus emitEvent/getUnprocessedEvents | ✅ |
| State Bus createTask/completeTask | ✅ |
| TP/SL OCO 가격 계산 정확도 | ✅ |
| OCO PAPER_MODE 생략 | ✅ |
| 기존 E2E 27/27 | ✅ |

### Day 2 — 덱스터 v2 (16/16 ✅)

| 테스트 | 결과 |
|--------|------|
| DexterMode Normal→Emergency 전환 | ✅ |
| DexterMode Emergency→Normal 복귀 | ✅ |
| DexterMode 상태 파일 지속 | ✅ |
| team-leads.js 핵심 봇 점검 | ✅ |
| openclaw.js launchd+포트+메모리 | ✅ |
| llm-cost.js 예산 임계 | ✅ |
| workspace-git.js uncommitted 감지 | ✅ |
| dexter.js v2 모듈 통합 | ✅ |
| dexter-quickcheck.js v2 팀장 점검 | ✅ |

### Day 3 — llm-logger + llm-router + llm-cache (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| llm-logger: logLLMCall DB 기록 | ✅ |
| llm-logger: getDailyCost 비용 집계 | ✅ |
| llm-router: ska status_check → simple/Groq | ✅ |
| llm-router: luna trade_decision → complex/Sonnet | ✅ |
| llm-router: claude architecture_review → deep/Opus | ✅ |
| llm-router: 긴급도 상향 (ska simple → medium) | ✅ |
| llm-cache: getCached 미스 → null | ✅ |
| llm-cache: setCache + getCached 히트 | ✅ |
| llm-cache: getCacheStats 집계 | ✅ |
| llm-cache: cleanExpired 만료 삭제 | ✅ |
| state.db 테이블 자동 생성 (llm_usage_log, llm_cache) | ✅ |

### False Positive 수정 (2026-03-06)

| 수정 | 결과 |
|------|------|
| openclaw.js IPv6 `[::1]` 파싱 수정 | ✅ 실행 시 status: ok |
| dexter-quickcheck.js 수동 실행 | ✅ 이상 없음 |

---

## 2026-03-18

### 모바일 알림 최적화

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check packages/core/lib/telegram-sender.js` | ✅ |
| `node --check bots/orchestrator/lib/batch-formatter.js` | ✅ |
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --check bots/investment/team/reporter.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `renderNoticeEvent/buildReportEvent` 모바일 샘플 출력 확인 | ✅ 헤더/구분선/디테일 축약 확인 |

### 투자 설정 실험 적용/검증

| 테스트 | 결과 |
|--------|------|
| `apply-runtime-config-suggestion.js --id=498d9f9c-4725-460a-a5ea-129e82f3be19 --write` | ✅ 실제 운영 `config.yaml` 반영 |
| `validate-runtime-config-apply.js --id=498d9f9c-4725-460a-a5ea-129e82f3be19 --days=7 --json` | ✅ `review_status=applied`, 판단 `observe` |
| `launchctl list | egrep 'ai\\.investment\\.commander'` | ✅ commander 재기동 확인 |

### 세션 종료 정합성

| 테스트 | 결과 |
|--------|------|
| 세션 문서 업데이트 (`SESSION_HANDOFF`, `WORK_HISTORY`, `RESEARCH_JOURNAL`, `CHANGELOG`) | ✅ |
| `node bots/claude/src/dexter.js --update-checksums` | ✅ 65개 파일 갱신 |

### 자동화 리포트 해석력 보강

### 비디오팀 신규 문서 과제 정리

| 테스트 | 결과 |
|--------|------|
| `find /Users/alexlee/projects/ai-agent-system/bots/video/docs -maxdepth 1 -type f | sort` | ✅ `SESSION_HANDOFF_VIDEO.md`, `VIDEO_HANDOFF.md`, `video-automation-tech-plan.md`, `video-team-design.md`, `video-team-tasks.md` 존재 확인 |
| `find /Users/alexlee/projects/ai-agent-system/bots/video -maxdepth 2 -type d | sort` | ✅ `bots/video/scripts` 제거 후 `config/context/docs/lib/migrations/src`만 남은 폴더 구조 확인 |
| `rg -n "비디오팀 세션 컨텍스트|과제 1" /Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md` | ✅ handoff 문서의 비디오팀 섹션이 `문서 정리 완료 / 구현 스캐폴딩 시작 전` 상태와 과제 1 다음 단계로 갱신됨 |

| 테스트 | 결과 |
|--------|------|
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node --check packages/core/lib/health-runner.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `dbSourceStatus`에 `sandbox_restricted` 노출 확인 |
| `ls /Users/alexlee/projects/ai-agent-system/tmp/jay-llm-daily-review-db-snapshot.json` | ✅ 제이 DB snapshot fallback 파일 생성 확인 |
| `node scripts/reviews/jay-llm-daily-review.js --json` 재실행 | ✅ `dbSource=snapshot_fallback`, `dbSnapshotFallback=true` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ `requestedDays=5`, `effectiveDays=7` 확인 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ investment / reservation `localFallback.enabled=true` 확인 |
| `node scripts/reviews/daily-ops-report.js` | ✅ `보조 신호: local fallback 활동 신호 1건` 텍스트 출력 확인 |
| `node scripts/reviews/daily-ops-report.js --json` 재실행 | ✅ `sourceMode=unavailable(local teams) / local_fallback(investment,reservation) / auxiliary_review(global)` 확인 |
| `node scripts/reviews/daily-ops-report.js` 재실행 | ✅ active issue / input failure에 `sourceMode` 텍스트 출력 확인 |
| `plutil -lint bots/investment/launchd/ai.investment.crypto.plist` | ✅ OK |
| `plutil -lint bots/investment/launchd/ai.investment.crypto.validation.plist` | ✅ OK |
| `bash -n scripts/pre-reboot.sh` | ✅ 통과 |
| `bash -n scripts/post-reboot.sh` | ✅ 통과 |
| `node --check bots/investment/shared/capital-manager.js` | ✅ 통과 |
| `node --check bots/investment/team/nemesis.js` | ✅ 통과 |
| `node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ normal 바이낸스 정책 `reserve_ratio=0.02`, `max_position_pct=0.18`, `max_concurrent_positions=6`, `max_daily_trades=16` 확인 |
| `INVESTMENT_TRADE_MODE=validation node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ validation 바이낸스 정책 `reserve_ratio=0.01`, `risk_per_trade=0.01`, `max_position_pct=0.08`, `max_concurrent_positions=3`, `max_daily_trades=8` 확인 |
| `node --check bots/investment/shared/db.js` | ✅ 통과 |
| `node --check bots/investment/shared/trade-journal-db.js` | ✅ 통과 |
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ 통과 |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ 통과 |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ 통과 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `trade_journal.trade_mode` 마이그레이션 선행 후 `[LIVE][NORMAL]`, `[PAPER][NORMAL]` 태그와 `mode NORMAL` 퍼널 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ 주간 퍼널에 `mode NORMAL ...` 운영모드 집계 출력 확인 |
| `node --check bots/investment/markets/crypto.js` | ✅ `trade_mode`별 상태 파일 분리 로직 문법 확인 |
| `plutil -lint bots/investment/launchd/ai.investment.domestic.validation.plist` | ✅ OK |
| `plutil -lint bots/investment/launchd/ai.investment.overseas.validation.plist` | ✅ OK |

### 워커 매출 / 스카 동기화 및 페이지네이션 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/lib/ska-sales-sync.js` | ✅ 통과 |
| `node --check bots/worker/web/server.js` | ✅ 통과 |
| `node --check bots/worker/web/app/sales/page.js` | ✅ 통과 |
| `node --check bots/worker/web/components/DataTable.js` | ✅ 통과 |
| `node -e "syncSkaSalesToWorker('test-company')"` 1차 실행 | ✅ 누락분 `inserted: 124` backfill 확인 |
| `node --input-type=module -e "... worker.sales / reservation.daily_summary 총액 대조 ..."` | ✅ `28,847,500원`, 최신일 `2026-03-19` 일치 확인 |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ `2026-03-16~2026-03-18` 원천 데이터 복구 확인, 종료 시 CSV export `rows is not iterable` 잔여 오류 확인 |
| `node --input-type=module -e "... 2026-03-16~2026-03-19 daily_summary 확인 ..."` | ✅ `pickko_total/general_revenue` 기준 저장 확인 |
| `node --input-type=module -e "... 2026-01-01~2026-01-12 worker.sales 확인 ..."` | ✅ `test-company`의 1월 초 데이터가 이미 존재함을 확인 |
| `node -e "... daily_summary vs worker.sales mismatch check ..."` | ✅ `2026-03-19` 1건 mismatch 확인 후 `mismatchCount: 0`으로 재검증 완료 |
| `node -e "... room_amounts_json 있는데 pickko_study_room=0 인 날짜 탐지 ..."` | ✅ 이상치 37건 확인 |
| `node -e "... daily_summary pickko_study_room / pickko_total 원천 보정 ..."` | ✅ 원천 37건 복구 완료 |
| `node -e "syncSkaSalesToWorker('test-company')"` 2차 실행 | ✅ room JSON 기반 스터디룸 매출 `inserted: 37`, 최종 `expectedRows: 274` 확인 |
| `node -e "... room_amounts_json 기준 suspicious 재검사 ..."` | ✅ `suspiciousCount: 0` |
| `node --check bots/reservation/lib/db.js` | ✅ 통과 |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ 통과 |
| `node --check bots/reservation/scripts/health-report.js` | ✅ 통과 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `dailySummaryIntegrityHealth.issueCount=0`, `daily_summary 무결성: 스터디룸/일반/합계 구조 정상` 확인 |
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ 통과 |
| `node --check bots/investment/markets/crypto.js` | ✅ 통과 |
| `node --check bots/investment/markets/domestic.js` | ✅ 통과 |
| `node --check bots/investment/markets/overseas.js` | ✅ 통과 |
| `node --check bots/investment/shared/kis-client.js` | ✅ 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ 현재 `warnCount=0`, 루나 health 자체는 정상이나 최근 collect 경고는 enrichment/LLM 차단 계열 로그로 분리 확인 |
| `npm --prefix bots/worker/web run build` | ✅ 통과 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ 실행 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ 실행 |

### 스카 수동 처리 완료 루프 / 재시작 경고 정정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/manual/reports/pickko-alerts-resolve.js` | ✅ 통과 |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ 통과 |
| `node --check bots/reservation/lib/db.js` | ✅ 통과 |
| `node --check bots/orchestrator/src/router.js` | ✅ 통과 |
| `node bots/reservation/manual/reports/pickko-alerts-resolve.js --phone=010-4697-3620 --date=2026-03-20 --start=16:00` | ✅ 기존 미해결 오류 알림 `8건` 해결 처리 완료 확인 |
| `node --input-type=module -e "... reservation.alerts by phone/date/start ..."` | ✅ 동일 예약 과거 오류 알림이 모두 `resolved=1`, `resolved_at` 채워짐 확인 |
| `node --input-type=module -e "... reservation.reservations by phone/date/start ..."` | ✅ 대상 예약 `status=completed`, `pickko_status=time_elapsed`, `marked_seen=1` 확인 |
| `node --input-type=module -e "... unresolved error alerts ..."` | ✅ 현재 PostgreSQL 기준 unresolved error alerts `0건` 확인 |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ 스카 모니터 재시작 완료 (`PID: 6546`) |
| `node bots/orchestrator/scripts/health-report.js --json` | ✅ orchestrator / gateway / critical webhook 정상 |
| `launchctl kickstart -k gui/$(id -u)/ai.orchestrator` | ✅ 제이 완료 문구 처리 로직 라이브 반영 |

### 스카 headless 운영 문서 정합화

| 테스트 | 결과 |
|--------|------|
| `rg -n "PLAYWRIGHT_HEADLESS|playwright-headed|PICKKO_HEADLESS|NAVER_HEADLESS" docs/team-indexes/TEAM_SKA_REFERENCE.md docs/coding-guide.md docs/SYSTEM_DESIGN.md` | ✅ 스카 참조/가이드/설계 문서가 최신 headless 토글 정책을 공통 참조하도록 반영 확인 |
| `rg -n "PICKKO_HEADLESS=1" docs/team-indexes/TEAM_SKA_REFERENCE.md docs/coding-guide.md docs/SYSTEM_DESIGN.md` | ✅ `SYSTEM_DESIGN.md`의 고정 표현 제거, `coding-guide.md`는 legacy 호환 설명만 유지됨을 확인 |

### 비디오팀 CapCut readiness 체크

| 테스트 | 결과 |
|--------|------|
| `node bots/video/scripts/check-capcut-readiness.js` | ✅ `CapCut.app` 실행, `CapCutAPI` 응답, `create_draft / save_draft` 성공 확인 |
| `find /Users/alexlee/projects/CapCutAPI -maxdepth 2 -type d -name 'dfd_cat_*'` | ✅ repo 내부 `dfd_cat_*` draft 폴더 생성 확인 |
| `find "/Users/alexlee/Movies/CapCut/User Data/Projects/com.lveditor.draft" -maxdepth 2 -name 'dfd_*'` | ✅ Desktop 프로젝트 경로에는 새 draft 미생성 확인 |

### 비디오팀 과제 5 — CapCutAPI 드래프트 생성

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/capcut-draft-builder.js` | ✅ 문법 통과 |
| `node --check bots/video/scripts/test-capcut-draft.js` | ✅ 문법 통과 |
| `node bots/video/scripts/test-capcut-draft.js` | ✅ `healthCheck / createDraft / addVideo / addAudio / addSubtitle / saveDraft / findDraftFolder / copyToCapCut / buildDraft` 전체 통과 |
| `find /Users/alexlee/projects/CapCutAPI -maxdepth 2 -type d -name 'dfd_cat_1774019905_8be75a35'` | ✅ repo 내부 draft 생성 확인 |
| `find "/Users/alexlee/Movies/CapCut/User Data/Projects/com.lveditor.draft" -maxdepth 2 -name 'dfd_cat_1774019905_8be75a35'` | ✅ CapCut Desktop 프로젝트 디렉토리 복사 확인 |
| CapCut Desktop 프로젝트 목록 확인 | ✅ 새 draft 카드 표시 확인 |

### 비디오팀 과제 6 — 영상 분석 + EDL + FFmpeg 렌더링

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/video-analyzer.js` | ✅ 문법 통과 |
| `node --check bots/video/lib/edl-builder.js` | ✅ 문법 통과 |
| `node --check bots/video/scripts/test-video-analyzer.js` | ✅ 문법 통과 |
| `node --check bots/video/scripts/test-edl-builder.js` | ✅ 문법 통과 |
| `node -e "getMediaInfo('./bots/video/temp/synced.mp4')"` | ✅ `1920x1080`, `60fps`, `h264`, `48000Hz stereo`, `duration=4416.8` 확인 |
| `analyzer-smoke.mp4` 120초 샘플 생성 후 `analyzeVideo()` 실행 | ✅ `duration=120.033333`, `scenes=1`, 메타데이터 구조 확인 |
| smoke clip EDL 생성 + `buildPreviewCommand()` + `convertSrtToVtt()` | ✅ EDL 저장, preview 명령 생성, VTT 변환 확인 |
| smoke clip `renderPreview()` | ✅ `1280x720`, `60fps`, `AAC 128k`, `faststart` 확인 |
| smoke clip `renderFinal()` | ✅ `2560x1440`, `60fps`, `H.264 High`, `48kHz stereo`, `faststart` 확인 |
| `ffmpeg -hide_banner -filters | rg "drawtext|subtitles"` | ✅ 현재 로컬 FFmpeg에서 두 필터 미지원 확인, overlay / burn-in fallback 동작 확인 |

### 비디오팀 과제 7 — run-pipeline 1차 통합

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/src/index.js` | ✅ `loadConfig()` export 리팩터링 문법 통과 |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ 문법 통과 |
| `node -e "... parseArgs/resolveSources ..."` | ✅ `--source=1`이 `원본_파라미터.mp4` + `원본_나레이션_파라미터.m4a`로 매핑됨 확인 |
| `node -e "... pgPool.query('public', 'SELECT 1') ..."` | ✅ 로컬 DB 연결 확인 |
| `node bots/video/scripts/run-pipeline.js --source=1 --skip-render` | ⚠️ 실자산 기준 전처리 / STT / 자막교정 / 영상분석 / EDL 생성까지 통과, preview 렌더는 실제로 진행되지만 wall-clock이 길어 최종 종료까지는 추가 최적화 필요 |
| `analysis.json`, `edit_decision_list.json`, session temp 산출물 확인 | ✅ 실검증 session dir에 생성 확인 |
| 동시 2회 `node bots/video/scripts/run-pipeline.js --source=1 --skip-render` 실행 | ✅ 두 번째 실행이 `다른 video pipeline 실행이 이미 진행 중입니다`로 즉시 차단됨 확인 |
| lock 파일 `/Users/alexlee/projects/ai-agent-system/bots/video/temp/.run-pipeline.lock.json` | ✅ 검증 후 자동 해제 확인 |

### 스카 수동등록 후속 차단 / 취소 완결성 보강

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ 자동 취소 후 `--unblock-slot` 후속 실행 경로 문법 통과 |
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ manual follow-up 재시도 / slot verify 보강 문법 통과 |
| `node --check bots/reservation/lib/db.js` | ✅ `getOpenManualBlockFollowups()` 추가 후 문법 통과 |
| `node --check bots/reservation/manual/reservation/pickko-cancel-cmd.js` | ✅ 부분 성공 응답 분리 후 문법 통과 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `naver-monitor`, `kiosk-monitor`, `ska command webhook` 정상 확인 |
| 포그라운드 `pickko-kiosk-monitor.js --block-slot` 재현 | ✅ 이재룡 `2026-11-28 11:00~12:30 B`가 `already_blocked`로 수렴, 잘못된 슬롯 저장 위험은 slot guard로 차단 |
| `manual-block-followup-report.js --from=2026-03-21` + `manual-block-followup-resolve.js --all-open` | ✅ 운영자가 네이버에서 직접 처리한 8건을 `manually_confirmed / operator_confirmed_naver_blocked`로 원장 반영, `openCount=0` 확인 |
| `/tmp/naver-ops-mode.log` 취소 추적 | ⚠️ `취소감지4` 미래 예약 스캔 범위가 `2026-03-23~2026-05-21`로 보이며, `2026-11-28` 테스트 예약은 자동 취소 감지 범위 밖이라 end-to-end 자동 취소는 별도 재검증 필요 |

### 루나 암호화폐 weak signal 계측 보강

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ `weak_signal_reason_top`, `weak_signal_reasons` 계측 추가 후 문법 통과 |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ `weakTop` 출력 보강 후 문법 통과 |
| `node --check bots/investment/scripts/runtime-config-suggestions.js` | ✅ validation `weakTop` 요약 연결 후 문법 통과 |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ 주간 리뷰 `weakTop` 출력 보강 후 문법 통과 |
| `node bots/investment/scripts/trading-journal.js` | ✅ 일지 정상 출력, 기존 과거 meta에는 새 필드가 없어 `weakTop`이 아직 비어도 오류 없이 동작함 확인 |
| `node bots/investment/scripts/runtime-config-suggestions.js` | ✅ runtime_config 제안 정상 출력, 새 `weakTop` 필드가 없어도 validation 요약이 안전하게 유지됨 확인 |
| `node bots/investment/scripts/weekly-trade-review.js` | ✅ 주간 리뷰 정상 출력, 기존 집계 데이터와 호환됨 확인 |

### 루나 암호화폐 재진입 차단 코드 세분화

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/team/hephaestos.js` | ✅ `paper_position_reentry_blocked`, `live_position_reentry_blocked` 분리 후 문법 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ 국내/해외장 추가진입 차단 코드 세분화 후 문법 통과 |

### 루나 암호화폐 LIVE 게이트 리뷰

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/scripts/crypto-live-gate-review.js` | ✅ 문법 통과 |
| `node bots/investment/scripts/crypto-live-gate-review.js` | ✅ 최근 3일 기준 `decision 2236 / BUY 344 / approved 247 / executed 48 / PAPER 48 / LIVE 0 / weak 99 / 종료 리뷰 0` 확인, LIVE 게이트 `blocked` 출력 |

### 루나 운영 헬스 — 암호화폐 LIVE 게이트 통합

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/scripts/health-report.js` | ✅ `cryptoLiveGateHealth` 통합 후 문법 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `cryptoLiveGateHealth.warnCount=1`, `liveGate.decision=blocked`, 운영 판단에 `암호화폐 LIVE 게이트 blocked` 포함 확인 |

### LLM speed test 실패 원인 분류 / 모델 레지스트리 정리

| 테스트 | 결과 |
|--------|------|
| `node --check scripts/speed-test.js` | ✅ 전 모델 실패 / 저장 실패 exit 처리, Gemini thinking budget 분기 추가 후 문법 통과 |
| `node --check scripts/reviews/llm-selector-speed-daily.js` | ✅ 실패 상세 노출 보강 후 문법 통과 |
| `node --check scripts/reviews/llm-selector-speed-review.js` | ✅ 최신 실패 모델 / `errorClass` 노출 보강 후 문법 통과 |
| `node scripts/speed-test.js` (실측) | ✅ `gemini-2.5-pro` 정상 측정 복구, `gemini-2.5-flash-lite` 신규 성공, 최신 실패는 `google-gemini-cli/gemini-2.5-flash | rate_limited` 1건만 남음 |
| `node scripts/reviews/llm-selector-speed-review.js` | ✅ 최신 recommended `groq/openai/gpt-oss-20b`, 최신 실패 `gemini-2.5-flash | rate_limited` 1건으로 정리됨 확인 |
| `node scripts/reviews/llm-selector-speed-daily.js --skip-test --json` | ✅ `primaryHealth=rate_limited`, `latestPrimaryResult.errorClass=rate_limited` 노출 확인 |
| `node scripts/reviews/llm-selector-speed-review.js` (후속) | ✅ `primaryFallbackCandidate=google-gemini-cli/gemini-2.5-flash-lite` 노출 확인 |
| `node scripts/reviews/llm-selector-speed-daily.js --skip-test --json` (후속) | ✅ `primaryFallbackPolicy.decision=temporary_fallback_candidate`, `consecutivePrimaryIssues=3` 확인 |
| `~/.openclaw/openclaw.json` 모델 레지스트리 갱신 | ✅ `gemini-2.5-flash-lite` 추가, `groq/moonshotai/kimi-k2-instruct-0905` 교체, `cerebras/gpt-oss-120b` 제거 완료 |
| `docs/GEMINI_FLASH_TEMPORARY_FALLBACK_POLICY_2026-03-22.md` 작성 | ✅ `flash -> flash-lite` 임시 전환 조건 / 금지 조건 / 롤백 조건 / 관찰 절차 문서화 완료 |
## 2026-03-22 — 스카 자동 모니터링 로직 정렬 / kiosk-monitor 재가동

| 명령 | 결과 |
| --- | --- |
### 2026-03-25 — worker-web auth-ready 로딩 / 상태 UI 표준화

| 명령 | 결과 |
| --- | --- |
| `node --check bots/worker/web/app/sales/page.js` | ✅ 매출 페이지 auth-ready 이후 로드 / 공통 상태 UI 적용 후 문법 통과 |
| `node --check bots/worker/web/app/dashboard/page.js` | ✅ 대시보드 auth-ready 이후 로드 / 공통 상태 UI 적용 후 문법 통과 |
| `node --check bots/worker/web/app/attendance/page.js` | ✅ 근태 페이지 auth-ready 이후 로드 / 공통 상태 UI 적용 후 문법 통과 |
| `node --check bots/worker/web/app/payroll/page.js` | ✅ 급여 페이지 auth-ready 이후 로드 / 공통 상태 UI 적용 후 문법 통과 |
| `node --check bots/worker/web/app/admin/users/page.js` | ✅ 사용자 관리 auth-ready 이후 로드 / 공통 상태 UI 적용 후 문법 통과 |
| `node --check bots/worker/web/lib/use-auth-ready-request.js` | ✅ 공통 auth-ready 요청 훅 문법 통과 |
| `node --check bots/worker/web/lib/use-operations-loader.js` | ✅ 공통 operations loader 훅 문법 통과 |
| `node --check bots/worker/web/components/OperationsLoadState.js` | ✅ 공통 loading/error/empty/notice 상태 컴포넌트 문법 통과 |
| `npx next build` | ✅ `bots/worker/web` 최신 worker-web auth-ready / operations state 표준화 빌드 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ 최신 worker-web 번들 기준 재기동 성공 |
| `node bots/claude/src/dexter.js --update-checksums` | ✅ 덱스터 체크섬 베이스라인 재갱신 완료 (`bots/claude/.checksums.json`) |

| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ 네이버 신규 예약 write-path 가드 제거 + 자동 취소 `unblock-slot` 후속 제거 문법 통과 |
| `node - <<'NODE' ... OBSERVE_ONLY/PICKKO_ENABLE/SAFE_DEV_FALLBACK grep ... NODE` | ✅ `naver-monitor.js` OPS 자동 경로에서 3가지 가드와 취소 `OBSERVE_ONLY` 필터 잔존 없음 확인 |
| `node --check bots/reservation/manual/reservation/pickko-cancel-cmd.js` | ✅ 수동 취소 command 단순화 문법 통과 |
| `node --check bots/reservation/lib/manual-cancellation.js` | ✅ 취소 contract 정리 문법 통과 |
| `launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/ai.ska.kiosk-monitor.plist"` | ✅ `ai.ska.kiosk-monitor` launchd 등록 성공 |
| `launchctl kickstart -k gui/$(id -u)/ai.ska.kiosk-monitor` | ✅ `kiosk-monitor` 수동 기동 성공 |
| `launchctl print gui/$(id -u)/ai.ska.kiosk-monitor` | ✅ `pid=49161`, `state=xpcproxy` 확인 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `kiosk-monitor: 정상 (PID 49161)` |
| `tail -n 120 /tmp/pickko-kiosk-monitor.log` | ✅ 실제 `pickko-kiosk-monitor.js`가 기동되어 신규/재시도/취소 목록 조회와 네이버 차단 시도까지 수행함 확인 |

### 2026-03-22 — 스카 픽코 등록 실패 단계 분해 계측

| 명령 | 결과 |
| --- | --- |
| `node --check bots/reservation/manual/reservation/pickko-accurate.js` | ✅ 단계 코드 마커 추가 후 문법 통과 |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ `runPickko()` 실패 단계 파싱 추가 후 문법 통과 |
| `MODE=ops node bots/reservation/manual/reservation/pickko-accurate.js --phone=abc --date=bad --start=19:00 --end=20:00 --room=A1` | ✅ `PICKKO_FAILURE_STAGE=INPUT_NORMALIZE_FAILED` 마커 실제 출력 확인 |

### 2026-03-22 — 스카 manual block follow-up 원장 정정 / corrected slot 리포트 보강

| 명령 | 결과 |
| --- | --- |
| `node --check bots/reservation/manual/reports/manual-block-followup-report.js` | ✅ corrected slot 출력 보강 후 문법 통과 |
| `node bots/reservation/manual/reports/manual-block-followup-report.js` | ✅ `count=12`, `openCount=6`, `correctedCount=3` 출력 확인 |
| `node --input-type=module -e \"... getKioskBlock('01035000586','2026-03-28','13:00') ...\"` | ✅ `naverBlocked=false`, `operator_invalidated`, `operator_reconciled_not_reserved` 확인 |
| `node --input-type=module -e \"... getKioskBlock('01037410771','2026-04-01','08:00') ...\"` | ✅ 기존 잘못된 row가 `operator_reconciled_time_mismatch`로 invalidated 처리된 것 확인 |
| `node --input-type=module -e \"... getKioskBlock('01037410771','2026-04-01','09:00') ...\"` | ✅ corrected actual slot row가 `09:00~11:20`, `operator_confirmed_actual_slot`로 저장된 것 확인 |

### 2026-03-22 — 스카 kiosk_blocks 키 v2 재설계 / 재예약 충돌 완화

| 명령 | 결과 |
| --- | --- |
| `node --check bots/reservation/lib/crypto.js` | ✅ |
| `node --check bots/reservation/lib/db.js` | ✅ |
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ |
| `node --check bots/reservation/manual/reports/manual-block-followup-report.js` | ✅ |
| `node --check bots/reservation/migrations/007_kiosk_block_key_v2.js` | ✅ |
| `node bots/reservation/scripts/migrate.js --status` | ✅ `v007 kiosk_block_key_v2` 미적용 상태 확인 |
| `node bots/reservation/scripts/migrate.js` | ✅ `v007 kiosk_block_key_v2` 적용 완료, 스키마 `v7` 확인 |
| `node bots/reservation/manual/reports/manual-block-followup-report.js` | ✅ 마이그레이션 후에도 `count=12`, `openCount=6`, `correctedCount=3` 유지 확인 |
| `node --input-type=module -e \"... hashKioskKey('...09:00','13:00','A1') vs hashKioskKey('...09:00','11:00','A1') ...\"` | ✅ v2 해시 서로 다름, legacy `phone|date|start` 단일 키 충돌 해소 확인 |
| `node --check bots/reservation/scripts/test-kiosk-block-key-v2.js` | ✅ |
| `node bots/reservation/scripts/test-kiosk-block-key-v2.js` | ✅ 실제 DB 트랜잭션 + rollback 기준 `rowCount=2`, `v2Keys.distinct=true` 확인 |
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `freshness.level`, `freshness.trust`, `freshness.summary` 노출 확인 |
| `node scripts/reviews/jay-llm-daily-review.js` | ✅ `운영 신뢰도` 라인과 stale snapshot 참고용 경고 출력 확인 |
| `node --check bots/investment/scripts/force-exit-runner.js` | ✅ KIS capability preflight 추가 후 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ `kisCapabilityHealth` 섹션 추가 후 문법 통과 |
| `node bots/investment/scripts/force-exit-runner.js --symbol=375500 --exchange=kis` | ✅ 국내장 preview에 `LIVE/MOCK`, `장외 시간`, `mock 장중 SELL 가능` 경고가 함께 출력됨 |
| `node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas` | ✅ 해외장 preview에 `LIVE/MOCK`, `mock SELL 제한`, `미국 장외 시간` 경고가 함께 출력됨 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `kisCapabilityHealth.domestic/overseas`와 capability 요약이 JSON에 반영됨 |
| `node --check bots/investment/team/hanul.js` | ✅ executor preflight 추가 후 문법 통과 |
| `env PAPER_MODE=false node bots/investment/team/hanul.js --symbol=375500 --action=SELL --amount=444500` | ✅ 국내장 executor가 브로커 호출 전 `장외 시간`을 사전 차단함 |
| `env PAPER_MODE=false node bots/investment/team/hanul.js --symbol=ORCL --action=SELL --amount=983.4` | ✅ 해외장 executor가 브로커 호출 전 `미국 장외 시간`을 사전 차단함 |
| `node --check bots/reservation/lib/ska-command-handlers.js` | ✅ `store_resolution` alert resolve 보강 후 문법 통과 |
| `node --check bots/reservation/scripts/dashboard-server.js` | ✅ webhook `store_resolution` alert resolve 보강 후 문법 통과 |
| `node --input-type=module -e \"... handlers.store_resolution({ phone:'010-4572-0846', date:'2026-04-04', start:'16:30' }) ...\"` | ✅ `RAG 저장 완료 / 미해결 오류 알림 없음` 또는 해소 건수 포함 응답 확인 |
| `node bots/reservation/manual/reports/pickko-alerts-query.js --unresolved --phone=010-4572-0846 --date=2026-04-04 --start=16:30` | ✅ unresolved 0건 확인 |
| `node --check bots/blog/lib/gems-writer.js` | ✅ 젬스 이어쓰기 중복 섹션 정리 로직 추가 후 문법 통과 |
| `python3 - <<'PY' ... bots/blog/output/*_general_*.html ... 'AI 스니펫 요약'/'본론 섹션'/'함께 읽으면 좋은 글' count 점검 ... PY` | ✅ `2026-03-21_general_도서리뷰 그릿 꾸준함의 힘을 배우다.html`에서 주요 섹션 2회 반복 샘플 재현 확인 |
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ mid-gap validation 승격 경계 문법 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ 투자팀 헬스 리포트 정상, 서비스 warn 0 / crypto gate blocked 유지 |
| `node --check bots/investment/scripts/health-report.js` | ✅ capital guard 분해 리포트 문법 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `capitalGuardBreakdown` 섹션 노출, `daily trade limit=63`, `validation=59` 확인 |
| `node --check bots/investment/shared/capital-manager.js` | ✅ `trade_mode`별 capital config / open position slot 분리 적용 후 문법 통과 |
| `node --check bots/investment/team/hephaestos.js` | ✅ BUY 안전 게이트 / 알림의 `trade_mode`별 슬롯 계산 정합화 후 문법 통과 |
| `node --input-type=module -e \"... getCapitalConfig('binance','normal') / getCapitalConfig('binance','validation') ...\"` | ✅ `normal=6/16`, `validation=3/10` 정책값 분리 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ 투자팀 헬스 재검증, `BINANCE / normal 0/16`, `BINANCE / validation 0/10` lane 기준 유지 확인 |
| `node --check bots/investment/scripts/force-exit-candidate-report.js` | ✅ 해외장 mock SELL readiness를 `guarded/wait_market_open` 기준으로 정리한 뒤 문법 통과 |
| `node --check bots/investment/scripts/force-exit-runner.js` | ✅ 해외장 mock SELL preflight를 guarded 레일로 완화한 뒤 문법 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ 해외장 mock SELL 선차단 제거 후 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ 해외장 capability 문구를 `mock SELL 장중에만 가능`으로 조정 후 문법 통과 |
| `node bots/investment/scripts/force-exit-candidate-report.js --json` | ✅ force-exit 후보 `4건`, 전부 `kis_overseas`, `waitMarketOpen=4`, `blockedByCapability=0` 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `kisCapabilityHealth.overseas`가 `mock SELL 장중에만 가능`, stale 포지션이 해외장 4건만 남은 상태 확인 |
| `node --check bots/investment/shared/secrets.js` | ✅ 국내장 기본 dynamic cap `15 -> 10` 축소 후 문법 통과 |
| `node --check bots/investment/team/aria.js` | ✅ `데이터 부족` 로그를 `이력 부족으로 스킵` 톤으로 조정 후 문법 통과 |
| `node --input-type=module -e \"... getDomesticScreeningMaxDynamic() ...\"` | ✅ 실제 읽히는 국내장 dynamic cap 값 `10` 확인 |
| `node --check bots/claude/lib/checks/database.js` | ✅ `trade_review` ratio-scale false-positive SQL 보정 후 문법 통과 |
| `node --check bots/reservation/scripts/health-report.js` | ✅ raw Picco mismatch 집계 추가 후 문법 통과 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `cancelCounterDriftHealth`가 `실예약 기준 미반영 취소: 1건`과 `010-3157-4920 / 2026-04-05 / 10:00~12:30 / A2` 샘플을 노출 |
| `node -e \"... require('./bots/claude/lib/checks/database.js').run() ...\"` | ✅ escalated 실행 기준 `investment trade_review 무결성: 종료 거래 19건 정상`, `investment 미처리 신호 (2h+): ok` 확인 |
| `node -e \"... clearPatterns('investment trade_review 무결성','DB 무결성') ...\"` | ✅ escalated 실행 기준 stale dexter pattern `1건` 삭제 |
| `node --check bots/investment/scripts/crypto-live-gate-review.js` | ✅ crypto LIVE gate 문구를 validation LIVE 현실에 맞게 정렬한 뒤 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ 투자팀 health에 `mode 체결` 라인 추가 후 문법 통과 |
| `node bots/investment/scripts/crypto-live-gate-review.js --json` | ✅ `trade_mode별 체결: NORMAL 8 / VALIDATION 4`, `validation LIVE 표본은 있으나 PAPER 검증 표본이 부족` 문구 반영 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `cryptoLiveGateHealth.warn`에 `mode 체결: NORMAL ... VALIDATION ...`와 새 gate reason 노출 확인 |
| `node -e \"... SELECT ... FROM trades ... LIMIT 12\"` | ✅ escalated 조회 기준 최근 binance 체결 12건 전부 `paper=false`, validation 4건도 `is_paper=false` 확인 |
| `bots/investment/docs/VALIDATION_LANE_POLICY.md` 작성 | ✅ `trade_mode`와 `paper`를 분리한 투자팀 정책 기준선 문서 추가, 현재 crypto `validation LIVE` 해석을 source of truth로 고정 |
| `node --check bots/investment/team/hanul.js` | ✅ KIS `40070000 / 매매불가 종목`을 `mock_untradable_symbol`로 분류하는 block code 보강 후 문법 통과 |
| `node --check bots/investment/shared/runtime-config.js` | ✅ `mockUntradableSymbolCooldownMinutes` 기본값 추가 후 문법 통과 |
| `node --check bots/investment/shared/db.js` | ✅ `getRecentBlockedSignalByCode()` helper 추가 후 문법 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ 국내장 `LIVE/MOCK` BUY에 `mock_untradable_symbol` 24시간 쿨다운을 추가한 뒤 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ `mock_untradable_symbol` / `mock_untradable_symbol_cooldown` 관찰 섹션 추가 후 문법 통과 |
| `node --check bots/investment/scripts/backfill-signal-block-reasons.js` | ✅ `--mode=reclassify` 추가 후 문법 통과 |
| `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=30 --dry-run` | ✅ `updated=1`, 대상 `002630`, `domestic_order_rejected -> mock_untradable_symbol` 재분류 예정 확인 |
| `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=30` | ✅ `002630` 실패 1건 실제 재분류 완료 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `mockUntradableSymbolHealth.total=1`, `002630 mock 주문 불가 1건`, 운영 판단에 `최근 24시간 KIS mock 주문 불가 종목 1건` 반영 확인 |
| `node --check bots/investment/team/nemesis.js` | ✅ 국내장 `kis + BUY + mock 계좌`에서 최근 `mock_untradable_symbol` 이력을 `mock_untradable_symbol_recent`으로 승인 거부하도록 보강 후 문법 통과 |
| `node --check bots/investment/markets/domestic.js` | ✅ 자동 screening/prescreened 경로에서 최근 `mock_untradable_symbol` 후보를 제외하고, `appendHeldSymbols()` 전에 적용해 held 심볼은 유지하도록 보강 후 문법 통과 |
| `node --check bots/investment/scripts/pre-market-screen.js` | ✅ 국내장 장전 prescreen 저장 전에 최근 `mock_untradable_symbol` 후보를 제외하도록 보강 후 문법 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ 국내장 주문 실패를 `broker_rate_limited`, `market_closed`, `quote_lookup_failed`, `mock_untradable_symbol`로 세분화한 뒤 문법 통과 |
| `node --check bots/investment/scripts/backfill-signal-block-reasons.js` | ✅ 국내장 `domestic_order_rejected` 재분류 확장 후 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ `domesticRejectBreakdown` 섹션 추가 후 문법 통과 |
| `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=30 --dry-run` | ✅ 과거 국내장 `domestic_order_rejected` 10건이 `broker_rate_limited`/`quote_lookup_failed`/`mock_untradable_symbol`로 재분류 가능한지 확인 |
| `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=30` | ✅ 최근 30일 국내장 실패 이력 10건을 새 subtype으로 실제 재분류 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `domesticRejectBreakdown`가 최근 24시간 국내장 주문 실패를 subtype으로 요약하고, 운영 판단 reason에 반영되는지 확인 |
| `node --check bots/investment/shared/kis-client.js` | ✅ KIS 요청 lane을 `quote` / `order`로 분리하고 주문 간격을 보수적으로 상향한 뒤 문법 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ KIS pending signal 간 간격을 `1100ms`로 상향한 뒤 문법 통과 |
| `node --check bots/investment/scripts/health-report.js` | ✅ 국내장 err 로그 최근 200줄을 집계하는 `domesticCollectPressure` 섹션 추가 후 문법 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `domesticCollectPressure`가 `overload 17 / wide 17 / debate 17 / data_sparsity 156 / 외부 시세 실패 6`를 노출하고 운영 판단 reason에 반영되는지 확인 |
## 2026-03-26 — crypto validation soft budget guard

- `node --check bots/investment/shared/runtime-config.js` ✅
- `node --check bots/investment/team/nemesis.js` ✅
- `node --input-type=module -e "import { getValidationSoftBudgetConfig } from './bots/investment/shared/runtime-config.js'; console.log(JSON.stringify(getValidationSoftBudgetConfig('binance')));"` ✅
  - 결과: `{"enabled":true,"reserveDailyBuySlots":2}`
- `node bots/investment/scripts/health-report.js --json` ✅
  - 기존 health 구조 정상 유지 확인
  - 현재 `tradeLaneHealth` 기준 `BINANCE / validation 3/10`

## 2026-03-26 — crypto validation soft budget health

- `node --check bots/investment/scripts/health-report.js` ✅
- `node bots/investment/scripts/health-report.js --json` ✅
  - `cryptoValidationSoftBudgetHealth.count = 3`
  - `hardCap = 10`
  - `softCap = 8`
  - `warnCount = 0`
- `node bots/investment/scripts/health-report.js` ✅
  - `■ crypto validation soft budget(오늘)` 섹션 출력 확인

## 2026-03-26 — 투자팀 CRITICAL 텔레그램 중복 완화

- `node --check packages/core/lib/reporting-hub.js` ✅
- `node --check bots/investment/shared/report.js` ✅
- `node bots/investment/scripts/health-report.js --json` ✅
  - 기존 investment health 구조 영향 없음 확인
  - 최근 active block은 여전히 `mock_operation_unsupported = 1`로 유지

## 2026-03-26 — runtime-config 제안 리포트 soft budget 정렬

- `node --check bots/investment/scripts/runtime-config-suggestions.js` ✅
- `node bots/investment/scripts/runtime-config-suggestions.js --json` ✅
  - `validationBudgetSnapshots.cryptoValidation.count = 3`
  - `softCap = 8`
  - `hardCap = 10`
- `node bots/investment/scripts/runtime-config-suggestions.js` ✅
  - `validation budget 스냅샷(오늘)` 섹션 출력 확인

## 2026-03-26 — crypto validation soft cap 차단 집계

- `node --check bots/investment/scripts/health-report.js` ✅
- `node bots/investment/scripts/health-report.js --json` ✅
  - `cryptoValidationBudgetBlockHealth.total = 0`
  - `ok[0] = 최근 crypto validation soft cap 차단 없음`
- `node bots/investment/scripts/health-report.js` ✅
  - `■ crypto validation soft cap 차단(최근 24시간)` 섹션 출력 확인
