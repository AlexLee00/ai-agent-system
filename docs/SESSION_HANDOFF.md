# 세션 핸드오프

> 다음 세션은 먼저 [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)를 읽고 이 문서를 보세요.
> 현재 active risk / watch / recently resolved만 빠르게 보려면 [ACTIVE_OPS_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/docs/ACTIVE_OPS_SUMMARY.md)를 함께 확인하세요.

> 세션 마감 준비 메모 (2026-03-22)
> `bots/claude/.checksums.json`은 이번 세션 말미에 다시 갱신됐다.
> 다만 현재 워킹트리에는 비디오 외 `orchestrator / reservation / ska`의 미커밋 변경이 함께 남아 있으므로, 체크섬은 “현재 dirty workspace 기준 최신 상태”로 해석해야 한다.

---

## 2026-03-26 22:56 KST — 해외장 mock SELL capability 실검증 후 차단 정책 복구

- 요청 배경:
  - 해외장 stale 4건(`ORCL`, `NVTS`, `HIMS`, `NBIS`)은 한때 `guarded_ready`로 분류돼 미국 장중 mock SELL 검증이 가능한 것처럼 보였다.
  - 실제로 [force-exit-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-runner.js)로 `ORCL` force-exit를 실행해 본 결과, KIS가 `KIS API 오류 [90000000]: 모의투자에서는 해당업무가 제공되지 않습니다.`를 반환했다.
