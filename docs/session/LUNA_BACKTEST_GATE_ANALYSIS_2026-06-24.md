# 루나 백테스트 게이트 정밀 분석 — 핸드오프

- 분석일: 2026-06-24
- 분석: 메티
- 상태: **분석 완료, 완화 방향 마스터 선택 대기**
- 후속: 마스터가 방향 선택 → 코덱스 명세 → 구현 → 메티 검증

## 1. 게이트 구조 (핵심)

- `investment.candidate_backtest_status.would_block` 이 **실제 차단 신호**.
- `enforced` 컬럼은 **죽은 컬럼** — 코드 어디서도 읽지 않음(grep 0건), refresh에서 저장만 됨. `enforced=0` 이어도 `would_block=true` 면 실제 차단됨.
- `would_block` 소비 경로 3개:
  - `bots/investment/shared/predictive-validation.ts` — **메인 strategy/L13 경로** → `block_backtest_gate` (line 241-243, 315)
  - `bots/investment/shared/entry-trigger-engine.ts` — 보조 entry_trigger 경로 + DSR 하드블록 (line 153, 161, 192-197)
  - `bots/investment/team/hephaestos/execution-guards.ts` — 실행 직전 가드

## 2. 차단 현황 (crypto 157/157 = 100%, healthy=0)

market별: domestic 607/606, overseas 372/367, crypto 157/157 차단. 전 market enforced=0.

차단 사유 분포 (crypto, 중첩 허용):
| 사유 | 건수 | 비율 |
|---|---|---|
| outside_binance_top30_volume_universe | 82 | 52% |
| candidate_backtest_dsr_low | 67 | 43% |
| walk_forward_period_failed | 63 | 40% |
| sharpe_negative | 60 | 38% |
| drawdown_high | 46 | 29% |
| win_rate_low | 35 | 22% |

oos_status 분포: null 84, unstable 39, **ok 30**, insufficient_data 4. oos=ok 30건은 전부 `would_block_unhealthy`.

## 3. 완화 레버 ROI (crypto 157 기준, 순수 단일 차단)

"순수 단일 차단" = 그 게이트만 풀면 다른 차단 사유 없이 즉시 진입 가능한 종목 수.

| 레버 | 순수 구제 | 표면 사유 | 성격·트레이드오프 |
|---|---|---|---|
| **top30 유니버스 확대** | **82** | 82 | 백테스트 품질 무관. 유동성↓ → 슬리피지/체결 리스크 |
| DSR 게이트 OFF | **4** | 67 | 표면 67건이나 63건은 진짜 품질 문제 동반. 순수 4건뿐 |
| 순수 품질 미달(neither) | 8 | 8 | top30 안 + DSR 아님. 실제 5분봉 sharpe<0/win<30 |

**핵심 반전**: 진입 가뭄의 최대 백테스트 병목은 **DSR이 아니라 top30 유니버스 필터(82건)**. 이전 DSR=0 집중 가설은 정정됨. DSR 게이트를 꺼도 순수 구제는 4건뿐(나머지는 walk_forward/sharpe 품질 문제 동반).

oos=ok 30건(백테스트 통과 우량후보)은 전부 top30 안(universe 차단 0), 전부 DSR로 차단(30/30), 그 중 26건은 sharpe_negative·walk_forward도 동시.

## 4. 근본 원인 (왜 100% 차단)

- `healthy = !effectiveWouldBlock` (refresh.ts line 839), `effectiveWouldBlock = wouldBlock || dsrWouldBlock` (line 783).
- `wouldBlock` = reasons에 sharpe_/unrealistic_/overfit_/insufficient_oos/backtest_unstable/low_trade/**walk_forward_period_failed**/win_rate_/drawdown_ 중 하나라도 있으면 true (line 681-690). 다수 OR → 한 종목이 모든 조건 동시 통과 어려움.
- **walk_forward_period_failed** (line 655-658): 다기간(30/90/180일) 중 **하나라도** win<30% 또는 sharpe<0 이면 차단. 5분봉 크립토에서 전 기간 win≥30 AND sharpe≥0 동시 만족 = 구조적으로 거의 불가.
- GATE 상수 (refresh.ts line 33-43): MIN_SHARPE 0, MAX_DRAWDOWN 30, MIN_WIN_RATE 30, MAX_ABS_SHARPE 8, MIN_PERIOD_TRADES 5, MIN_TOTAL_TRADES 12. 백테스트 기간 default '30,90,180'.
- DSR 게이트 (line 770-783): `LUNA_DSR_GATE_ENABLED=true`(refresh plist 확인), `LUNA_DSR_MIN` 기본 0.90, `LUNA_DSR_MIN_TRADES` 기본 30. 5분봉 per-period sharpe 작아 DSR 구조적 미달.

## 5. 다음 세션 진입점 — 완화 방향 3택 (마스터 선택 대기)

1. **top30 → top50 확대** (`bots/investment/shared/binance-top-volume-universe.ts`): 최대 효과(82건)지만 유동성 기준 신중 설계 필요. 슬리피지/체결 리스크 평가 동반.
2. **walk_forward 완화** (refresh.ts line 655-658): 전 기간 필수 → 다수결(2/3 기간 통과). 8건 품질 종목 일부 구제 + 5분봉 현실 반영. 코드 수정.
3. **현상 유지**: 게이트는 정상 작동, 진짜 병목은 루나 L13 에이전트(별도 결론)이므로 게이트 미변경.

선택 후 절차: 마스터 방향 확정 → 메티가 코덱스 명세(docs/codex/) 작성 → 코덱스 구현 → 메티 검증(문법/소프트/하드) → 마스터 적용. crypto LIVE PROTECTED 원칙상 어떤 변경이든 shadow/dry-run 검증 후 적용.

## 6. 핵심 파일·라인 레퍼런스

- `bots/investment/scripts/runtime-luna-candidate-backtest-refresh.ts` — healthy/gate_status/would_block 계산·저장. GATE 상수 L33, walk_forward L655-658, wouldBlock L681-690, dsrWouldBlock L770-783, effectiveWouldBlock L783, healthy L839, gateStatus L840.
- `bots/investment/shared/candidate-backtest-gate.ts` — evaluateCandidateBacktestStatus. wouldBlock 재계산 L272 (would_block||!fresh||!healthy||drawdown||sharpe||dsr), enforced 미참조.
- `bots/investment/shared/predictive-validation.ts` — 메인 경로 소비. L120, L241-243, L315, L321, L340, L344.
- `bots/investment/shared/entry-trigger-engine.ts` — 보조 경로 소비. L22, L144, L153, L161, L192-197.
- `bots/investment/shared/binance-top-volume-universe.ts` — top30 유니버스 필터.
- DSR 게이트 env: `~/Library/LaunchAgents/ai.luna.candidate-backtest-refresh.plist`, `ai.luna.ops-scheduler.plist` (LUNA_DSR_GATE_ENABLED=true).
- 조회: `psql -d jay` → `investment.candidate_backtest_status` (market='crypto', block_reasons jsonb).