- 반영:
  - [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
    - `90000000 / 모의투자에서는 해당업무가 제공되지 않습니다`를 `mock_operation_unsupported`로 분류
  - [force-exit-candidate-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-candidate-report.js)
    - 해외장 mock SELL 후보를 `guarded_ready`가 아니라 `blocked_by_capability`로 되돌림
  - [force-exit-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-runner.js)
    - 해외장 mock SELL preflight를 장중이어도 `blocked`로 처리
  - [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - 해외장 capability 문구를 `mock SELL 미지원 (KIS 90000000)`로 수정
  - [backfill-signal-block-reasons.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/backfill-signal-block-reasons.js)
    - `kis_overseas` + `90000000`도 `mock_operation_unsupported`로 소급 재분류 가능하도록 확장
    - 실제로 ORCL 2건, 과거 `375500 장종료` 1건을 재분류
- 의미:
  - 해외장 stale 4건은 이제 “장중 대기”가 아니라 **실제 브로커 capability 제약**으로 읽어야 한다.
  - 현재 source of truth는 미국 장중 여부가 아니라 `KIS 모의투자 해외 SELL 미지원`이다.
- 검증:
  - `env PAPER_MODE=false node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --execute --confirm=force-exit`
    - `KIS API 오류 [90000000]: 모의투자에서는 해당업무가 제공되지 않습니다.`
  - `node --check bots/investment/team/hanul.js`
  - `node --check bots/investment/scripts/force-exit-candidate-report.js`
  - `node --check bots/investment/scripts/force-exit-runner.js`
  - `node --check bots/investment/scripts/health-report.js`
  - `node --check bots/investment/scripts/backfill-signal-block-reasons.js`
  - `node bots/investment/scripts/force-exit-candidate-report.js --json`
  - `node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --json`
  - `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=7`
  - `node bots/investment/scripts/health-report.js --json`
- 남은 TODO:
  - 해외장 stale 4건은 현재 mock 계좌로는 정리 불가
  - real 계좌 전환 또는 정책 예외 레일이 없는 한 force-exit 자동화 대상에서 제외하는 방향 검토

---

## 2026-03-26 22:48 KST — 투자팀 국내장 수집 압력 health 최신 cycle 정렬

- 요청 배경:
  - `domesticCollectPressure`는 err tail 200줄 누적 집계라 최신 runtime 개선이 바로 반영되지 않았다.
  - 실제 최신 domestic cycle은 [investment-domestic.log](/tmp/investment-domestic.log) 기준 `symbols=11`, `tasks=34`, `failed=0`까지 내려왔는데도 health는 `overload 17 / wide 17 / debate 17 / data_sparsity 156`처럼 과장되어 보였다.
- 반영:
  - [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - `sliceLatestDomesticPressureWindow()` 추가
    - `readLastMatchingLine()` / `parseDomesticCollectMetrics()` 추가
    - `loadDomesticCollectPressure()`가 이제 최신 `debate_capacity_hot` 경계로 잘라낸 **최신 cycle block**과 `/tmp/investment-domestic.log`의 최신 수집 메트릭을 함께 사용
  - health/report 문구도 `최근 로그 200줄 기준`에서 `최신 cycle 기준`으로 변경
- 의미:
  - 투자팀 health가 과거 err 누적치가 아니라 현재 국내장 cycle의 실제 상태를 더 정확하게 읽게 됐다.
  - 현재 domestic collect pressure 해석 기준은
    - `symbols=11`
    - `tasks=34`
    - `overload=1`
    - `wide=1`
    - `debate=1`
    - `data_sparsity=2`
    다.
- 검증:
  - `node --check bots/investment/scripts/health-report.js`
  - `node bots/investment/scripts/health-report.js --json`
  - `node bots/investment/scripts/health-report.js`
- 남은 TODO:
  - 다음 domestic cycle에서도 `symbols/tasks`가 `10~11 / 34` 안팎으로 유지되는지 관찰
  - `overload=1`이 계속 반복되면 `max_dynamic=6` 또는 prescreen source 품질 점검으로 이어가기

---

## 2026-03-26 22:40 KST — 투자팀 국내장 dynamic universe 2차 축소

- 요청 배경:
  - `investment-domestic.err.log` 최근 200줄 기준 `wide_universe`, `collect_overload_detected`, `concurrency_guard_active`, `debate_capacity_hot`가 모두 `17회`로 묶여 있었다.
  - health 상단에 국내장 수집 압력을 노출한 뒤에도, 현재 active 병목은 “보이는가”보다 “실제 입력 폭이 과한가”에 가까웠다.
- 반영:
  - [config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)
    - `screening.domestic.max_dynamic: 10 -> 8`
  - [secrets.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
    - `getDomesticScreeningMaxDynamic()` fallback 기본값 `10 -> 8`
- 의미:
  - 국내장 자동화는 이제 prescreened/screening fallback/cached dynamic 후보를 최대 `8개`까지만 소비한다.
  - 이번 수정은 전면 재설계가 아니라, 이미 들어가 있는 `dynamic cap -> filterMockUntradable -> held merge` 흐름을 유지한 채 입력 폭만 한 단계 더 낮춘 2차 완화다.
- 검증:
  - `node --check bots/investment/shared/secrets.js`
  - `node --input-type=module -e "import { getDomesticScreeningMaxDynamic } from './bots/investment/shared/secrets.js'; console.log(getDomesticScreeningMaxDynamic());"` → `8`
  - `node bots/investment/scripts/health-report.js --json`
- 남은 TODO:
  - 다음 국내장 cycle에서 `domesticCollectPressure.counts`
    - `wideUniverse`
    - `collectOverload`
    - `debateCapacityHot`
    가 실제로 줄어드는지 확인
  - 여전히 높으면 `max_dynamic=6` 또는 prescreen source 품질 점검까지 검토

---

## 2026-03-26 18:40 KST — worker-web `/video`, `/video/editor` 단계형 편집 워크스페이스 1차 구현

- 요청 배경:
  - `/video`는 단계형 채팅 플로우가 어느 정도 정리됐지만, `/video/editor`는 아직 “준비가 끝난 결과를 보여주는 화면”에 가까워 사용자가 컷/효과를 단계적으로 확인하고 수정하는 편집 워크스페이스 구조가 부족했다.
  - 특히 상단 플레이어, 하단 타임라인, 우측 AI 패널의 시간축과 역할 분리가 흐려 편집기 신뢰도가 떨어졌고, 공통 shell/auth 로딩 경계 때문에 `/video/editor` 진입이 spinner/blank에 걸리는 현상도 반복됐다.
- 반영:
  - [cut-proposal-engine.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/cut-proposal-engine.js)
    - OCR/scene index 기반 불필요 구간 후보를 만드는 컷 제안 엔진 추가
  - [video-step-api.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/routes/video-step-api.js)
    - `cut review`, `effect review` 전용 generate/action/confirm 레일 추가
    - 컷 확정 결과를 이후 일반 step 생성 입력 `sync_map`과 finalize EDL에 반영
    - protected 원본 영상 `source-video`, 프레임 썸네일 `frame-preview` 경계 추가
  - [VideoChatWorkflow.jsx](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/VideoChatWorkflow.jsx)
    - `/video` 업로드/인트로/아웃트로/편집의도/요약 흐름을 초기 설정과 수정 모드로 분기
    - 원본 업로드는 `다음 단계` vs `변경사항 업로드` 구조로 정리하고, intro/outro 카드는 설정 후에도 유지
  - [ChatCard.jsx](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/ChatCard.jsx)
    - intro/outro/edit intent 입력 높이를 자동 확장으로 정리
    - 초기 설정과 수정 반영의 버튼 활성 규칙 분리
  - [EditorChatPanel.jsx](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/EditorChatPanel.jsx)
    - 컷 단계 액션 영역을 세로형 `프롬프트 -> 설명 -> 수정 전송 -> 컷 편집 확정` 구조로 정리
  - [TwickEditorWrapper.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/TwickEditorWrapper.js)
    - 상단 `원본 검수 플레이어`와 하단 `timeline-only Twick dock`로 역할 분리
    - 상단 커스텀 플레이어 도입으로 네이티브 video controls 간섭 제거
    - 컷 후보 선택, 플레이어/컨트롤러/타임라인 시간축 동기화 1차 적용
    - Twick DOM inline style/overflow를 후처리해 하단 폭/높이 오버플로우 경계 보강
  - [twick-editor-scoped.css](/Users/alexlee/projects/ai-agent-system/bots/worker/web/public/twick-editor-scoped.css)
    - Twick 내부 view/timeline/canvas/container의 폭·높이 경계 scoped override 추가
  - [page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/video/page.js), [page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/video/editor/page.js)
    - `useSearchParams()` 의존을 제거하고 client-side location parsing으로 변경
    - `/video/editor` mounted/dynamic import 로딩 게이트를 줄여 실제 편집기 렌더를 우선 노출
  - [app/_shell.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/_shell.js)
    - 비디오 작업 화면은 auth loading 중에도 provisional render 허용
  - [video-api.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/routes/video-api.js)
    - editor-ready / editor-failed 신호 경계와 start 복구 흐름 보강
  - [media-binary-env.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/media-binary-env.js), [run-pipeline.js](/Users/alexlee/projects/ai-agent-system/bots/video/scripts/run-pipeline.js), [render-from-edl.js](/Users/alexlee/projects/ai-agent-system/bots/video/scripts/render-from-edl.js), [test-phase3-batch.js](/Users/alexlee/projects/ai-agent-system/bots/video/scripts/test-phase3-batch.js)
    - media binary PATH 보강, batch/preview/render 경계 정리
- 의미:
  - `/video/editor`는 이제 “preview 결과 확인” 화면이 아니라 `컷 검토 -> 효과 검토 -> 일반 step` 단계형 편집 워크스페이스가 됐다.
  - 상단 플레이어 / 하단 타임라인 / 우측 AI 패널의 역할이 분리됐고, time source of truth를 하나로 맞추는 방향으로 정리됐다.
  - auth/shell/build/searchParams 경계를 복구해 `/video/editor` blank/spinner에 갇히던 문제를 줄였다.
- 검증:
  - `node --check bots/video/lib/cut-proposal-engine.js`
  - `node --check bots/video/lib/media-binary-env.js`
  - `node --check bots/video/scripts/render-from-edl.js`
  - `node --check bots/video/scripts/run-pipeline.js`
  - `node --check bots/video/scripts/test-phase3-batch.js`
  - `node --check bots/worker/web/app/_shell.js`
  - `node --check bots/worker/web/app/video/page.js`
  - `node --check bots/worker/web/app/video/editor/page.js`
  - `node --check bots/worker/web/components/ChatCard.jsx`
  - `node --check bots/worker/web/components/EditorChatPanel.jsx`
  - `node --check bots/worker/web/components/TwickEditorWrapper.js`
  - `node --check bots/worker/web/components/VideoChatWorkflow.jsx`
  - `node --check bots/worker/web/routes/video-api.js`
  - `node --check bots/worker/web/routes/video-step-api.js`
  - `npx next build` (`bots/worker/web`) 반복 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
  - `http://127.0.0.1:4001/video`, `http://127.0.0.1:4001/video/editor` 모두 `200`
- 남은 TODO:
  - 하단 타임라인에서 컷 요소 클릭/드래그까지 상단 플레이어와 완전 양방향 동기화
  - effect review 결과를 preview/finalize 렌더에 더 직접 반영
  - 우측 세부정보 패널과 AI 패널의 역할을 더 정밀하게 분리
  - 컷/효과 단계 action log를 DB 원장으로 승격

---

## 2026-03-25 23:59 KST — 투자팀 국내/해외 수집 범위 축소 + 데이터 부족 노이즈 분리 1차

- 요청 배경:
  - `/tmp/investment-domestic.err.log` 기준 `wide_universe`, `collect_overload_detected`, `concurrency_guard_active`, `debate_capacity_hot`가 반복되고 있었다.
  - 최신 국내장 runtime은 `symbols=22`, `tasks=67`로 암호화폐(`tasks=53`)보다 오히려 더 무거웠다.
  - 동시에 `데이터 부족 (1캔들)` 같은 신규/희소 심볼 경고가 실제 원천 API 장애처럼 같은 core failure 레일에 섞여 운영 해석을 흐리고 있었다.
- 반영:
  - [secrets.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
    - `screening.domestic.max_dynamic`, `screening.overseas.max_dynamic`를 읽는 getter 추가
  - [universe-fallback.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/universe-fallback.js)
    - 공용 `capDynamicUniverse()` 추가
  - [domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
    - prescreened/screening/cache/history/default 경로 모두 `max_dynamic` cap 후 held symbols 병합
  - [overseas.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js)
    - 같은 방식으로 `max_dynamic` cap 적용
  - [pipeline-market-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-market-runner.js)
    - `데이터 부족` 실패를 `data_sparsity_failures`로 별도 집계
    - `core_collect_failure_rate_high` 판단에서는 data sparsity를 제외
    - 대신 `data_sparsity_watch` 경고를 별도 요약 문구로 노출
- 의미:
  - 실제 장애와 신규/희소 심볼의 이력 부족을 같은 레벨의 “원천 API 오류”로 보지 않도록 경계를 분리했다.
  - 국내장/해외장도 암호화폐와 같은 `dynamic universe cap -> held merge` 패턴으로 수집 범위를 제어하게 됐다.
- 검증:
  - `node --check bots/investment/shared/secrets.js`
  - `node --check bots/investment/shared/universe-fallback.js`
  - `node --check bots/investment/shared/pipeline-market-runner.js`
  - `node --check bots/investment/markets/domestic.js`
  - `node --check bots/investment/markets/overseas.js`
  - `node --input-type=module -e "... getDomesticScreeningMaxDynamic/getOverseasScreeningMaxDynamic ..."`
  - `node --input-type=module -e "... capDynamicUniverse(['A','B','C','D'], 2, 'test') ..."`
  - `node --input-type=module -e "... summarizeCollectWarnings(['data_sparsity_watch'], { dataSparsityFailures: 7 }) ..."`
- 남은 TODO:
  - 다음 실제 국내장/해외장 cycle에서 `symbols`, `tasks`가 cap 적용 후 얼마나 줄었는지 확인
  - `data_sparsity_watch`가 health/report에도 따로 드러나야 하는지 후속 검토
  - 필요하면 국내장 `max_dynamic=15`를 더 낮추는 2차 튜닝 검토

## 2026-03-26 09:04 KST — 루나 `trade_review` false warning 복구

- 요청 배경:
  - 루나 헬스 알림이 `종료 거래 12건 중 1건 점검 필요`를 띄웠고, `trade_review` 정합성 이상으로 분류되고 있었다.
- 확인 결과:
  - 대상은 `TRD-20260319-001` (`KAT/USDT`, PAPER)
  - `pnl_percent_stored=0.2747`, `pnl_percent_expected=0.2747`
  - 실제 데이터는 정상인데 [validate-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/validate-trade-review.js)의 `0 < pnl_percent < 1` 휴리스틱이 `0.2747%` 같은 정상 저수익 거래를 `pnl_percent_ratio_scale`로 오판하고 있었다.
- 반영:
  - [validate-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/validate-trade-review.js)
    - 단순 절대값 기준 `isSuspiciousPercent()` 제거
    - 대신 `stored pnl_percent`가 `expected pnl_percent / 100`에 가깝게 저장된 경우만 `ratio_scale`로 분류하도록 `isRatioScaledPercent()`로 교체
- 의미:
  - 실제로는 정상인 저수익 거래를 health warning으로 과대 해석하던 false positive를 제거했다.
  - 이제 `trade_review` 경고는 실제 배율 저장 오류나 리뷰 누락에 더 가깝게 수렴한다.
- 검증:
  - `node --check bots/investment/scripts/validate-trade-review.js`
  - `node bots/investment/scripts/validate-trade-review.js --days=30`
    - `findings=0`
  - `node bots/investment/scripts/health-report.js --json`
    - `tradeReview.findings=0`
    - `decision.reasons`에서 `trade_review 정합성 이슈` 제거 확인

## 2026-03-26 09:12 KST — 덱스터 resolved pattern 정리 경계 복구

- 요청 배경:
  - 덱스터 유지보수 리포트가 여전히
    - `investment 미처리 신호 (2h+)`
    - `investment trade_review 무결성`
  반복 오류를 보여주고 있었지만, 현재 DB/헬스 기준으로는 둘 다 해소된 상태였다.
- 확인 결과:
  - `signals WHERE status IN ('pending','approved') AND created_at < now() - interval '2 hours'` 결과 `0건`
  - `validate-trade-review --days=30` 결과 `findings=0`
  - 그런데 [database.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/database.js)는 `investment 미처리 신호 (2h+)`가 0건일 때 동일 라벨의 `ok` 항목을 내보내지 않아, [error-history.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/error-history.js)의 `markResolved()`가 stale pattern을 지우지 못하고 있었다.
- 반영:
  - [database.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/database.js)
    - `investment 미처리 신호 (2h+)`가 0건일 때도 `ok` 항목을 추가하도록 수정
  - 현 시점 stale pattern은 직접 정리:
    - `clearPatterns('investment 미처리 신호 (2h+)')`
    - `clearPatterns('investment trade_review 무결성')`
- 의미:
  - 덱스터가 이미 해소된 DB 무결성 이슈를 계속 반복 error로 들고 있던 해석 지연 경계를 복구했다.
  - 다음 덱스터 실행부터는 이 두 항목이 다시 stale pattern으로 남지 않는다.
- 검증:
  - `node --check bots/claude/lib/checks/database.js`
  - `node --input-type=module -e "... clearPatterns('investment 미처리 신호 (2h+)') ... clearPatterns('investment trade_review 무결성') ..."`
    - `clearedPending=1`, `clearedTradeReview=1`
  - `node --input-type=module -e "... SELECT ... FROM dexter_error_log WHERE label LIKE ..."`
    - 결과 `[]`

---

## 2026-03-25 — worker-web 운영 화면 auth-ready 경계 / 공통 로더 / 상태 UI 표준화

- 요청 배경:
  - `/sales`와 `/dashboard`에서 실제 매출 원장은 정상인데도, 로그인 직후 프런트가 인증 준비 전에 fetch를 날리고 실패를 빈 데이터로 삼켜 “매출이 안 보이는” 현상이 있었다.
  - 같은 유형의 silent fallback이 `/attendance`, `/payroll`, `/admin/users`에도 잠재적으로 남아 있어 운영 핵심 화면 전반의 로딩 경계를 정리할 필요가 있었다.
- 반영:
  - [sales/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/sales/page.js)
  - [dashboard/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/dashboard/page.js)
  - [attendance/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/attendance/page.js)
  - [payroll/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/payroll/page.js)
  - [admin/users/page.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/admin/users/page.js)
  - [use-auth-ready-request.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/use-auth-ready-request.js)
    - `useAuth()`와 `worker_token`이 모두 준비된 뒤에만 요청을 실행하는 공통 auth-ready 경계를 제공한다.
  - [use-operations-loader.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/lib/use-operations-loader.js)
    - 운영 화면 공통 `loading / loadError / runLoad` 규약을 묶었다.
  - [OperationsLoadState.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/OperationsLoadState.js)
    - 공통 `error / retry / loading / empty / notice` UI를 표준화했다.
- 의미:
  - 인증 준비 전 실패를 실제 0건/빈 목록으로 오인하던 입력 경계를 복구했다.
  - 운영 핵심 화면이 로그인 직후에도 같은 규약으로 다시 로드되고, 실패 시 조용히 숨지 않고 명시적으로 드러난다.
  - 이후 다른 운영 화면도 같은 공용 레이어 위에 붙일 수 있는 기준선이 생겼다.
- 검증:
  - `node --check bots/worker/web/app/sales/page.js`
  - `node --check bots/worker/web/app/dashboard/page.js`
  - `node --check bots/worker/web/app/attendance/page.js`
  - `node --check bots/worker/web/app/payroll/page.js`
  - `node --check bots/worker/web/app/admin/users/page.js`
  - `node --check bots/worker/web/lib/use-auth-ready-request.js`
  - `node --check bots/worker/web/lib/use-operations-loader.js`
  - `node --check bots/worker/web/components/OperationsLoadState.js`
  - `npx next build` in `bots/worker/web`
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
- 현재 상태:
  - 워커웹 매출은 다시 정상 표시된다.
  - 이 계열 작업의 최종 커밋은 `e6f2676`, `5401d97`, `e83751e`, `775bd66`, `512ee86`이다.
  - `node bots/claude/src/dexter.js --update-checksums`로 `bots/claude/.checksums.json`을 다시 갱신했다.
  - 다만 현재 체크섬은 이번 워커웹 문서 반영 외에도 dirty workspace에 이미 존재하던 비디오 신규 파일 2건(`cut-proposal-engine.js`, `media-binary-env.js`)이 함께 반영된 상태다.

## 2026-03-24 — worker-web `/video`, `/video/editor` 실브라우저 점검 1차

- 요청 범위:
  - `/video` 단계형 질문/업로드 카드 유지/메뉴 왕복 상태 유지/버블 스크롤
  - 모바일 bottom nav `영상` alert
  - `/video/editor` 좌측 Twick + 우측 AI 채팅 패널
  - 콘솔 에러와 네트워크 실패
- 반영:
  - [VideoChatWorkflow.jsx](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/VideoChatWorkflow.jsx)
    - `intro_mode/outro_mode='none'`를 완료 증거로 보지 않도록 phase 계산 보수화
    - 업로드 후 stale `upload` phase가 localStorage에 남지 않도록 guard 추가
    - 업로드 카드 `다음 단계`의 phase 전환을 한 틱 뒤로 늦춤
  - [ChatCard.jsx](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/ChatCard.jsx)
    - intro/outro 카드 기본 선택을 빈 상태로 바꾸고, 명시 선택 전에는 `설정 반영` 비활성화
  - [layout.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/layout.js)
    - worker metadata icon 명시
  - [worker-favicon.svg](/Users/alexlee/projects/ai-agent-system/bots/worker/web/public/worker-favicon.svg)
  - [favicon.ico](/Users/alexlee/projects/ai-agent-system/bots/worker/web/public/favicon.ico)
- 확인된 것:
  - `/video/editor`는 desktop 기준 Twick/AI 패널 모두 정상, 콘솔/네트워크 오류 없음
  - 모바일 bottom nav `영상` 클릭 alert 정상
  - `/video`는 업로드 카드 유지, 메뉴 왕복 상태 유지, 버블 스크롤 정상
  - build 완료 전에 재기동하면 chunk 404가 날 수 있고, build 완료 후 재기동으로 해소됨
- 아직 남은 리스크:
  - `/video` 업로드 직후 intro를 건너뛰고 outro 단계로 진입하는 현상이 Puppeteer 기준 계속 재현된다.
  - 세션 상세 API를 보면 새 세션은 `intro_mode='none'`, `outro_mode='none'`로 저장되므로, 남은 원인은 서버값보다 프런트 단계 전이/submit 경계 쪽일 가능성이 높다.
  - 다음 세션은 `VideoChatWorkflow`에서 intro card mount 직후 어떤 경로로 `setChatPhase('outro')`가 실행되는지 추가 계측하는 것이 자연스럽다.

## 2026-03-24 — worker-web `/video` 단계형 채팅 경계 복구 2차

- 추가 반영:
  - [VideoChatWorkflow.jsx](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/VideoChatWorkflow.jsx)
    - 채팅 버블을 과거 로그 누적형에서 현재 단계 질문 1개만 보이는 구조로 정리
    - 업로드 카드에 표시하는 파일명을 UTF-8 복구 + `NFC` 정규화 경계로 통일
    - 분해형 한글 자모(`원...`)까지 한글로 인식하도록 정규화 범위를 확장
  - [video-api.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/routes/video-api.js)
    - 새 업로드 파일명의 `original_name` 저장 시 `latin1 -> utf8 -> NFC` 복구를 적용
- 확인:
  - 최신 `video_upload_files.original_name` 저장값을 직접 조회해 `áá¯...` 패턴으로 깨진 값이 들어가 있음을 확인
  - 같은 값을 복구 함수에 통과시키면 `원본_나레이션_파라미터.m4a`, `원본_나레이션_컴포넌트스테이트.m4a`로 정상 복원됨을 확인
  - `npx next build` 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`, `ai.worker.web` 재기동 성공
- 의미:
  - 기존 세션의 깨진 한글 파일명은 프런트 표시 경계에서 복구
  - 이후 새 세션은 서버 저장 경계에서 정규화해 downstream 원장 신뢰도를 높임

## 2026-03-23 — 비디오팀 Phase 3 과제 F `step-proposal-engine`

- [step-proposal-engine.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/step-proposal-engine.js)를 추가했다.
  - `generateSteps(syncMap, config, options)`
  - `attachRedEvaluation(steps, config)`
  - `attachBlueAlternative(steps, sceneIndex, config)`
  - `applyUserAction(steps, stepIndex, action, modification)`
  - `stepsToSyncMap(steps)`
  - `saveSteps/loadSteps`
- [video-config.yaml](/Users/alexlee/projects/ai-agent-system/bots/video/config/video-config.yaml)에 `step_proposal` 섹션을 추가했다.
- 의미:
  - Phase 2의 `sync_map`를 Phase 3의 편집 스텝 원장으로 바꾸는 핵심 백엔드 레이어가 열렸다.
  - 이후 Twick UI와 `video-step-api`는 이 `steps[]`를 기준으로 사용자 판단/피드백을 붙이면 된다.
- 검증:
  - `node --check bots/video/lib/step-proposal-engine.js` 성공
  - temp에 실산출 `sync_map.json`은 없어서 더미 `sync_map` 기준 `generateSteps`/`stepsToSyncMap` 검증 수행
  - intro/outro 포함 `4`스텝 생성, 역변환 시 `matches` 수 일치 확인

## 2026-03-23 — 비디오팀 Phase 3 과제 G `video-feedback-service`

- [video-feedback-service.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/video-feedback-service.js)를 추가했다.
  - `ensureVideoFeedbackTables()`
  - `createVideoStepFeedbackSession()`
  - `getVideoFeedbackSessionForStep()/ById()`
  - `record/replaceVideoFeedbackEdits()`
  - `markVideoFeedbackConfirmed/Rejected/Submitted/Committed()`
- [006-feedback-sessions.sql](/Users/alexlee/projects/ai-agent-system/bots/video/migrations/006-feedback-sessions.sql)을 추가했다.
  - `video.ai_feedback_sessions`
  - `video.ai_feedback_events`
  - `video.video_edit_steps`
- 의미:
  - Phase 3의 `steps[]` 사용자 판단을 워커 피드백과 같은 구조로 저장하되, 비디오 도메인에 맞는 `video` 스키마와 `edit_step` 소스 기준으로 분리했다.
  - `packages/core`를 수정하지 않는 제약 때문에, 서비스 내부에서 `public` 풀 기반 어댑터를 사용하고 SQL은 `video.*` 테이블을 명시적으로 가리키도록 경계를 맞췄다.
  - 이후 `video-step-api`는 이 서비스를 통해 `accepted_without_edit`, 수정 필드 diff, RAG 학습 데이터를 바로 누적할 수 있다.
- 검증:
  - `node --check bots/video/lib/video-feedback-service.js` 성공
  - 로컬 PostgreSQL 실검증 기준 `ensureVideoFeedbackTables()` + `createVideoStepFeedbackSession()` + `markVideoFeedbackConfirmed()` 성공
  - 결과: `feedback_status=confirmed`, `accepted_without_edit=true`

## 2026-03-23 — 비디오팀 Phase 3 과제 F confidence 문자열 경계 복구

- [step-proposal-engine.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/step-proposal-engine.js)의 confidence 입력 경계를 보강했다.
  - `normalizeConfidence()`는 이제 문자열 `match_score` (`high` / `medium` / `low`)를 직접 해석한다.
  - `buildSyncProposal()`는 비숫자 `match_score`를 `0`으로 덮어쓰지 않고,
    - `match_score`: 정규화된 수치 confidence
    - `match_score_raw`: 원본 문자열값
    을 함께 보존한다.
- 의미:
  - 문자열 기반 sync 매칭 점수에서도 `auto_confirm` 분기가 정확하게 유지된다.
  - 사용자가 `confirm`만 한 경우에도 proposal/final 원장에서 원래 confidence 의미가 사라지지 않는다.
- 검증:
  - `normalizeConfidence({ match_score: 'high' }) === 0.85`
  - `generateSteps() -> stepsToSyncMap()` 왕복 기준 `proposal.match_score=0.85`, `proposal.match_score_raw='high'`, 역변환 `match_score=0.85` 확인

## 2026-03-23 — 비디오팀 feedback session missing guard 복구

- [video-feedback-service.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/video-feedback-service.js)의 `markVideoFeedbackStatus()`에 missing-session guard를 추가했다.
- 의미:
  - 존재하지 않는 `feedback_session_id`로 상태 전이를 호출해도 더 이상 PostgreSQL FK 오류가 그대로 노출되지 않는다.
  - `video-step-api`가 붙었을 때도 잘못된 입력은 도메인 오류로 안정적으로 처리할 수 있다.
- 검증:
  - `markVideoFeedbackConfirmed({ sessionId: 999999999 })` → `feedback_session_id=999999999 를 찾을 수 없습니다.`
  - 정상 세션 생성 후 confirm 흐름은 계속 `feedback_status=confirmed`, `accepted_without_edit=true`

## 2026-03-23 — 비디오팀 Twick CSS scoped 로딩 전환

- `/video/editor`의 `@twick/video-editor/dist/video-editor.css` 전역 import를 제거했다.
- [TwickEditorWrapper.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/components/TwickEditorWrapper.js)는 이제 `/twick-editor-scoped.css`를 mount 시 `<link>`로 로드하고 unmount 시 제거한다.
- [scope-twick-css.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/scripts/scope-twick-css.js)는 Twick 충돌 클래스(`.btn-primary`, `.card`, `.flex`, `.gap-*`, `.text-sm` 등)에 `.twick-scope` 접두사를 붙여 [twick-editor-scoped.css](/Users/alexlee/projects/ai-agent-system/bots/worker/web/public/twick-editor-scoped.css)를 생성한다.
- 의미:
  - `/video/editor` 방문 뒤 `/dashboard`로 돌아가도 Twick CSS가 worker 포털 전체에 남아 스타일을 깨뜨리던 전역 주입 경계를 복구
  - 비디오 편집기 스타일은 `.twick-scope` 내부와 해당 페이지 생명주기로 축소
- 검증:
  - `node bots/worker/web/scripts/scope-twick-css.js` 성공
  - `npx next build` 성공
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` 성공
  - `http://127.0.0.1:4001/dashboard`, `/video`, `/video/editor` 모두 `200`
- 남은 리스크:
  - CLI만으로는 `/video/editor` 방문 후 다시 `/dashboard`로 이동했을 때의 실제 시각 회귀를 완전 증명하진 못했다
  - 다음 단계로 브라우저에서 route 이동(`dashboard -> video/editor -> dashboard`) 1회만 직접 확인하면 된다

## 2026-03-23 — 비디오팀 Twick CSS 경계 복구 1차

- [bots/worker/web/app/globals.css](/Users/alexlee/projects/ai-agent-system/bots/worker/web/app/globals.css)의 전역 media reset에서 `video`, `canvas`를 제외했다.
  - 이전: `img, svg, video, canvas { max-width: 100%; height: auto; }`
  - 현재: `img, svg { max-width: 100%; height: auto; }`
- 의미:
  - worker 공용 전역 CSS가 Twick preview/timeline 캔버스 크기 계산에 간섭할 수 있는 경계를 줄인 단계
  - 비디오 도메인 렌더는 Twick 내부 스타일과 컴포넌트 레이아웃이 우선하도록 정리
- 검증:
  - `npx next build` 성공
  - `http://127.0.0.1:4001/`, `/video`, `/video/editor` 모두 `200`
- 남은 리스크:
  - Twick CSS 자체가 `.flex`, `.text-sm`, `.w-full` 같은 범용 클래스를 정의하므로 `/video/editor` 라우트에서 미세한 shell 스타일 충돌 가능성은 남아 있음
  - 다음 단계로는 브라우저에서 `/video/editor`를 열어 Header/Sidebar/Twick 타임라인이 함께 정상인지 시각 확인하는 것이 자연스럽다

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

## 2026-03-23 — 루나 장기 미결 LIVE 포지션 health 경고 추가

- 투자팀 운영 점검 결과, 현재 병목은 단순 `TP/SL 미확인`보다 장기 미결 LIVE 포지션 누적이었다.
  - Binance LIVE normal: `ROBO/USDT 101.3h`
  - 국내장 LIVE normal: `375500 75.5h`, `006340 72.5h`
  - 해외장 LIVE normal: `ORCL 278.0h`, `HIMS/NBIS/NVTS 256.0h`
- [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)에 `stalePositionHealth`를 추가했다.
  - `paper=false`인 LIVE 포지션만 대상으로 집계
  - 기본 threshold:
    - `binance`: 48h
    - `kis`: 48h
    - `kis_overseas`: 72h
  - threshold를 넘는 포지션은 `장기 미결 LIVE 포지션` 섹션과 운영 판단 이유에 직접 노출
- 현재 리포트 기준:
  - `stalePositionHealth.warnCount = 7`
  - 운영 판단에 `장기 미결 LIVE 포지션 7건 — force-exit/정리 기준 점검 필요`가 추가됨
- 의미:
  - force-exit 정책이 아직 없는 상태에서도, 적어도 운영 health가 “지금 무엇을 정리해야 하는지”를 먼저 드러내도록 보강한 단계
  - 다음 phase는 이 경고를 기준으로 시장별 정리 우선순위를 정하고, 실제 force-exit/cleanup 정책을 설계하는 흐름이 자연스럽다
- 정책 초안은 [INVESTMENT_FORCE_EXIT_MIN_POLICY_2026-03-23.md](/Users/alexlee/projects/ai-agent-system/docs/INVESTMENT_FORCE_EXIT_MIN_POLICY_2026-03-23.md)에 정리했다.
  - `binance=48h`, `kis=48h`, `kis_overseas=72h`를 최소 stale threshold로 보고
  - 현재 후보는 `ROBO/USDT`, `375500`, `006340`, `ORCL`, `HIMS`, `NBIS`, `NVTS` 7건이다.

## 2026-03-23 — 루나 force-exit 후보 리포트 추가

- 장기 미결 LIVE 포지션을 실제 정리 우선순위로 읽기 위한 read-only 레일을 추가했다.
  - [force-exit-candidate-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-candidate-report.js)
  - 목적:
    - 시장별 stale threshold를 기준으로 `force_exit_candidate` / `strong_force_exit_candidate`를 정리
    - 아직 자동 cleanup runner가 없어도 운영자가 같은 기준으로 수동 정리 우선순위를 잡을 수 있게 함
- 현재 기준:
  - `binance=48h`, `kis=48h`, `kis_overseas=72h`
  - `priorityScore`로 후보를 정렬
  - `--json`과 human-readable 출력 둘 다 지원
- 운영 DB 기준 검증 결과:
  - 총 후보 `7건`
  - strong 후보 `5건`
  - 시장별:
    - 해외장 `4건 / 2383.88`
    - 국내장 `2건 / 3140700`
    - 암호화폐 `1건 / 191.90`
  - 우선순위 상위:
    - `ORCL`
    - `NVTS`
    - `HIMS`
    - `NBIS`
    - `ROBO/USDT`
- 구현 포인트:
  - sandbox에서는 `db.initSchema()`가 `EPERM`으로 막힐 수 있어 read-only 보고 경계에서 이를 허용
  - 운영 DB 권한에서는 정상 실행되며 실제 후보를 출력함을 확인
- 의미:
  - force-exit 정책 문서가 추상 기준에 머물지 않고, 실제 정리 대상/우선순위를 운영 레일에서 바로 볼 수 있게 됐다
  - 다음 phase는 이 리포트를 기준으로 시장별 수동 정리 또는 승인형 cleanup runner를 붙이는 흐름이 자연스럽다

## 2026-03-23 — 루나 force-exit 승인형 runner 추가

- force-exit를 곧바로 자동화하지 않고, 기존 SELL executor를 재사용하는 승인형 실행 레일을 추가했다.
  - [force-exit-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-runner.js)
  - 기본값은 `preview-only`
  - 실제 실행은 `--execute --confirm=force-exit`가 있을 때만 동작
- 구조:
  - 후보 조회는 [force-exit-candidate-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-candidate-report.js)의 `loadCandidates()`를 재사용
  - 실행은 기존 executor를 그대로 사용
    - `binance` → `hephaestos.executeSignal()`
    - `kis` → `hanul.executeSignal()`
    - `kis_overseas` → `hanul.executeOverseasSignal()`
  - runner는 승인형 `SELL` synthetic signal을 만들고, 기존 trade/journal/notify 레일에 태운다
- 구현 보강:
  - [hephaestos.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hephaestos.js)
  - [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
  - 두 executor 모두 `exit_reason_override`를 받으면 기본 `sell/signal_reverse` 대신 그 값을 journal close reason으로 사용
  - `force-exit-candidate-report.js`는 이제 CLI direct 실행일 때만 `main()`이 동작해, runner import 시 side effect가 없다
- 현재 검증:
  - `ORCL / kis_overseas` preview 출력 정상
  - 실제 실행 명령 예시:
    - `env PAPER_MODE=false node bots/investment/scripts/force-exit-runner.js --symbol=ORCL --exchange=kis_overseas --execute --confirm=force-exit`
- 의미:
  - 지금 당장 필요한 구조:
    - 자동 cleanup 없이도 승인형 정리 레일을 운영에 도입 가능
  - 나중에 확장할 구조:
    - approval queue / batch cleanup / 시장별 runtime-config 정책으로 확장 가능

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
  - `2026-03-25` 기준으로 source of truth 용어를 다시 고정했다. `booking_total_amount = total_amount`, `recognized_total_revenue = general_revenue + pickko_study_room`이며, 운영/예측/worker 미러는 후자를 우선 기준으로 본다.
  - `bots/reservation/lib/ska-read-service.js`, `bots/reservation/scripts/dashboard-server.js`, `bots/reservation/scripts/dashboard.html`, `bots/reservation/scripts/export-ska-sales-csv.js`는 이제 두 축을 함께 노출한다. 대시보드 메인 숫자는 `recognized_total_revenue`, 보조 라인은 `booking_total_amount`로 본다.
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
  - 비디오팀 Phase 3 Twick 통합 1차를 진행했다. `bots/worker/web/app/video/editor/page.js`, `components/TwickEditorWrapper.js`를 추가하고 CSS import를 페이지로 이동, `next.config.js`의 `transpilePackages`로 `@twick/*` 4종을 보강했다.
  - `npm install tailwindcss`로 PostCSS/Tailwind 누락 경계를 복구했고 `npx next build`는 성공했다.
  - `ai.worker.nextjs` 재기동 후 실제 live 응답은 `http://127.0.0.1:4001/video/editor = 200`, `/video = 200`, `/ = 200`이다. 현재 worker-web 기준 live 포트는 `4001`이며 `localhost:3000`은 같은 라우트를 제공하지 않는다.
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
  - 팀 구조 결정 (2026-03-22): Phase 2 완료 후 bots/video → packages/video 승격,
    bots/blog → packages/blog 승격, bots/worker를 통합 웹 포털로 전환.
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
  - 2026-03-23 rerun 기준 `test-final-reference-quality-batch.js --json`은 `bots/video/temp/final_batch_report.json` 저장과 `per-set timeout skip`을 지원하도록 보강했다. 현재 로컬 머신에서는 `timeoutMs=300000` 기준 5세트 모두 `skipped_timeout`으로 종료돼, final batch는 전용 런타임 또는 더 긴 timeout/경량화 전략이 필요하다.
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

## 2026-03-23 — 루나 force-exit KIS capability preflight

- `bots/investment/scripts/force-exit-runner.js`는 이제 승인형 force-exit preview/execute 전에 KIS capability preflight를 함께 계산한다.
- 현재 기준 preflight 해석은 다음과 같다.
  - 국내장 `LIVE/MOCK`: 장중 SELL 검증은 가능하지만 장외/장종료 시 즉시 차단
  - 해외장 `LIVE/MOCK`: 현재 운영 관측 기준 SELL이 미지원 또는 제한 상태로 간주
- 따라서 stale 후보가 있어도 실행 가능성은 시장/세션/계좌 capability를 먼저 본다. 실제 `375500` preview는 `장외 시간 + 국내장 mock 장중 전용`, `ORCL` preview는 `해외장 mock SELL 제한 + 미국 장외 시간`을 함께 출력한다.
- `bots/investment/scripts/health-report.js`에도 `kisCapabilityHealth` 섹션을 추가해 국내/해외 KIS 계좌 모드와 현재 SELL 가능 범위를 운영 헬스에서 바로 읽게 했다.
- 현재 자연스러운 다음 단계는 force-exit 확대가 아니라 `KIS capability`를 전제로 stale 포지션 정리 우선순위를 다시 읽는 것이다. 국내장은 장중에만 검증 가능하고, 해외장은 여전히 preview 중심으로 본다.

## 2026-03-23 — 스카 `처리완료` 알림 해결 경계 복구

- 실제 운영에서 사장님이 `처리완료`를 보냈는데도 `reservation.alerts`의 error row가 `resolved=0`으로 남아, 이후 `naver-monitor` 재시작 요약에 같은 건이 다시 포함되는 문제가 확인됐다.
- 원인: `pickko-alerts-resolve.js` 직접 실행 경로는 정상인데, `store_resolution` 경로([ska-command-handlers.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/ska-command-handlers.js), [dashboard-server.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/dashboard-server.js))는 RAG 저장만 하고 실제 `alerts` 해소는 하지 않았다.
- 현재는 `store_resolution`도 `phone/date/start`가 있으면 해당 error alert만, 없으면 전체 미해결 error alert를 `resolved=1`로 마킹한 뒤 RAG를 저장한다.
- 따라서 앞으로는 direct resolve 경로를 놓쳐도 `store_resolution`만 타면 동일한 알림이 재시작 요약에 재등장하지 않아야 한다.

## 2026-03-23 — 한울 executor 장중/market capability 사전 차단

- `bots/investment/team/hanul.js`에도 KIS 실행 사전 차단을 추가했다. 이제 runner preview가 아니라 executor 본체도 국내/해외 장중 여부를 먼저 확인한 뒤 주문 API를 치기 전 실패를 반환한다.
- 국내장 `SELL/BUY`는 `getKisMarketStatus()` 기준으로 장외 시간에 즉시 `국내주식 장외 시간 ... — 장중에만 주문 실행 가능`으로 차단된다.
- 해외장은 `getKisOverseasMarketStatus()` 기준 장외 시간 차단을 먼저 적용하고, 이후 장중에는 mock SELL 제한 정책을 추가로 적용할 수 있는 구조로 정리했다.
- 목적은 broker reject를 사후 해석하는 것이 아니라, 장시간/시장 readiness 불변식을 실행 레일 안에서 먼저 보장하는 것이다.

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

## 2026-03-23 — 블로 젬스 일반 포스팅 이어쓰기 중복 섹션 방지

- 사용자 관찰 기준 “같은 일반 포스팅 내용을 두 번씩 써서 억지로 분량을 늘린다”는 현상을 블로 출력 샘플로 재확인했다.
- 실제 샘플:
  - [2026-03-21_general_도서리뷰 그릿 꾸준함의 힘을 배우다.html](/Users/alexlee/projects/ai-agent-system/bots/blog/output/2026-03-21_general_도서리뷰%20그릿%20꾸준함의%20힘을%20배우다.html)
  - `AI 스니펫 요약`, `본론 섹션 1/2/3`, `함께 읽으면 좋은 글`이 각 2회씩 들어가 있었다.
- 원인 판단:
  - 저장 중복이 아니라 [gems-writer.js](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/gems-writer.js)의 `general_post_continue` 응답이 완성본을 다시 시작하는 경우가 있었고,
  - 기존 로직은 `# 제목` 재시작만 감지해서 본문형 재시작을 놓쳤다.
- 조치:
  - 젬스 이어쓰기 전에 일반 포스팅 주요 섹션 마커(`AI 스니펫 요약`, `승호아빠 인사말`, `본론 섹션 1/2/3`, `함께 읽으면 좋은 글` 등)를 기준으로 continuation을 검사한다.
  - 이미 작성된 섹션부터 다시 시작하면:
    - 아직 안 나온 섹션이 있으면 그 섹션부터 잘라서 이어붙이고
    - 모두 이미 나온 섹션이면 continuation 전체를 버린다.
- 의미:
  - 지금 당장 필요한 구조는 `이어쓰기 append` 경계 복구다.
  - 나중에는 `gems` 일반 포스팅을 chunked generation 기본 경로로 승격하는 것도 검토할 수 있다.

## 2026-03-23 — 세션 마감 / 다음 전환 축

- 이번 라운드에서 운영 follow-up은 아래까지 정리됐다.
  - Gateway: `heartbeat 60m` 완화 반영과 cadence 개선 확인, 다음 자동화 리포트 관찰 대기
  - 스카: `처리완료 -> reservation.alerts resolve` 경계 복구 완료, 다음 실제 실패 케이스 운영 테스트 대기
  - 투자팀: stale LIVE / KIS capability / force-exit preflight 정리 완료, 다음 국내장 장중 검증 대기
  - 블로: 젬스 일반 포스팅 이어쓰기 중복 섹션 방지 경계 복구 완료, 다음 일반 포스팅 1건 관찰 대기
- 즉 현재 전사 운영은 “추가 수정”보다 “실제 운영 이벤트 기반 검증” 단계로 전환된 상태다.
- 다음 구현 축은 비디오팀으로 넘긴다.
  - 시작 전 source of truth:
    - [bots/video/docs/CLAUDE.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/CLAUDE.md)
    - [bots/video/docs/VIDEO_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/VIDEO_HANDOFF.md)
    - [bots/video/docs/video-team-design.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/video-team-design.md)
    - [bots/video/samples/ANALYSIS.md](/Users/alexlee/projects/ai-agent-system/bots/video/samples/ANALYSIS.md)
    - [bots/video/docs/video-team-tasks.md](/Users/alexlee/projects/ai-agent-system/bots/video/docs/video-team-tasks.md)
## 2026-03-25 23:15 KST — investment crypto mid-gap validation 승격

- [pipeline-decision-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/pipeline-decision-runner.js)에 `confidence_mid_gap` 전용 경계를 추가했다.
- 현재 정책:
  - `exchange=binance`
  - `investment_trade_mode=validation`
  - `action=BUY`
  - `weakReason=confidence_mid_gap`
  인 경우만 즉시 폐기하지 않고 validation 승격 후보로 통과시킨다.
- 승격된 mid-gap 신호는 주문금액을 50%로 축소하고, reasoning에 `mid-gap validation 승격` 태그를 남긴다.
- 파이프라인 메타에 아래 계측을 추가했다.
  - `mid_gap_promoted`
  - `mid_gap_rejected_by_risk`
  - `mid_gap_executed`
  - warning `mid_gap_validation_promoted`
- 아직 실제 런타임에서 `mid_gap_promoted > 0`가 찍힌 샘플은 없다. 다음 crypto cycle에서 메타가 실제로 쌓이는지 확인 필요.
## 2026-03-25 23:20 KST — investment health capital guard 분해

- [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)에 crypto `capital_guard_rejected` 분해 섹션을 추가했다.
- 리포트가 이제 최근 14일 binance capital guard를 아래 축으로 나눠 보여준다.
  - `daily trade limit`
  - `max positions`
  - 기타 guard reason
  - `trade_mode`별 건수
- 실제 현재 기준:
  - total `65건`
  - `daily trade limit = 63건`
  - `max positions = 2건`
  - `validation = 59건`
  - `normal = 6건`
- 해석:
  - crypto capital guard의 주 병목은 자본 부족이나 단일 주문 크기보다 validation 레인의 일간 매매 한도 소진이다.
  - 이후 validation 전용 budget 분리 검토가 자연스러운 다음 단계다.
## 2026-03-25 23:25 KST — investment capital guard trade_mode 슬롯 분리 적용

- [capital-manager.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/capital-manager.js)가 이제 `getCapitalConfig(exchange, tradeMode)`와 `getOpenPositions(exchange, paper, tradeMode)`를 지원한다.
- 기존에는 `getDailyTradeCount()`만 `trade_mode`별로 분리되고, BUY 전 포지션 슬롯 체크는 `getOpenPositions(exchange)`를 써서 validation과 normal/live가 같은 슬롯을 공유하고 있었다.
- 이번 수정 후:
  - `preTradeCheck()`는 `effectiveTradeMode` 기준 정책과 포지션 슬롯을 함께 읽는다.
  - `binance / validation`은 `max_concurrent_positions=3`, `max_daily_trades=10`
  - `binance / normal`은 `max_concurrent_positions=6`, `max_daily_trades=16`
  기준을 각각 적용한다.
- [hephaestos.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hephaestos.js)도 같은 경계를 따라:
  - BUY 안전 게이트
  - `capital_guard_rejected` 알림용 open position count
  - 실행 후 capital info
  를 `signal.trade_mode` 기준으로 계산하도록 정리했다.
- 의미:
  - 지금 당장 필요한 구조는 validation 레인이 normal/live 슬롯을 잠식하지 않게 하는 것이다.
  - 나중에는 validation 전용 daily budget/slot을 헬스 리포트와 runtime config suggestion에서 더 직접적으로 비교하는 구조로 확장할 수 있다.
## 2026-03-25 23:35 KST — hephaestos BUY 직후 TP/SL 보호주문 수량 정합성 복구

- 실제 운영에서 `RENDER/USDT` BUY 후 TP/SL 보호주문이 `Account has insufficient balance for requested action`으로 실패했다.
- 원인:
  - [hephaestos.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hephaestos.js)의 `placeBinanceProtectiveExit()`가 BUY 체결 `order.filled`를 그대로 OCO/SL 주문 수량으로 사용하고 있었다.
  - Binance spot에서는 수수료/lot step/잔고 반영 차이 때문에 `filled`와 실제 `free balance`가 살짝 어긋날 수 있다.
- 조치:
  - 보호주문 생성 직전에 base asset `free balance`를 다시 조회
  - `min(requestedAmount, freeBalance)` 기준으로 수량을 다시 맞춘 뒤 `amountToPrecision()`을 적용
  - 응답 메타에 `requestedAmount`, `freeBalance`, `effectiveAmount`, `reconciled`를 남겨 운영자가 drift를 바로 읽을 수 있게 했다.
- 의미:
  - 지금 당장 필요한 구조는 BUY 직후 보호주문도 SELL reconciliation과 같은 수준의 잔고 정합성을 따르게 하는 것이다.
  - 나중에는 TP/SL 실패 리포트에 `filled vs free balance` 차이를 health/report 섹션으로 직접 노출할 수 있다.
## 2026-03-26 09:31 KST — 해외장 mock SELL capability를 guarded 레일로 완화

- [force-exit-candidate-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-candidate-report.js), [force-exit-runner.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/force-exit-runner.js), [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js), [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)를 같은 기준으로 정리했다.
- 기존에는 `kis_overseas + mock + SELL`이면 리포트/preview/executor가 모두 `blocked_by_capability`로 선차단했다.
- 확인 결과 [kis-client.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/kis-client.js)에 `OVERSEAS_SELL_PAPER (VTTT1006U)`와 `marketSellOverseas()`가 이미 구현돼 있어, 기술적 미구현보다는 운영 정책 차단에 가까웠다.
- 이번 수정 후:
  - 해외장 mock SELL은 장외 시간에는 `wait_market_open`
  - 미국 장중에는 `guarded_ready`
  - `hanul` preflight도 시장만 열려 있으면 SELL을 선차단하지 않음
  - health 문구도 `현재 관측 기준 mock SELL 미지원 또는 제한` 대신 `mock SELL 장중에만 가능`으로 정리
- 현재 확인 결과:
  - 국내장 stale 7건은 모두 정리 완료
  - force-exit 후보는 `kis_overseas` 4건만 남음
  - 현재는 미국 장외라 `wait_market_open=4`, `blockedByCapability=0`
- 의미:
  - 지금 당장 필요한 구조는 해외장을 capability 오류가 아니라 시장 시간 기반 `guarded` 레일로 해석하는 것이다.
  - 나중에는 미국 장중 실제 `ORCL` 1건으로 mock SELL 검증 후, 해외장 guarded 정책을 고정 capability로 승격할 수 있다.
## 2026-03-26 09:40 KST — 국내장 로그 병목 완화 2차 (dynamic cap + data sparsity 톤다운)

- 최신 오류 로그 기준 국내장은 `wide_universe`, `collect_overload_detected`, `concurrency_guard_active`, `debate_capacity_hot`가 계속 묶여 나타났다.
- 동시에 [aria.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/aria.js)의 `데이터 부족 (1캔들)`이 실제 장애와 같은 톤으로 반복돼 운영 해석을 더럽히고 있었다.
- 조치:
  - [secrets.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)에서 국내장 기본 dynamic cap을 `15 -> 10`으로 축소
  - 실제 운영 설정 [config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)은 이미 `domestic.max_dynamic=10` 기준으로 읽히는 것을 재확인
  - [aria.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/aria.js)에서 `데이터 부족`은 `⚠️ 실패` 대신 `ℹ️ 이력 부족으로 스킵`으로 로그 톤 다운
- 의미:
  - 지금 당장 필요한 구조는 국내장 수집 폭을 더 줄이고, 희소 데이터 심볼을 원천 장애와 분리해서 읽는 것이다.
  - 나중에는 `data_sparsity_watch`를 health/report 상위 섹션으로 분리해 신규 ETF/ETN/희소 심볼을 별도 품질 큐로 다룰 수 있다.
## 2026-03-26 10:05 KST — 덱스터 오류 보고 경계 복구 (trade_review false positive 제거 + Picco 실제 미반영 노출)

- 덱스터 오류 보고를 재점검한 결과, `investment trade_review 무결성`과 `Picco 취소 실패`가 같은 방식의 stale 패턴이 아니었다.
- 실제 확인:
  - [validate-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/validate-trade-review.js) 기준 종료 거래 `19건`, `findings=0`
  - [database.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/database.js)는 여전히 `ABS(pnl_percent) < 1` 기반 SQL을 써서 `0.2747%` 같은 정상 소수 수익도 `pnl_percent 스케일 이상`으로 오판하고 있었다.
  - 반면 reservation DB에는 `010-3157-4920 / 2026-04-05 / 10:00~12:30 / A2` 건이 여전히 `future completed + cancelled_key`로 남아 있어 `Picco 취소 실패`는 실제 unresolved 이슈였다.
- 조치:
  - [database.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/database.js)의 `badPercentScale` SQL을 `pnl_amount / entry_value` 기반 ratio-scale 판정으로 교체해 `validate-trade-review.js`와 같은 기준으로 맞췄다.
  - [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js)의 `buildCancelCounterDriftHealth()`가 기존 alert 로그뿐 아니라 `cancelled_keys + future completed reservations` raw mismatch도 함께 보게 보강했다.
  - stale로 남아 있던 `DB 무결성 / investment trade_review 무결성` 패턴 row는 직접 정리했다.
- 현재 의미:
  - 지금 당장 필요한 구조는 덱스터가 false-positive `trade_review` 경고는 제거하되, Picco raw mismatch처럼 실제 unresolved 상태는 health/report에서도 숨기지 않는 것이다.
  - 나중에는 reservation 쪽도 `alert 기반 감지`와 `raw DB mismatch`를 분리한 2축 health로 정리할 수 있다.
## 2026-03-26 10:58 KST — crypto LIVE gate 리포트 표현을 실제 실행 현실에 맞게 정렬

- 최근 binance 체결 12건을 직접 분해한 결과, `LIVE 12 / PAPER 0`은 집계 오류가 아니라 실제 실행 구조였다.
- 실제 확인:
  - 최근 12건 전부 `trades.paper = false`
  - 그중 `FET/USDT`, `CFG/USDT`, `RENDER/USDT`, `SIGN/USDT`는 `trade_mode=validation`인데도 `is_paper=false`
  - 즉 현재 암호화폐 validation은 PAPER 검증이 아니라 `LIVE 소액 검증` 레일로 동작 중이다.
- 문제:
  - [crypto-live-gate-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/crypto-live-gate-review.js)와 [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)는 여전히 `PAPER 체결 또는 청산 검증이 아직 부족함` 중심 문구를 써서 현재 실행 현실을 과도하게 단순화하고 있었다.
- 조치:
  - `crypto-live-gate-review.js`에 `trade_mode별 체결` 사실 라인을 추가
  - `validation LIVE / PAPER` 분해를 `facts`, `inferred`, `recommendations`에 반영
  - gate 사유를 `validation LIVE 표본은 있으나 PAPER 검증 표본이 부족하고 near-threshold weak가 아직 높음`으로 구체화
  - 투자팀 health 리포트도 같은 분해 정보를 직접 노출하도록 맞춤
- 현재 의미:
  - 지금 당장 필요한 구조는 gate를 푸는 것이 아니라, `validation LIVE`와 `PAPER 부족`를 분리해 읽는 것이다.
  - 나중에는 crypto에서 `validation-live`, `paper-validation`, `normal-live`를 명시적으로 분리한 운영 정책 문서가 필요하다.

## 2026-03-26 11:08 KST — 투자팀 crypto validation / paper / live 정책 기준선 문서화

- 요청 배경:
  - 최근 crypto LIVE gate 리포트가 `LIVE 12 / PAPER 0`, `VALIDATION 4건도 LIVE`를 보여주고 있었고, 기존 "`validation = paper 검증`" 해석과 실제 운영 레일이 어긋나 있었다.
  - health/report 문구는 이미 정렬됐지만, 다음 세션이 정책 의미를 오해하지 않도록 source of truth 문서가 필요했다.
- 반영:
  - [VALIDATION_LANE_POLICY.md](/Users/alexlee/projects/ai-agent-system/bots/investment/docs/VALIDATION_LANE_POLICY.md) 추가
    - `trade_mode`와 `paper`를 독립 축으로 정의
    - crypto의 현재 `validation`은 `PAPER`가 아니라 `LIVE 소액 검증 레일`임을 명시
    - `crypto LIVE gate blocked`의 정확한 의미를 "`LIVE 금지`"가 아니라 "`normal live 확대 보류`"로 정리
    - 이후 확인해야 할 `mid_gap_*`, `capital_guard`, `reentry` 관찰 지표 정리
- 의미:
  - 현재 운영 현실과 health/report 문구, 문서 기준선을 하나로 맞췄다.
  - 내부 MVP에서는 `validation LIVE`를 guarded lane으로 인정하되, 추후 SaaS 확장 시 `PAPER validation` 복원 또는 workspace별 risk profile 분리를 선택할 수 있는 기준점이 생겼다.
- 남은 TODO:
  - 다음 crypto cycle에서 `mid_gap_promoted / executed / rejected_by_risk`가 실제로 쌓이는지 확인
  - `capital_guard` validation 편중과 `reentry` 변화까지 같이 봐서 LIVE gate 완화 여부 재판단

## 2026-03-26 11:22 KST — 한울 KIS mock `매매불가 종목` 오류 분류 정밀화

- 요청 배경:
  - 루나가 `002630 BUY`를 승인한 뒤 한울 실행 단계에서 `KIS API 오류 [40070000]: 모의투자 주문처리가 안되었습니다(매매불가 종목)`가 발생했다.
  - 현재가 조회(`586원`)는 정상 통과했기 때문에 사전 TA/quote 검증만으로는 막을 수 없고, 브로커 mock 주문 단계에서만 드러나는 종목 제약으로 판단됐다.
- 반영:
  - [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
    - `inferHanulBlockCode()`가 `40070000` 또는 `매매불가 종목` 문구를 `mock_untradable_symbol`로 분류하도록 보강
- 의미:
  - 지금 당장 필요한 구조는 브로커 제약을 generic `domestic_order_rejected`로 뭉개지 않고, `KIS mock에서 주문 불가한 종목`으로 정확히 남기는 것이다.
  - 나중에는 이 block code를 기반으로 동일 종목 BUY를 더 긴 쿨다운으로 묶거나, 모의투자 불가 종목 watchlist를 둘 수 있다.
- 남은 TODO:
  - `002630` 같은 종목이 반복되는지 `signals.block_code='mock_untradable_symbol'` 기준으로 추적
  - 필요하면 국내장 screening 단계에서 mock 불가 종목 쿨다운/제외 정책 검토

## 2026-03-26 11:31 KST — KIS mock `매매불가 종목` BUY 재시도 쿨다운 추가

- 요청 배경:
  - `002630 BUY`는 현재가 사전검증까지는 통과했지만, 실제 KIS mock 주문 단계에서만 `매매불가 종목`이 드러났다.
  - 같은 종목이 screening/approval에서 다시 올라오면 같은 실패를 반복할 가능성이 있어, 브로커 제약 확인 후 짧은 쿨다운이 필요했다.
- 반영:
  - [runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)
    - `luna.mockUntradableSymbolCooldownMinutes` 기본값 `1440`(24시간) 추가
  - [db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js)
    - `getRecentBlockedSignalByCode()` 추가
  - [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
    - 국내장 BUY + KIS mock 레일에서 최근 `mock_untradable_symbol`이 있으면 사전 리스크 거부
    - 이때 `mock_untradable_symbol_cooldown` block code를 명시적으로 남기도록 보강
- 의미:
  - 지금 당장 필요한 구조는 브로커 mock 제약이 확인된 종목을 같은 세션/같은 날 반복 주문하지 않도록 입력 경계를 회복하는 것이다.
  - 나중에는 이 쿨다운 히스토리를 screening 단계까지 올려 종목 제외/우회 레일로 확장할 수 있다.

## 2026-03-26 11:39 KST — 투자팀 health에 `mock_untradable_symbol` 관찰 섹션 추가

- 요청 배경:
  - `002630 BUY` 실패를 `mock_untradable_symbol` / `mock_untradable_symbol_cooldown`으로 정확히 기록하게 되었지만, health/report에서는 아직 이 유형을 별도 운영 신호로 읽지 못했다.
- 반영:
  - [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - `loadMockUntradableSymbolHealth()` 추가
    - 최근 24시간(`1440분`) `exchange='kis'` + `block_code IN ('mock_untradable_symbol','mock_untradable_symbol_cooldown')` 집계
    - text report에 `■ KIS mock 주문 불가 종목` 섹션 추가
    - 운영 판단에도 low-level 관찰 신호로 연결
- 의미:
  - 지금 당장 필요한 구조는 국내장 mock 브로커 제약을 단순 개별 실패가 아니라 screening 품질/approval 품질의 관찰 신호로 읽는 것이다.
  - 나중에는 이 섹션을 기반으로 mock 불가 종목 watchlist나 screening 제외 정책으로 확장할 수 있다.

## 2026-03-26 11:45 KST — `002630` KIS mock 불가 이력 backfill 재분류

- 요청 배경:
  - health에 `mock_untradable_symbol` 관찰 섹션을 추가했지만, 기존 `002630` 실패 row는 아직 `domestic_order_rejected`로 남아 있어 새 섹션에 잡히지 않았다.
- 반영:
  - [backfill-signal-block-reasons.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/backfill-signal-block-reasons.js)
    - `--mode=reclassify` 추가
    - 기존 `domestic_order_rejected` / `legacy_executor_failed` 등으로 저장된 row 중
      `KIS API 오류 [40070000]` 또는 `매매불가 종목` 문구가 있는 국내장 BUY를 `mock_untradable_symbol`로 재분류하도록 보강
  - 실제 실행:
    - `node bots/investment/scripts/backfill-signal-block-reasons.js --mode=reclassify --days=30 --dry-run`
    - `updated=1`, 대상 `002630`
    - 이어서 실제 적용(`dryRun=false`) 완료
- 결과:
  - 투자팀 health JSON에서
    - `signalBlockHealth.top`에 `mock_untradable_symbol: 1건`
    - `mockUntradableSymbolHealth.warn`에 `002630 mock 주문 불가 1건`
    - 운영 판단에 `최근 24시간 KIS mock 주문 불가 종목 1건`이 반영됨
- 의미:
  - 지금 당장 필요한 구조는 새 실패만 아니라 과거 동일 유형도 같은 기준으로 해석되도록 원장을 정렬하는 것이다.
  - 나중에는 이 재분류 로직을 다른 브로커 capability 제약(`overseas mock 제한`, `broker_execution_error` subtype)까지 확장할 수 있다.

## 2026-03-26 11:52 KST — 네메시스 승인 단계에 `mock_untradable_symbol` 연동

- 요청 배경:
  - 한울 실행 단계에서만 `mock_untradable_symbol`을 차단하면, 같은 종목이 approval까지는 계속 올라와 운영 노이즈가 남는다.
  - 국내장 mock 제약은 execution-only signal이지만, 한 번 확인된 종목은 approval 레이어도 참고하는 게 맞다.
- 반영:
  - [nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
    - `kis + BUY + mock 계좌` 조건에서 최근 `mock_untradable_symbol` 이력을 조회
    - 최근 24시간 내 동일 종목이면 `mock_untradable_symbol_recent`으로 승인 거부
  - 재사용 레이어:
    - [db.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/db.js)의 `getRecentBlockedSignalByCode()`
    - [runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)의 `mockUntradableSymbolCooldownMinutes`
- 의미:
  - 지금 당장 필요한 구조는 브로커 mock 제약이 확인된 종목을 approval 단계에서도 조용히 다시 걸러 execution 노이즈를 줄이는 것이다.
  - 나중에는 screening 단계까지 같은 신호를 올려 mock 불가 종목 watchlist로 확장할 수 있다.

## 2026-03-26 11:59 KST — 국내장 screening 후보에서 `mock_untradable_symbol` 제외

- 요청 배경:
  - execution과 approval까지 `mock_untradable_symbol`을 반영했지만, 자동 screening 후보 자체는 여전히 같은 종목을 다시 올릴 수 있었다.
  - held 포지션은 유지하되, 신규 BUY 후보만 미리 덜어내는 것이 가장 자연스러운 다음 단계였다.
- 반영:
  - [domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
    - `filterMockUntradableDomesticCandidates()` 추가
    - 최근 `mock_untradable_symbol` 이력이 있는 국내장 BUY 후보를 screening 단계에서 제외
    - 이 필터는 `prescreened` / dynamic screening 경로에만 적용
    - 명시 실행 `--symbols`, `--no-dynamic`은 존중
    - `appendHeldSymbols()` 전에 적용해서 보유 포지션 심볼은 계속 유지
- 의미:
  - 지금 당장 필요한 구조는 브로커 mock 제약이 확인된 종목을 execution/approval뿐 아니라 screening 후보에서도 줄여 운영 노이즈를 한 번 더 낮추는 것이다.
  - 나중에는 이 기준을 watchlist, screening history quality score, broker capability profile까지 확장할 수 있다.

## 2026-03-26 15:08 KST — 장전 prescreen 저장 단계에서도 `mock_untradable_symbol` 제외

- 요청 배경:
  - `015260`, `152550`처럼 국내장 mock 불가 종목이 새로 확인되면서, 소비 단계 필터만으로는 장전 prescreen JSON 자체에는 여전히 같은 후보가 남을 수 있었다.
  - screening 소비 단계뿐 아니라 prescreen 저장 단계에서도 같은 제약을 적용하는 것이 가장 자연스러운 다음 보강이었다.
- 반영:
  - [pre-market-screen.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/pre-market-screen.js)
    - `filterMockUntradablePrescreenSymbols()` 추가
    - 국내장 장전 prescreen 저장 전에 최근 `mock_untradable_symbol` 이력이 있는 BUY 후보를 제외
    - 해외장/암호화폐 prescreen은 건드리지 않음
- 의미:
  - 지금 당장 필요한 구조는 국내장 mock 불가 종목을 execution → approval → screening 소비 → prescreen 저장까지 끌어올려, 자동 후보 재등장을 더 앞단에서 줄이는 것이다.
  - 나중에는 이 신호를 prescreen 품질 점수, watchlist hygiene, broker capability cache로 확장할 수 있다.

## 2026-03-26 22:22 KST — 국내장 `domestic_order_rejected` 세부 분류 복구

- 요청 배경:
  - 자동화 리포트 분석 결과 국내장 최근 14일 실패 상위가 여전히 `domestic_order_rejected 11건`으로 뭉쳐 있어, 실제 병목이 rate limit인지, 현재가 조회 실패인지, 시장시간 문제인지 바로 읽기 어려웠다.
- 반영:
  - [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
    - `inferHanulBlockCode()`에 `broker_rate_limited`, `market_closed`, `quote_lookup_failed` 추가
  - [backfill-signal-block-reasons.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/backfill-signal-block-reasons.js)
    - `--mode=reclassify`가 과거 국내장 `domestic_order_rejected`를 `broker_rate_limited`, `quote_lookup_failed`, `mock_untradable_symbol`로 재분류하도록 확장
    - 실제 30일 이력 10건 재분류 완료
  - [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - `loadDomesticRejectBreakdown()` 추가
    - 최근 24시간 국내장 주문 실패를 subtype별로 요약
- 의미:
  - 지금 당장 필요한 구조는 국내장 주문 실패를 운영 판단 가능한 subtype으로 복구해 screening/approval/execution 품질 문제를 분리해서 보는 것이다.
  - 나중에는 이 분해를 바탕으로 KIS rate limit 재시도 정책, 현재가 조회 품질 경고, 브로커 capability watchlist를 더 세밀하게 붙일 수 있다.

## 2026-03-26 22:29 KST — KIS 국내장 rate limit 완화용 주문 pacing 보강

- 요청 배경:
  - `domestic_order_rejected` 세부 분류를 복구한 뒤, 최근 30일 국내장 실패 다수가 실제로 `초당 거래건수 초과`였음이 확인됐다.
  - 현재는 현재가 조회와 주문 요청이 같은 `380ms` 공통 슬롯을 공유하고, 한울 pending 루프도 `500ms` 간격이라 mock KIS 주문 레일에는 다소 공격적이었다.
- 반영:
  - [kis-client.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/kis-client.js)
    - KIS 요청을 `quote` / `order` lane으로 분리
    - 주문 POST(`/trading/`)는 `KIS_ORDER_MIN_INTERVAL_MS = 980` 적용
    - 현재가/잔고 등 조회는 기존 `380ms` 유지
  - [hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
    - 국내/해외 pending signal 처리 간격을 `500ms -> 1100ms`로 상향
- 의미:
  - 지금 당장 필요한 구조는 KIS mock 레일에서 주문 요청을 시세 조회보다 더 보수적으로 pacing해 `broker_rate_limited`를 줄이는 것이다.
  - 나중에는 거래소/시장별로 lane별 pacing을 runtime-config로 외부화할 수 있다.

## 2026-03-26 22:30 KST — 투자팀 health에 국내장 수집 압력/희소 데이터 노출

- 요청 배경:
  - 오늘 오류 로그를 다시 확인한 결과 국내장은 주문 실패보다 `wide_universe`, `collect_overload_detected`, `debate_capacity_hot`, 대량 `데이터 부족`이 더 큰 active 병목으로 보였다.
  - 기존 health는 `mock 주문 불가`와 주문 실패는 보여주지만, collect pressure와 data sparsity는 상단 판단에서 바로 읽히지 않았다.
- 반영:
  - [health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - `/tmp/investment-domestic.err.log` 최근 200줄을 직접 집계하는 `loadDomesticCollectPressure()` 추가
    - `overload`, `wide`, `concurrency`, `debate_capacity_hot`, `data_sparsity`, `외부 시세/순위 조회 실패`를 요약
    - text/JSON report와 운영 판단 reason에 `국내장 수집 압력` 섹션 추가
- 현재 관측값:
  - overload `17`
  - wide `17`
  - debate `17`
  - data_sparsity `156`
  - 외부 시세/순위 조회 실패 `6`
- 의미:
  - 지금 당장 필요한 구조는 국내장 자동화의 핵심 병목을 주문 실패가 아니라 collect pressure/data sparsity까지 포함해 상단 리포트에서 직접 읽는 것이다.
  - 나중에는 이 집계를 로그 tail 기반 임시 방식에서 pipeline/session 메트릭 기반 health로 승격할 수 있다.
## 2026-03-26 — crypto validation soft budget guard

- 배경
  - 최근 14일 `capital_guard_rejected=65` 중 `validation=59`, `daily trade limit=63`으로 crypto validation 레인의 일간 예산 소진이 핵심 병목으로 확인됐다.
  - 기존에는 approval을 통과한 validation BUY가 실행 단계 `capital_guard_rejected`에서 뒤늦게 막혀 운영 노이즈가 커졌다.

- 이번 변경
  - [bots/investment/shared/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)
    - `luna.validationSoftBudget.binance.reserveDailyBuySlots=2` 기본값 추가
  - [bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
    - `binance + validation + BUY` 경로에서 일간 validation BUY 수를 먼저 조회
    - `max_daily_trades(10)` 중 마지막 `2` 슬롯은 남기고, soft cap(`8`) 도달 시 approval 단계에서 `validation_daily_budget_soft_cap`으로 거부
    - block meta에 `daily_validation_buys`, `soft_cap`, `hard_cap`, `reserve_slots` 기록

- 의도
  - 지금 당장 필요한 구조:
    - execution 단계 `capital_guard_rejected`를 approval 단계의 더 명확한 subtype으로 앞당겨 운영 해석성과 노이즈를 개선
  - 나중에 확장할 구조:
    - exchange/trade_mode별 soft budget 정책 외부화
    - validation/live/paper budget을 분리한 lane-level capital policy

- 검증
  - `node --check bots/investment/shared/runtime-config.js`
  - `node --check bots/investment/team/nemesis.js`
  - `node --input-type=module -e "import { getValidationSoftBudgetConfig } from './bots/investment/shared/runtime-config.js'; console.log(JSON.stringify(getValidationSoftBudgetConfig('binance')));"`
  - `node bots/investment/scripts/health-report.js --json`

- 현재 후속 확인 포인트
  - 다음 crypto cycle에서 `validation_daily_budget_soft_cap`가 실제 block code로 집계되는지
  - `capital_guard_rejected`의 validation 비중이 감소하는지
  - `mid_gap_*`와 soft cap이 같이 작동할 때 LIVE gate 판단이 어떻게 바뀌는지

## 2026-03-26 — crypto validation soft budget health 노출

- 배경
  - soft budget guard를 추가했지만, 발동 전에는 운영자가 현재 validation BUY 사용량이 soft cap에 얼마나 가까운지 헬스 리포트만으로 읽기 어려웠다.

- 이번 변경
  - [bots/investment/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - `loadCryptoValidationSoftBudgetHealth()` 추가
    - 오늘 `binance + validation + BUY` 체결 수를 조회해 `hard cap`, `reserve`, `soft cap`과 함께 노출
    - `■ crypto validation soft budget(오늘)` 섹션 추가
    - soft cap 근접/도달 시 운영 판단 reason에도 반영되도록 연결

- 현재 기준
  - `BINANCE / validation BUY 3/8 soft cap (hard 10, reserve 2)`
  - 아직 근접/도달 상태는 아니므로 warning은 아님

- 의도
  - 지금 당장 필요한 구조:
    - soft cap 발동 전에도 validation 예산 사용량을 예방적으로 관찰
  - 나중에 확장할 구조:
    - exchange/trade_mode별 soft budget health 일반화
    - `/ops-health` 상위 집계와 연결

## 2026-03-26 — 투자팀 CRITICAL 텔레그램 중복 완화

- 배경
  - `한울(KIS해외) - ORCL SELL` 실패가 텔레그램에서 2회 보였는데, health 기준 최근 active row는 `mock_operation_unsupported 1건`이었다.
  - 원인은 실행 중복이 아니라 CRITICAL 텔레그램 fanout 정책이었다.
  - 기존 [packages/core/lib/telegram-sender.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/telegram-sender.js)의 `sendCritical()`는 `emergency + team` 이중 발송을 수행한다.

- 이번 변경
  - [packages/core/lib/reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js)
    - telegram target에 `criticalMode` 추가 (`both` 기본)
  - [bots/investment/shared/report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/report.js)
    - 투자팀 `notifyError()`는 `criticalTelegramMode: 'team_only'`로 발송
    - 따라서 투자 실행 오류는 더 이상 `emergency + luna` 이중 텔레그램 전송을 하지 않음
    - 단, `alertLevel=4`와 N8N critical webhook 경로는 유지

- 의도
  - 지금 당장 필요한 구조:
    - 투자 실행 오류 1건이 텔레그램에서 2건처럼 보이는 UX를 제거
  - 나중에 확장할 구조:
    - 팀별/이벤트유형별 `CRITICAL` fanout 정책 분리
    - 시스템성 장애만 `emergency+team`, 실행 오류는 `team-only`로 일반화

## 2026-03-26 — runtime-config 제안 리포트에 crypto soft budget 정렬

- 배경
  - investment health에는 `crypto validation soft budget`이 보이는데, [runtime-config-suggestions.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js)는 같은 정보를 보여주지 않아 운영 리포트와 설정 제안 리포트가 서로 다른 기준선을 가리켰다.

- 이번 변경
  - [bots/investment/scripts/runtime-config-suggestions.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js)
    - 오늘 `binance + validation + BUY` 수를 별도로 집계
    - `hardCap`, `reserveSlots`, `softCap`, `count`, `ratio`를 포함한 `validationBudgetSnapshots.cryptoValidation` 추가
    - text report에 `validation budget 스냅샷(오늘)` 섹션 추가

- 현재 기준
  - `binance/validation: BUY 3/8 soft cap (hard 10, reserve 2)`

- 의도
  - 지금 당장 필요한 구조:
    - health와 runtime-config 제안 리포트가 같은 soft budget truth를 보도록 정렬
  - 나중에 확장할 구조:
    - validation/live lane별 예산 snapshot 일반화
    - 설정 추천에서 soft cap 근접 시 observe/adjust 후보 자동 생성

## 2026-03-26 — crypto validation soft cap 차단 집계 노출

- 배경
  - soft budget 사용량(`3/8`)은 보이지만, 실제 `validation_daily_budget_soft_cap` 차단이 발생했는지는 health 상단에서 바로 읽을 수 없었다.

- 이번 변경
  - [bots/investment/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
    - `loadCryptoValidationBudgetBlockHealth()` 추가
    - 최근 24시간 `block_code = validation_daily_budget_soft_cap` 집계
    - `■ crypto validation soft cap 차단(최근 24시간)` 섹션 추가

- 현재 기준
  - `최근 crypto validation soft cap 차단 없음`

- 의도
  - 지금 당장 필요한 구조:
    - soft budget 사용량과 실제 soft cap 차단 건수를 분리 관찰
  - 나중에 확장할 구조:
    - `capital_guard_rejected`와 `validation_daily_budget_soft_cap`를 함께 추적하는 lane-level budget 분석

## 2026-03-26 — runtime-config 제안 리포트에 soft cap 조정 힌트 보강

- 배경
  - [runtime-config-suggestions.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js)가 soft budget 스냅샷은 보여주지만, 실제 `validation_daily_budget_soft_cap` 차단이 발생했을 때 reserve slot을 유지/완화 중 어느 쪽을 볼지 제안하지 못했다.

- 이번 변경
  - [bots/investment/scripts/runtime-config-suggestions.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js)
    - 오늘 `signals` 기준 `validation_daily_budget_soft_cap`, `capital_guard_rejected` 차단 건수를 함께 집계
    - `validationBudgetSnapshots.cryptoValidation`에 `normalCount`, `softCapBlocks`, `capitalGuardBlocks`를 추가
    - reserve slot 제안 로직 보강
      - `softCapBlocks > 0`이고 `normal BUY = 0`, `capital_guard = 0`이면 reserve 완화 후보 제안
      - 그렇지 않으면 reserve 유지 관찰 제안
    - text report 스냅샷에도 `normal`, `soft-cap blocks`를 함께 표기

- 현재 기준
  - `binance/validation: BUY 3/8 soft cap (hard 10, reserve 2, normal 0, soft-cap blocks 0)`

- 의도
  - 지금 당장 필요한 구조:
    - soft cap이 실제로 걸렸을 때 reserve slot 조정 방향을 운영 리포트에서 바로 읽게 하는 것
  - 나중에 확장할 구조:
    - soft cap 차단 누적치와 normal lane 점유율을 함께 본 자동 reserve slot 튜닝
