# 루나 재설계 §8 현황 정밀 분석 아카이브 (2026-06-19 ~ 06-21)

> 출처: docs/design/LUNA_OPTIMAL_REDESIGN.md §8 (8-1~8-32)
> 분리일: 2026-06-26 (메티) — 본문 흐름 정리를 위해 시간순 상세 분석을 아카이브로 분리
> 본문에는 §8 압축 요약만 유지. 핵심 결론은 §9(시스템 프로세스+개선 종합)에도 반영됨.
> 이 문서는 6/19~6/21 세션들의 상세 분석 기록 (fill-resolver·백필·손익·병목 진단 등).

---

## 8. 현황 정밀 분석 (2026-06-19 메티 — 구현 가능 + 데이터 병목 + 생성 vs 실거래)
> 상세 근거·쿼리: `LUNA_OPTIMAL_REDESIGN_TRACKER.md` 2026-06-19 섹션 3종 참조

### 8-1. 구현 상태 전수 맵
- **완료·가동**: P0 6/6 · P1 전부(C1 게이트·C2 레짐·C3 전략군·C4 사전게이트·C15 레지스트리·C17 파라미터 스토어) · 회의실 전부 · ALPHA · P2 C7 전면 · TOSS A~D · ET-A/C/D · C8 실가동
- **지금 구현 가능(데이터 무관·자산 존재)**: C17 제약 집행 강화(S·V-O 대비) · C14 btc_dominance/vix_term_structure/put_call 소스 연결(M) · C10 워치리스트 통합(M·near-miss 재사용)
- **부분 가능(Stage/선행)**: C6 LLM 강등(Stage B) · C9 add(P3) · C13 재구성(P3)
- **데이터 대기**: C5 · C8 30거래 · ALPHA R5/R6 · ET-B · ET-D · promotion(evidence 1)
- **마스터 승인/지시**: TOSS-E · argona 딥서칭

### 8-2. 데이터 병목 진단 — "데이터 부족"은 시간 문제 아니라 구조적 병목
- **근원**: crypto 지속 bear 레짐(bull 확률 1~4%) + 추세 추종(turtle/testah)만 구현 → 전략군 신호 8건 중 7건 matched=false(레짐 불일치·정확 동작) → C8 outcome 1·ET-D 0·C5 부족(전부 하류 연쇄).
- **진짜 병목**: bear/range장 전략군(레인지 v1.1 WB 더블 볼린저·defensive·숏) 미구현 → 하락/횡보장 진입 기회 0.

### 8-3. 생성 데이터 vs 실거래 데이터 — 두 별개 체계·정렬 0 (충격)
- **재설계 shadow**(C3 turtle/testah=추세) **≠ 실거래**(unified-analyst·strategy-router → momentum_rotation·mean_reversion). signal_id 매칭 **0건**.
- **방향 불일치**: 실거래 전략군별 순익 — momentum_rotation +$1,786 · mean_reversion +$1,401 · **trend_following −$20 · breakout −$4(손실)**. 재설계가 미는 추세는 실거래 손실, 수익원은 재설계 부재.
- **실거래 전 레짐 수익**: trending_bull +$1,763 · trending_bear +$875 · ranging +$505. binance 691건·+$3,148·L4 autotune(post +$3,026 vs pre +$123).

### 8-4. 미해결 핵심 의문 → 8-5에서 규명
백테스트 우수했던 turtle/testah가 실거래 trend_following에서 손실인 **근본 원인**. ⚠️ 단 거래전략은 **페이즈별 대규모 업데이트**로 일관적이지 않음 → 단순 전략별 집계는 오도 가능. **기간별×전략별 데이터를 연결성 있게 분석**(업데이트 히스토리 ↔ 수익/손실 상관)해야 진짜 원인 규명 가능. [분석 진행 중]


### 8-5. 전체 거래 데이터 기간별×전략별 정밀 분석 — 손익 히스토리 상관 (2026-06-19 메티)
> 776건(2026-03-12~06-19) Python 분석. USD 환산(binance/overseas USD·kis KRW÷1350). **마스터 통찰 입증: 거래전략은 페이즈별 대규모 업데이트로 일관성 없음 → 기간별 분리 필수.**

**★ autotune 전환(2026-04-10)이 손익 변곡점**:
- **l4_pre_autotune**(3/11~4/24·278건): **−$735** — 국내 defensive_rotation 손실(−$818)이 주범. top 손실 6건 중 5건이 국내 주식 defensive(force_exit·orphan_cleanup·journal_reconciled_sell = **운영 미숙·정리거래**).
- **l4_post_autotune**(4/10~6/18·413건): **+$3,017** — crypto momentum_rotation(+$1,663)·mean_reversion(+$1,429). **autotune의 핵심 = mean_reversion 활성화(17건→151건)**.

**수익의 시장 의존성(중요)**: 4/27~5/03 단 1주에 **+$2,243 집중**(crypto 알트 랠리·PENGU/PUMP/ORCA/AVNT). 나머지 13주는 소폭 손익(−$33~+$222). → **수익 지속성 불확실**(특정 국면 의존·반복 가능성 미검증).

**전략별 USD 순익(전 기간)**: momentum_rotation +$1,786 · mean_reversion +$1,401 · defensive_rotation −$782(국내 pre) · trend_following −$20(17건) · breakout −$4(2건) · equity_swing −$59.

**★ 백테스트 vs 실거래 의문 — 최종 답**:
- "추세 추종(trend_following/breakout) 손실" 결론은 **표본 17+2건·−$24로 통계 무의미** → **단정 철회**. 백테스트 우수성을 실거래로 반증할 표본 자체가 부족.
- 진짜 손익 동인: ①pre 국내 defensive 운영 미숙 손실(force_exit·orphan) ②post crypto momentum/mean_reversion 수익(autotune의 mean_reversion 활성화 + 4월 말 알트 랠리 포착).
- **재설계 시사**: C3에 **mean_reversion(레인지) 편입이 핵심** — autotune 실거래가 mean_reversion 수익성을 입증(+$1,429). 추세(turtle/testah)는 실거래 검증 표본 부족 → 소액 paper-mirror/shadow 검증 후 판단.

**일관성 결여 정량 확인**: 전략 믹스가 페이즈마다 급변(pre: momentum 227/defensive 34 → post: momentum 168/mean_reversion 151/defensive 49). **단순 전략별 집계는 페이즈 교란으로 오도** — 모든 성과 분석은 기간(페이즈)별 분리 필수. 추후 autotune류 대규모 업데이트는 trade_journal에 버전 태그 권고(현 autonomy_phase가 부분 대용).


### 8-6. 기존 실거래 전략 로직 vs 재설계 C3 (2026-06-19 메티)
- **기존(실거래 수익원)**: `unified-analyst`(291줄 — 종합 스코어링: phaseA regime/signals + fundamental + sentiment → calcConfidence → scoreToSignal) + `strategy-router`(502줄 — 라우팅) + `strategy-family-classifier`(329줄 — 문자열 정규화: momentum→momentum_rotation, mean/reversion→mean_reversion). **다요소(기술+펀더멘털+감성) 종합 판단**.
- **재설계 C3**: 순수 기술 룰(turtle 20/10 돌파·2ATR·SMA200 / testah 5/25/75 정배열·재돌파 / 레짐 matched). 단일 차원·명시적·검증 가능하나 실거래 미적용(shadow only).
- **차이/시사**: 기존이 더 종합적(펀더·감성 포함)이라 실거래 수익(momentum +$1,786·mean_reversion +$1,401). 재설계 룰은 투명·백테스트 가능하나 실거래 검증 표본 부족(trend_following 17건). **편입 방향**: ①C3에 mean_reversion 룰 신설(실거래가 수익성 입증) ②기존 종합 스코어링의 mean_reversion/momentum 진입 조건을 C3 룰로 역추출·shadow 비교 ③단 기존 sentiment/fundamental 의존부는 C6(LLM 결정권 박탈)·C5(스코어 융합) 원칙과 조율. ※autotune이 손익을 가른 핵심 메커니즘(mean_reversion 활성화 17→151)의 파라미터 변화 정밀 분석은 후속 과제.


### 8-7. ★동적 전략 선택 — 기존 인프라 발견 + 재설계 방향 재정의 (2026-06-19 메티)
> **마스터 철학: 시스템은 다양한 전략을 동적으로 최적 선택·적용하는 유연성을 가져야 한다.** 이 관점으로 재분석한 결과 — 핵심 인프라가 이미 존재.

**★ 기존 시스템에 이미 레짐별 동적 전략 선택 인프라 존재(중대 발견)**:
- `strategy-router.buildRegimeBias(regime, exchange)`(502줄): 레짐별 전략 가중치 동적 부여 — trending_bull(binance){trend_following 0.24·momentum 0.18·breakout 0.14·mean_reversion −0.04} / ranging{mean_reversion 0.24·micro_swing 0.08} / trending_bear{defensive 0.30·mean_reversion 0.10·momentum −0.12}.
- `regime-weight-learner`(388줄·매일 07:00 `ai.luna.weight-adaptive-tuner-daily-0700`): 레짐별 fusion+signal 가중치 DB 학습. BASE_SIGNAL_WEIGHTS — TRENDING_BULL{momentum 0.35·breakout 0.30·mean_reversion 0.15·defensive 0.20} / TRENDING_BEAR{momentum 0.15·mean_reversion 0.30·defensive 0.40} / RANGING{mean_reversion 0.50·momentum 0.15} / VOLATILE{defensive 0.45}. → `luna_regime_weight_snapshots`·`luna_weight_vector_shadow`.

**★ 실거래 데이터가 동적 가중치 설계를 검증(레짐 × 전략 post_autotune USD)**:
| 레짐 | 최적 전략(실거래) | 순익 | 기존 가중치 정합 |
|---|---|---|---|
| trending_bull | momentum_rotation | +$1,663(167건) | momentum 0.35 ✓ |
| ranging | mean_reversion | +$532(83건) | mean_reversion 0.50 ✓ |
| trending_bear | mean_reversion | +$900(65건) | mean_reversion 0.30+defensive 0.40 ✓ |
| volatile | defensive_rotation | +$60(5건) | defensive 0.45 ✓ |
→ **기존 레짐별 가중치가 실거래 성과와 정합 = 동적 전략 선택이 실제 작동 중**. momentum은 상승장 전용(ranging/bear 0), mean_reversion은 횡보+하락장 수익 → **단일 전략 불가·레짐 적응 필수** 데이터 확증.

**★ 재설계 방향 재정의(마스터 철학 반영 — 핵심 전환)**:
- 재설계 C3를 turtle/testah(추세 단일)로 좁히면 **기존 동적 선택을 오히려 후퇴**시킴(상승장만 커버·횡보/하락 무방비).
- **올바른 방향 = 레짐 적응형 전략 포트폴리오 + 동적 가중**:
  1. 기존 `regime-weight-learner`의 레짐별 동적 전략 선택을 C2(레짐)→C3(전략군) 파이프라인의 **1급 자산으로 승격**(신설 아닌 재사용·강화).
  2. C3 전략군을 momentum/mean_reversion/defensive/추세(turtle/testah) **전부 포함**(현 turtle/testah만 → 확충).
  3. C8 성과 피드백 → 레짐별 가중치 동적 학습 강화(regime-weight-learner + C8 outcome 연결).
  4. autotune(가중치 학습·07:00)을 C15 승격 게이트·shadow 비교와 연결.
- 즉 "단일 최적 전략 탐색"이 아니라 **"레짐 적응형 전략 포트폴리오의 동적 가중 최적화"** — autotune이 손익을 가른 메커니즘(레짐별 가중치 재조정)과 정확히 일치하며 마스터 비전과 합치.

**후속 확인 과제**: ①regime-weight-learner 실가동·가중치 학습 현황(luna_regime_weight_snapshots 데이터) ②buildRegimeBias가 재설계 C3 신호 생성에 연결되는지 ③autotune이 학습한 가중치 vs BASE 가중치 차이(무엇을 동적 조정했나).


### 8-8. ★자가 학습 루프 이중 단절 — 진단 + 자가발전 수정 설계 (2026-06-19 메티)
> **trading OS 자가발전의 핵심 결함.** regime-weight-learner는 매일 가동하나 학습이 0(가중치 BASE 영구 고정)이며, 설령 학습돼도 실거래에 반영되지 않음. AI OS 비전(각 팀=자가발전 독립 OS)의 첫 검증 대상에서 자가발전 메커니즘 자체가 끊겨 있음을 발견.

**진단**: `luna_regime_weight_snapshots` 100개 스냅샷 분석 — 4개 레짐(TRENDING_BULL/BEAR·RANGING·VOLATILE) 전부 가중치 변화 0(초기=최신), total_trades 0~1, performance_metric 0.

**원인 1 — 학습 단계 정지(7일 윈도우 × 3건 임계치)**:
- `fetchRegimeTradeStats(days=7)`: `to_timestamp(exit_time/1000) >= NOW()-'7 days'` → 최근 7일 거래만 조회.
- `adjustWeightsFromPerformance`: `if (totalTrades < 3) { updated=BASE; continue; }` → 레짐별 3건 미만 시 학습 스킵.
- 검증(가드 통과 학습가능 거래·레짐별): 7일=ranging 1·bear 1(**전부 스킵**) / 30일=bear 5·ranging 4 학습O·bull 2·volatile 1 스킵 / **90일=bull 151·bear 53·ranging 51·volatile 3(전부 학습O)**.
- 최근 거래 빈도 한산(6월 주별 12~26건, 거래 집중은 4~5월) → 7일/3건 미달 → 전 레짐 학습 영구 스킵.

**원인 2 — 적용 단계 단절(strategy-router가 학습값 미참조)**:
- `strategy-router` import = signal·trade-journal-db·external-evidence-ledger뿐 — **학습 모듈(regime-weight-learner·ta-weight-adaptive-tuner) 미import**.
- DB query 호출 = **0**(SELECT/investment. 미접근) → 학습값 읽을 경로 부재.
- `buildRegimeBias`(line 62, 레짐별 전략 가중 하드코딩)를 line 306에서 점수 반영 → **snapshot 학습값 어디에도 미반영 확정**.
- `retrieveAdaptedWeights` 소비처 = learner·tuner·winrate-tracker·스모크뿐(실거래 라우팅 없음).

**결론: 학습해도 안 쓰고(적용 단절), 쓰려 해도 학습이 안 됨(학습 정지) = 자가발전 폐루프 부재.** 현재 "레짐별 동적 전략 선택"은 BASE 하드코딩에 고정(=정적). 8-7에서 발견한 동적 선택 인프라가 실제로는 정지 상태.

**자가발전 수정 설계(루나 trading OS 1순위)**:
1. **[학습 재가동]** `fetchRegimeTradeStats` 윈도우 7→90일 또는 적응형(임계치 충족까지 확장). 90일이면 전 레짐 학습 즉시 가능(검증완료).
2. **[적용 연결]** `buildRegimeBias`가 `luna_regime_weight_snapshots` 최신 가중치를 읽어 BASE에 블렌딩(α·learned + (1−α)·base). 학습→실거래 경로 신설.
3. **[콜드스타트]** 전체 이력 부트스트랩 후 최근 가중 점진 업데이트 — 데이터 적어도 학습 시작(7일 윈도우 콜드스타트 영구정지 방지).
4. **[자가진단]** 학습 활성도(total_trades·가중치 Δ) 자체 모니터링·경보 — 무징후 정지(현 사실상 학습 0) 자동 감지. **OS는 자기 상태를 알아야 한다.**
5. **[폐루프 검증]** 학습→적용→성과(C8 feedback)→재학습 사이클 실가동 확인.
6. **[메타학습]** 윈도우·임계치·learn_rate를 성과로 자가 조정 — 학습의 학습(진정한 self-evolution).

→ **이 자가발전 폐루프 복원이 C2/C3 재설계의 전제 조건.** 폐루프 없이는 "동적 최적 전략 선택"이 정적 BASE에 머무름. AI OS 비전상 루나가 "자가발전하는 독립 trading OS"가 되려면 1~6이 루나 OS의 자가발전 엔진을 구성.


### 8-9. ★shadow 병행 + 자동승급 등록 — learned bias를 self-evolution 컴포넌트로 (2026-06-20 메티)
> **마스터 결정: shadow 관찰(1) + 자동승급 등록(2) 병행.** learned bias를 사람이 off→shadow→active 수동 전환하는 대신, 자동승급 시스템(luna_component_registry)이 증거 기반으로 스스로 승급. 진정한 self-evolution.

**자동승급 시스템 구조(기존 자산)**:
- `luna_component_registry`(44 컴포넌트): component·current_mode·target_mode·promotion_criteria·sample_count·status(active 고정, 6-state 런타임 계산).
- `luna-registry-seed.ts`: 컴포넌트 정의(idempotent). `runtime-luna-registry-evaluator.ts`: `EVIDENCE_QUERIES`(컴포넌트별 COUNT SQL) → `proposalForRow`(6-state) → DB status 직접 미기재.
- 동형 패턴 다수: strategy-router-phase-a-influence(diagnostic→shadow_bias), regime-expansion-shadow-sim, strategy-family-turtle(virtualExpectancyDeltaPositive).

**learned-regime-bias 등록 설계**:
- registry-seed에 `{ component:'learned-regime-bias', shadow→active_router_bias, criteria:{durationWeeks:4, minSamplesPerFamilyRegime:30, virtualExpectancyDeltaPositive:true, evidence:'luna_regime_weight_snapshots'} }` 추가.
- evaluator EVIDENCE_QUERIES에 `'learned-regime-bias': COUNT(*) FROM luna_regime_weight_snapshots WHERE total_trades>=3` 추가(학습 발생 스냅샷 = 증거).
- 승급 흐름: shadow → evaluator sample 누적 → measurement_only → accumulating → evidence_pending → promotion 제안(알림) → 마스터 검토 → active.

**병행 운영**:
- (1) 관찰: 매일 07:00 학습 누적(BEAR/RANGING 샘플 증가 모니터링).
- (2) shadow: `LUNA_LEARNED_BIAS_MODE=shadow`(plist) → strategy-router diff 기록(거래영향 0) + registry 자동승급 추적.

**1차 범위/한계**: promotion은 제안 알림까지, active 자동 적용은 미포함(마스터 승인 유지). virtualExpectancy 실측은 후순위(1차는 sample_count). active 자동화는 검증 누적 후 별도 단계.
> 코덱스 프롬프트: docs/codex/CODEX_LUNA_LEARNED_BIAS_AUTOPROMOTION.md. self-evolution loop 복원(§8-8)은 docs/codex/archive/로 아카이빙 완료.


### 8-10. ★암호화폐 실거래 손실 — 정밀 근본원인 분석 (2026-06-20 메티)
> 마스터 지시: 시계열·전략·프로세스·데이터적재·포지셔닝·실제계좌비교 복합 분석 + 실제계좌 API 검증 로직 존재여부 체크.

**증상**: 5주 연속 손실(승률~0%, 합계 ~-$28), 이번주 binance 실거래 2전2패 -$17.67(NIGHT -8.5%·BABY -7.2%), journal_reconciled_no_position 25건, positions 테이블 0건, trade_journal open 6건(장부) vs positions 0(실제).

**근본원인 (다층 복합)**:

**① 전략 레벨 — 레짐-전략 미스매치 (손실 직접원인)**:
- 현재 crypto 레짐 trending_bull(conf 0.69)인데 작동 전략은 defensive_rotation(방어).
- 레짐 추이: 06-14 bull → 06-17~19 bear → 06-20 bull (며칠 단위 요동) → 전략이 항상 한 박자 지연(06-19 bear에 defensive 진입 → 06-20 bull 전환 시 부적합).
- 수익전략 momentum_rotation 최근 30일 0건(소멸), 손실전략만 작동(defensive -$11.97 2승5패·micro_swing -$9.58·trend_following -$6.28).
- 동적 전략선택 미작동(06-19까지 regime-weight-learner 학습정지, §8-8에서 복원). → 레짐 적응 실패가 손실 핵심.

**② 데이터 정합 레벨 — 장부-실제 불일치**:
- trade_journal open 6건: entry_value($106~122)·tp_sl_set=true 기록(진입성공으로 장부 기재).
- positions 테이블 0건: 실제 거래소 추적 포지션 없음.
- journal_reconciled_no_position 25건(06-10~19 진입분): 장부 기록됐으나 실제 없어 사후 정리.
- signal_to_exec_ms NULL: 실행시간 미기록(실행추적 약함).
- → **장부는 진입성공인데 실제는 미체결/없음**(핵심 모순).


**③ 실행/검증 레벨**:
- 주문실행: MCP 브리지(scripts/binance-market-mcp-server.py · runBinanceMcpBridge) 또는 ccxt createOrder.
- `createBinanceMarketBuy/Sell`이 주문결과 반환만 — **주문직후 체결검증(filled>0 확인·미체결 재시도) 부재**(binance-client.ts:366,412). 상위가 filled 미확인 시 미체결을 장부 open 기록.

**④ 실제계좌 API 검증 로직 존재여부 (마스터 핵심 질문) — 존재함, 다층**:
- `position-sync.syncPositionsAtMarketOpen`(position-sync.ts:253): `getBinanceExchange().fetchBalance()`(실제잔고) ↔ DB positions 비교 → 불일치 시 `db.deletePositionsForExchangeScope`(stale_db_position). autopilot이 crypto 포함 호출(DEFAULT_POSITION_SYNC_MARKETS, autopilot:573).
- `reconcile-open-journals`(626줄): trade_journal open ↔ 실제, breakeven 청산(closeEntryAtBreakeven). runtime-luna-ops-scheduler · process-integrity-loop가 호출(launchd 직접 미등록).
- `binance-order-reconcile`/`binance-pending-reconcile-queue/units`: 주문단위 체결 정합.
- **구조적 한계**: ⓐ 사후 정리 위주(불일치 발생 자체 예방 못함) ⓑ 주문직후 실시간 체결검증 약함 → 미체결을 장부에 진입성공 기록 후 reconcile 정리 ⓒ position-sync 함수명 "AtMarketOpen"이라 24시간 crypto 주기성 의문.

**미해결 핵심 (추가조사 필요)**:
- **왜 주문이 미체결되나?** entry_value·tp_sl_set 기록됐으나 positions 0. MCP 브리지(binance-market-mcp-server.py) 실제 송신여부 · 실행모드(live/mock/paper) · capital 부족 · 최소주문금액 미달 확인 필요.
- syncPositionsAtMarketOpen이 24시간 crypto에 실제 주기 작동하는지(호출 빈도·트리거).

**처방 우선순위**:
1. **[실행검증]** 주문직후 체결검증 추가 — filled>0 확인, 미체결 시 journal open 미기록 또는 재시도/실패기록.
2. **[근본조사]** MCP 브리지 실제 송신·실행모드 점검(미체결 근본원인 = 25건 반복의 핵심).
3. **[전략]** 동적 전략선택(§8-8 복원분) 효과로 레짐적응 개선 관찰 + momentum 비활성 원인 규명.
4. **[정합]** positions 실시간 동기화 주기 강화(시장개장 시 → 주기적), trade_journal↔positions↔실제잔고 3자 정합 모니터.
> 결론: reconciliation은 풍부히 존재하나 **사후 정리 중심**이라 손실·불일치를 예방하지 못함. 핵심은 ①전략 레짐적응 실패(손실) + ②주문 체결검증 부재(불일치). 미체결 근본원인(MCP/실행모드/capital)이 다음 최우선 조사 대상.


### 8-11. ★국내/국외 확대 + 근본원인 심화 (2026-06-20 메티)
> 마스터 지시: 국내장·국외장 확대 체크 + 설계 차원 근본원인 분석.

**시장별 정합 비교 (최근 30일, 실거래 is_paper=false)**:
| 시장 | open 장부 | reconciled | strategy | cleanup | 불일치 |
|---|---|---|---|---|---|
| binance | 6 | **67** | 10 | 67 | 🔴 심각 |
| kis(국내) | 0 | 0 | 1 | 0 | ✅ 없음 |
| kis_overseas(국외) | 0 | 0 | 1 | 0 | ✅ 없음 |

**핵심: 장부-실제 불일치는 암호화폐 고유**:
- kis-adapter `placeOrder: disabled`(kis-adapter.ts:95) → 국내장 주문 자체 비활성 → 거래 거의 없음(30일 1건) → 불일치 없음(거래를 안 하니 당연).
- binance만 reconciled 67·cleanup 67 = 주문이 장부 기록되나 실제 미반영.

**실행모드 확정 (paper/testnet 가설 기각)**:
- `applyDevSafetyOverrides`(secrets.ts:120): `if (env.IS_OPS) return secrets` → OPS 머신은 paper/testnet 강제 건너뜀 = **real mainnet 실거래**.
- `binance-client.getBinanceExchange`(binance-client.ts:104)·`position-sync.getBinanceExchange`(position-sync.ts:19) 둘 다 testnet/sandbox 미적용 = mainnet real.
- → 주문도 잔고조회도 mainnet real. paper/testnet 불일치 가설 기각.

**reconciled 67건 패턴**:
- **전부 defensive_rotation**, entry_value $110~112 알트(MEGA·XLM·ENA·XPL·WLD), quality_flag=exclude_from_learning.
- 진입~정리 시간차 avg 49h(min 1m·max 8.7d) → 즉시 미체결 아닌 시간 경과 후 "실제 포지션 없음" 발견.
- → **defensive_rotation 진입이 장부 기록되나 실제 포지션 미반영**(불일치 집중점).

**근본원인 (설계 관점)**:
1. **주문-기록 정합 결함**: 진입이 trade_journal에 open 기록되나 실제 포지션 미반영. 주문 직후 체결검증(filled>0) 부재 → 미체결/실패도 진입으로 기록.
2. **defensive_rotation 실행경로 집중**: reconciled 67건 전부 defensive_rotation → 이 전략의 진입 실행/체결에 문제 집중(다른 전략은 정상 체결되나 defensive만 불일치). 전략별 주문 실행경로 차이 의심.
3. **실시간 정합 부재**: reconcile 사후 정리만(진입~정리 평균 49h 지연) → 불일치를 실시간 차단 못함.
4. **국내장 비활성**: kis placeOrder disabled → 국내장 거래 자체 막힘(의도/사고 확인 필요).
5. **positions 테이블 미사용**: 3개 시장 모두 0행 → 실제 포지션 추적이 trade_journal + broker API 직접에 의존, 단일 정합 소스 부재.

**보강 설계 (우선순위)**:
1. **[체결검증]** 주문 직후 `filled>0`·status 확인 → 성공 시에만 journal open 기록, 미체결/실패 시 미기록 + 재시도 + 실패로그(원인 보존).
2. **[전략경로 추적]** defensive_rotation 진입→주문→체결→기록 전체 경로 추적 — 왜 이 전략만 67건 불일치(실제 주문 송신 여부·체결 확인·전략별 실행 분기).
3. **[실시간 정합]** 진입 직후 실제 포지션 확인 + reconcile 주기 단축 + trade_journal↔실제잔고 단일 정합 소스.
4. **[국내장]** kis placeOrder disabled 원인·활성화 검토(국내장 OS 정상화).

**다음 최우선 조사**: defensive_rotation 진입 실행경로(왜 이 전략만 67건 불일치) — 실제 binance 주문 송신 여부·체결 응답·전략별 실행 분기 추적. 이것이 암호화폐 손실/불일치의 핵심 미규명 지점.
> 국내/국외 확대 결론: 불일치는 암호화폐 전용(국내장은 placeOrder disabled로 거래 부재). 따라서 ①암호화폐 defensive_rotation 체결경로 ②국내장 활성화가 2대 과제.


### 8-12. ★체결경로 7단계 추적 — 매수 생애주기 책임 분산 (2026-06-20 메티)
> 마스터 7단계 흐름 기준 소스 정밀 점검: 전략→매수→매수후검증→포지션유지→매도→매도후검증→(암호화폐)더스트→피드백.

**7단계 흐름 소스 매핑**:
| 단계 | 구현 모듈 |
|---|---|
| 1.전략수립 | shared/unified-analyst.ts, strategy-router.ts (defensive_rotation 분류) |
| 2.매수 | team/hephaestos/signal-executor.ts:422 marketBuy → market-order-execution.ts → binance-client.createBinanceMarketBuy |
| 3.매수후검증 | ⚠️분산 — normalize pendingError + pending-reconcile 6파일 + persistBuyPosition(walletTotal) + execution-attach |
| 4.포지션유지 | execution-attach.ts, protective-exit.ts, position-reevaluator.ts |
| 5.매도 | executeSellTrade, market-order-execution.marketSell |
| 6.매도후검증 | finalizeExecutedTrade, telegram-trade-alerts.ts(부분청산 기록) |
| 7.더스트(암호화폐) | cleanupDustLivePosition, portfolio-position-delta.ts |
| 8.피드백 | regime-weight-learner (C8, 복원완료) |

**★근본원인 — 매수 생애주기 책임 분산**:
매수 실행/체결검증/journal기록이 단일 트랜잭션이 아닌 여러 모듈에 흩어짐.
- 매수 실행(signal-executor.ts): marketBuy → persistBuyPosition(walletTotal 기반 positions 관리) → attach. **trade_journal 직접 기록 없음**
- journal 기록(insertJournalEntry, trade-journal-db.ts:559): signal.ts:450·hanul.ts:1293/1800·telegram-trade-alerts.ts에서 호출 — **매수 실행 경로 밖**
- 체결 검증: normalize(미체결 pendingError throw) + attach(execution-attach.ts:48 실제 포지션 없으면 throw 아닌 조용한 `attached:false`)
→ 매수 실행과 journal 기록이 비동기·분리 → 정합 사각지대

**확인된 결함 지점**:
- signal-executor.ts:426 `settledUsdt = order.cost || filled*price || actualAmount` ← 미체결(filled=0)을 요청금액으로 폴백
- execution-attach.ts:48 실제 포지션 없으면 조용한 attached:false (검증 실패가 차단 안 됨)
- signal-executor.ts:442-450 attach `.catch(warn)` — throw만 잡고 attached:false 무시
- journal 기록 주체가 매수 경로 밖 → 체결 검증과 독립 진행

**검증 메커니즘은 정교하나 우회 가능**: pending-reconcile 6파일(context/core/ledger/runner/retry) + live-position-reconcile + position-sync(market open fetchBalance↔DB). 단 경로 분산으로 일부 매수가 게이트 통과 전 journal 기록 → 67건 reconciled.

**보강 설계 (우선순위)**:
1. [생애주기 통합] 매수→체결검증(filled>0 + fetchBalance 실제포지션)→journal open을 단일 순서로, 검증 실패 시 기록 거부 + pending-reconcile 등록
2. [검증 게이트] execution-attach attached:false(포지션 없음) 시 journal open 미기록 — 조용한 실패를 명시적 차단으로
3. [폴백 제거] signal-executor.ts:426 settledUsdt actualAmount 폴백 제거 (filled=0이면 진입 거부)
4. [책임 일원화] journal 기록을 매수 실행 경로로 통합 (telegram-alerts/hanul 분산 제거)

**다음 최우선**: 매수 open 정확한 기록 주체(hanul.ts:1293·telegram-alerts:349) 핀포인트 + marketBuy 결과와의 순서 → 67건 생성 지점 확정.
> 자기수정: telegram-trade-alerts.ts:252는 매수 open이 아닌 부분청산 기록으로 확인됨(realizedSize·pnlAmount). 매수 open 기록 주체는 추가 핀포인트 필요.


### 8-13. ★매수 open 기록 주체 핀포인트 + 체결검증 부재 확정 (2026-06-20 메티)
> 마스터 지적: "텔레그램은 알림 수단인데 기록은 이상하다" → 정확히 핵심을 짚음.

**telegram-trade-alerts.ts 실제 정체 (이름 ≠ 역할)**:
- 파일 주석: "Trade notification AND journal settlement helpers... owns the post-fill reporting contract" → 이름은 알림이나 실제는 **"체결 후(post-fill) 보고 + journal 정산" 모듈**. 알림과 DB기록을 한 모듈에 묶음 = **책임 혼재**(마스터 지적이 옳음).
- 매수 open 기록 진짜 주체: `recordExecutedTradeJournal`(line 349, `if (trade.side==='buy')` 블록)
- 호출처: hephaestos.ts:548, pending-reconcile-ledger.ts:266, 내부 466

**★근본원인 확정 — 체결 검증 없는 기록**:
recordExecutedTradeJournal(349~380)이 "Executed(체결됨)" 이름과 달리 실제 체결을 검증하지 않음:
- `entry_size: trade.amount || 0` ← filled=0이어도 0으로 기록
- `entry_value: trade.totalUsdt || 0` ← signal-executor.ts:426 `settledUsdt = ... || actualAmount` 폴백된 값(미체결도 요청금액 $110)
- 유일한 검증(378): `getJournalEntryByTradeId` = **DB에 INSERT 됐는지만** 확인 (실제 거래소 체결/포지션 확인 아님!)
→ 미체결/부분체결 매수가 entry_value $110로 trade_journal open 기록 → 67건 reconciled의 정확한 메커니즘

**보강 설계 (정밀)**:
1. [체결검증 추가] recordExecutedTradeJournal 진입 시 `trade.amount(filled) > 0` 검증 → 0이면 journal 기록 거부 + pending-reconcile 등록
2. [폴백 제거] signal-executor.ts:426 settledUsdt actualAmount 폴백 제거 → filled=0이면 진입 자체 거부
3. [실제 포지션 확인] getJournalEntryByTradeId(DB 확인) 외 fetchBalance 실제 포지션 확인을 기록 전 게이트로 추가
4. [책임 분리] journal 기록을 telegram-trade-alerts(알림 모듈)에서 분리 — 알림 ≠ 기록

**다음 확인**: pending-reconcile-ledger.ts:266 경로 — 미체결 처리 중 recordExecutedTradeJournal 호출이 67건 진입 경로인지 확정(normalize가 filled=0 시 pendingError throw하므로, 직접 경로보다 recovery/부분체결 경로 의심).
> §8-12 자기수정 정정: telegram-trade-alerts.ts는 부분청산(252)뿐 아니라 recordExecutedTradeJournal(349)로 매수 open도 기록. 매수 open 기록 주체 = 이 모듈로 확정.


### 8-14. ★책임 분리 + 정리 + 효율 보강 설계 (2026-06-20 메티)
> 마스터 지시: ①알림/기록 함수 분리 ②불필요 함수·로직 정리 ③7단계는 멘탈 모델 — 시스템이 이미 정교하면 효율 방향으로 보강.

**telegram-trade-alerts.ts 구조 진단 (9함수, 계층 확인)**:
| 함수 | 역할 | 관계 |
|---|---|---|
| closeResolvedJournalEntry(54) | 청산 코어 | ← closeOpenJournalForSymbol(156)·settleOpenJournalForSell(225) 공통 호출 |
| closeOpenJournalForSymbol(128) | 심볼 청산 진입점 | 기록 |
| settleOpenJournalForSell(171) | 매도 정산 진입점 | 기록 |
| recordExecutedTradeJournal(341) | 매수 기록(sell은 settle 위임406) | 기록 ⚠️체결검증 결함 |
| notifyExecutedTrade(322) | 체결 알림 | 알림(유일) |
| finalizeExecutedTrade(441) | 알림(463)+기록(466) 조합 | 오케스트레이터 |
| toEpochMs·dust 3개 | 유틸 | - |
→ 청산 3함수는 중복 아닌 **계층**(코어1 + 진입점2). 이름은 "알림"이나 실제는 정산6 + 알림1. hephaestos.ts는 얇은 wrapper(478·500·543·547·551).

**A. 책임 분리 설계 (알림 ≠ 기록)**:
1. **journal 정산/기록 모듈 신설**(예: `trade-journal-settlement.ts`): closeResolvedJournalEntry·closeOpenJournalForSymbol·settleOpenJournalForSell·recordExecutedTradeJournal + 유틸(toEpochMs·dust)
2. **알림 모듈**(telegram-trade-alerts.ts → 순수 알림으로 축소): notifyExecutedTrade
3. **finalizeExecutedTrade**(오케스트레이터): 정산 모듈 + 알림 모듈을 조합 호출 — line 463 notify·466 record를 각 모듈에서. 위치는 별도 orchestrator 또는 hephaestos.ts.
→ 알림과 DB기록이 물리적으로 다른 파일

**B. 불필요 함수·로직 정리**:
- hephaestos.ts wrapper 층(478·500·543·547·551)은 telegram-trade-alerts 재노출 — 분리 후 import 경로 정리, 단순 재노출 wrapper 제거 가능성
- 청산 3함수는 계층이므로 **유지**(통합 금지 — 역할 분담된 정교한 구조)
- 미사용 export·dead code는 구현 시 정적 분석(tsc noUnusedLocals + 호출 그래프)으로 식별

**C. 효율 보강 (현재 정교 구조 유지, 결함만 외과적)**:
1. recordExecutedTradeJournal: 체결검증(`trade.amount>0`) 추가 → 0이면 journal 기록 거부 + pending-reconcile 위임
2. signal-executor.ts:426: settledUsdt actualAmount 폴백 제거 → filled=0이면 진입 거부
3. 기존 pending-reconcile 6파일·position-sync·execution-attach 정교 구조는 그대로 유지

**D. 7단계 vs 현재 — 효율 방향 (마스터 철학 반영)**:
- 현재 시스템은 마스터 7단계를 이미 더 정교하게 구현(pending-reconcile 6파일·execution-attach·position-sync·normalize). 7단계는 멘탈 모델이므로 강제하지 않음.
- 효율 방향 = 전면 재작성 ❌, 결함(체결검증 부재·책임 혼재)만 외과적 보강 ✅.

**다음**: 코덱스 프롬프트 — ①정산/알림 모듈 분리 ②recordExecutedTradeJournal 체결검증 추가 ③settledUsdt 폴백 제거. 마스터 승인 후 구현.


### 8-15. ★포지셔닝/매수매도/피드백 추가 보완점 (2026-06-20 메티)
> 마스터 지시: 포지셔닝·매수매도·피드백 추가 보완점 정밀 분석(데이터+소스).

**데이터 진단 (binance 30일, is_paper=false)**:
| 영역 | 지표 | 상태 |
|---|---|---|
| 매도 TP/SL | tp_sl_set=true 81건·에러 0 | ✅ 건강 |
| 피드백 학습품질 | trusted 48 vs exclude_from_learning 33(41%) | 🔴 손실 |
| 포지셔닝 sizing | $50~122 일관 / defensive_rotation 58%(47/81) 편중 | 🟡 |

**★보완점 1 — 피드백 학습 데이터 41% 손실 (매수 연쇄)**:
- exclude_from_learning 33건 = **전부 reconciled**(no_position 31 + duplicate_open 2) = 매수 체결/정합 실패
- 인과: 매수 체결검증 부재 → 미체결 → exclude_from_learning → 학습 데이터 41% 손실의 직접 연쇄
- 학습 가능 데이터: 30일 41건(regime당 ~8 부족) / 90일 277건(충분)
- **§8-13 매수 체결검증 보강이 피드백 손실도 동시 해결**(단일 보강 이중 효과). 적응형 윈도우(30→90, 복원완료)가 데이터 부족 추가 보완.

**보완점 2 — 포지셔닝 전략 편중**:
- defensive_rotation 58%(47/81) 편중, momentum(13)·trend(9)·breakout(2) 과소
- 현재 trending_bull regime인데 defensive 과다 = 동적 전략 선택 미흡
- learned-regime-bias(shadow, 복원완료) active 전환 시 개선 → auto-promotion 6-state(accumulating 21/30) 추적 중
- sizing 자체는 일관적($50~122), TP/SL 에러 0 → capital 반영은 정상

**보완점 3 — 매도 (양호, 대칭 점검 권장)**:
- TP/SL 설정·에러 건강(81건 에러 0). 큰 결함 미발견.
- (점검 권장) 매도 후 검증(settleOpenJournalForSell)에서 실제 체결량(soldAmount) 검증이 매수와 대칭적으로 있는지 — 매수 체결검증 부재가 매도에도 대칭일 가능성. 코덱스 구현 시 동시 점검.

**종합 — 보강 우선순위 (이중효과 반영)**:
1. **매수 체결검증(§8-13)** = 매수 정합 + 피드백 41% 손실 **동시 해결** → 최우선(이중 효과)
2. 책임 분리(§8-14) = 알림/기록 분리 + wrapper/미사용 정리
3. learned-bias active 전환 = 포지셔닝 전략 편중 개선(auto-promotion 진행 중)
4. (점검) 매도 후 검증 대칭성 — 매수 보강과 함께 검토

> 핵심 통찰: 포지셔닝·피드백 보완점이 대부분 **매수 체결검증 부재의 2차 효과**로 수렴. §8-13 매수 보강이 가장 높은 레버리지(매수+피드백+정합 동시 개선). 매도는 독립적으로 양호.


### 8-16. ★★67건 완전 재규명 — 근본원인은 "TP/SL 청산의 무조건 학습 제외" (2026-06-20 메티)
> 미규명 2가지 심층 분석으로 §8-13/8-15의 "매수 체결검증 부재" 결론을 정정. 3차 분석 끝에 확정.

**67건의 진실 (가설 2회 기각 후 확정)**:
- 미체결❌(entry_size 전부 양수 size_positive 64), 매도누락❌(exit_value 64건 전부 존재), 유령❌
- **실제 TP/SL 청산 거래**: profit 9건(+$6.31, TP 도달)·near_zero 34건(-$0.03)·loss 21건(-$3.16, SL 도달), 전체 ~-$10.6
- incident_link `fetchMyTrades_orderid:match=order_id:fills=1~7` = fetchMyTrades로 실제 체결 fill 매칭 확인됨

**메커니즘**:
1. 매수 정상 체결(fills 있음)
2. TP/SL OCO 주문 거래소 설정(protective-exit.ts extractOcoOrderIds, tp_sl_set=true 81건 에러0)
3. TP 또는 SL이 **거래소에서 자동 체결** → 포지션 청산
4. 시스템이 실시간 감지 못함 → trade_journal open 유지
5. cleanup/pending-reconcile이 binance-fill-resolver(fetchMyTrades VWAP)로 청산 발견 → journal close (avg 49h 지연)
6. exit_reason='journal_reconcile:fetchMyTrades...', execution_origin='cleanup'

**★근본원인 (확정) — pending-reconcile-ledger.ts:40**:
`excludeFromLearning: true`(무조건), qualityFlag='degraded'
- TP/SL 자동 청산이 pending-reconcile 경로로 정산되면 **무조건 학습 제외**
- binance-fill-resolver가 정확한 VWAP·pnl 계산(profit/loss 정상 구분)하는데도 exclude
- → 정상 TP/SL 청산이 학습 데이터 41% 손실(exclude 33건 전부 reconcile)
- 학습 사용처(luna-loss-circuit:154, trade-journal-db:810/850, trade-data-derived-guards:350)가 exclude 필터 → 67건 학습 누락

**자가진화 영향 (치명적 — 마스터 비전 직결)**:
- TP/SL 청산 = 전략 성과의 핵심 피드백(진입 전략이 실제 수익/손실을 냈는가)
- 무조건 exclude → 학습기(regime-weight-learner)가 실제 청산 성과 못 배움
- 자가진화 루프 반쪽: 진입 학습 O, 청산 결과 X

**미규명 2가지 답**:
1. settleOpenJournalForSell 매도 대칭성: 시스템 매도는 정상(order.filled 기반). **TP/SL 자동 청산은 이 정상 매도 경로를 안 타고 pending-reconcile로 처리** → reconcile+exclude. 대칭성 문제가 아니라 청산 경로 분리.
2. pending-reconcile-ledger 경로: TP/SL 청산 사후 정산(ensurePendingReconcileJournalRecorded:266, runner가 fetchOrder로 정확 체결확인) + 무조건 exclude(40) = 67건 진입+제외 경로.

**진짜 보완점 (최종 재규명)**:
1. **[학습 포함]** pending-reconcile-ledger:40 무조건 exclude 재검토 — fetchMyTrades fill 정확 매칭된 청산(fills 있음)은 trusted로 학습 포함, 진짜 불확실(fill 미매칭)만 exclude
2. **[실시간 감지]** TP/SL 자동 청산 실시간 감지 — 사후 49h → 단축(fill-resolver 주기 단축 또는 OCO 체결 모니터)
3. **[청산 경로 정합]** TP/SL 자동 청산을 정상 close로 인식(reconcile 아닌 정상 매도 플로우)

**§8-13/8-15 정정**: "매수 체결검증 부재가 67건+학습손실 원인"은 틀림. 매수는 정상 체결됨. 실제 원인은 **TP/SL 청산의 무조건 학습 제외**(pending-reconcile-ledger:40). 매수 체결검증(§8-13)은 67건과 무관 — 단 normalize 체결검증 자체는 별개로 유효한 안전장치로 유지 가치.


### 8-17. ★1주 손실 원인 진단 — 시장 vs 전략 vs 프로세스 (2026-06-20 메티)
> 마스터 질문: 1주 실제 손실의 원인이 시장상황/전략/프로세스 중 무엇인가.

**1주 손익 집계 (exit_time 7일, binance, is_paper=false)**:
| 구분 | 건수 | 장부 손익 |
|---|---|---|
| 전체 | 27 | **-$17.67** |
| normal_exit(정상청산) | 2 | **-$17.67** (실제 손실 전부) |
| reconcile(지연정산) | 25 | **$0.00** (은폐) |

**★주원인 = 프로세스 (fill-resolver 미실행 → 손익 은폐, 확정)**:
- reconcile 25건 전부 **exit_value=entry_value 복사**(STG 113→113·PEPE 110→110 등) → pnl 0
- exit_match_source 없음(unresolved) — fill-resolver가 실제 청산 VWAP 미계산
- **fill-resolver 주기 실행 launchd 부재** → reconcile pnl 자동 미계산
- 1주 25건 전부 unresolved, 30일 33/64 unresolved(절반)
- → 실제 TP/SL 손익이 장부에 0으로 은폐 = **손익 가시성 붕괴**. 마스터 체감(손실 큼) vs 장부(-$17.67) 괴리 = 미계산 reconcile 손익.

**부원인 = 전략 (SL 도달 손실)**:
- 손실 2건 모두 SL 수준: NIGHT/USDT(micro_swing) -$9.58(-8.5%, 06-14), BABY/USDT(defensive_rotation) -$8.09(-7.2%, 06-19)
- 진입 후 -7~8.5% 하락 = 진입 타이밍/종목 선택 약점. micro_swing 변동성 큰 알트 진입.

**시장 상황 (약세 신호)**:
- 손실 2건 모두 SL 도달 = 하락/변동성 장세. 06-14·06-19 약세.
- 1주 16종목 분산 알트(변동성 노출). market_regime_snapshots 추가 확인 권장.

**진단 결론**:
1. **프로세스가 주원인** — 손실 자체보다 "손익 가시성 붕괴"가 핵심. fill-resolver 미실행으로 실제 손익(reconcile 25건)이 장부에 안 잡혀 손실 규모 불명. **실제 손실은 장부 -$17.67보다 클 가능성**(reconcile 미계산분).
2. 전략 부분 — SL 도달 손실(변동성 알트).
3. 시장 약세 — SL 빈발 = 하락 장세.

**보강 (프로세스 우선)**:
1. **[fill-resolver 주기 실행]** reconcile 거래 실제 VWAP/pnl 계산을 주기 launchd로(현재 부재) → 손익 가시성 회복 (최우선)
2. **[즉시 진단]** fill-resolver 1회 실행 → 1주 실제 손익 확정(현재 장부 부정확)
3. [§8-16 연계] reconcile 학습 포함 + 실시간 청산 감지
4. [전략] micro_swing 변동성 장세 진입 억제(regime 연계)

> 마스터 질문 답: **주원인은 프로세스**(fill-resolver 미실행 → 실제 손익 은폐). 전략(SL 손실)·시장(약세)도 기여하나, "손실이 많아 보이는데 장부엔 작은" 괴리의 직접 원인은 프로세스. 정확한 손실 규모는 fill-resolver 실행 후 확정.


### 8-18. ★시스템 병목 정밀 분석 — 거래 생애주기 단계별 측정 (2026-06-20 메티)
> 마스터 지시: 시스템 병목 정밀 규명.
> **⚠️ 정정(§8-20·8-21)**: 본 섹션의 "환경변수 1개 미설정 → 기본 false" 프레이밍은 부정확. 실제는 fill-resolver가 05-28~06-10 정상 활성이었다가 **06-10 재배포로 FILL_RESOLVE 키 소실(회귀)**. "미설정"이 아니라 "설정이 재배포로 덮어써짐". 최종 결론은 §8-20·§8-21.

**거래 생애주기 단계별 병목 측정 (binance 30일)**:
| 병목 | 측정값 | 심각도 |
|---|---|---|
| 청산경로 | reconcile 87%(67) vs normal 13%(10) | 설계 의존 |
| reconcile 보유기간 | <1h~>3d 분산(TP/SL 도달 시점) | 정상 |
| fill-resolver 미처리 | unresolved 36건 avg 195h(8일) 미처리 | 🔴 최대 |

**★최대 병목 — fill-resolver 비활성화 (환경변수 미설정)**:
- `LUNA_RECONCILE_FILL_RESOLVE_ENABLED`가 ops-scheduler plist에 **부재**(70키 중 없음) → boolEnv 기본 false(reconcile-open-journals.ts:397·410)
- ops-scheduler가 **60초마다** reconcile-open-journals.ts 실행(line 803, `--write --confirm-live --market=crypto`)하나, fillResolveEnabled=false라 resolveFillForClosedJournal 호출 안 함(line 506 조건 미충족)
- → reconcile 거래 exit_match_source=null, exit_value=entry_value 복사, pnl 0 은폐
- resolved 31건(avg 15일 전) 존재 = 과거엔 활성, **최근 꺼짐**(plist 재배포 누락 또는 의도적 비활성 의심)

**구조 병목 — reconcile-open-journals open-only**:
- getOpenJournalEntries(line 451)로 OPEN journal만 처리 → closed unresolved 재시도 없음
- 플래그 켜도 과거 36건 자동 복구 안 됨 → 백필 필요

**설계 병목 — 87% reconcile 단일 의존**:
- 시스템 직접 매도 13%, TP/SL 거래소 자동 청산 87%
- fill-resolver가 87% 거래 손익의 단일 의존점 → 하나 꺼지면 대부분 은폐

**연계 병목 — exclude_from_learning 무조건(§8-16)**:
- reconcile = 무조건 exclude → fill-resolver 꺼져 pnl 0 + 학습 제외 = 이중 손실

**병목 진단 결론 (인과 체인)**:
표면("손실 많은데 안 보임") ← **fill-resolver 비활성(환경변수 1개)** ← open-only 구조(과거 미복구) ← 87% reconcile 의존(단일점) ← 무조건 exclude(학습 손실)

**보강 우선순위**:
1. **[즉시]** `LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true` plist 추가 + 재로드 → 앞으로 손익 가시성 회복(환경변수 1개). 단 fetchMyTrades API 호출 증가(rate-limit 고려).
2. **[백필]** 과거 unresolved 36건 fill-resolver 1회 백필(closed 재처리 스크립트)
3. **[정책]** exclude_from_learning 재검토(fill 매칭 청산 학습 포함, §8-16)
4. **[구조]** reconcile-open-journals closed unresolved 재시도 추가(재발 방지)

> 마스터 질문 답: 최대 병목은 **환경변수 1개(LUNA_RECONCILE_FILL_RESOLVE_ENABLED) 미설정**으로 fill-resolver 비활성. 60초 스케줄은 정상 작동하나 플래그가 꺼져 손익 미계산. 켜면 회복(앞으로), 과거 36건은 백필 필요. 근본은 87% reconcile 단일 의존.


### 8-19. ★플래그 이력 추적 — "꺼진 게 아니라 미완료된 Phase 2" (2026-06-20 메티)
> 마스터 지시: LUNA_RECONCILE_FILL_RESOLVE_ENABLED가 왜/언제 꺼졌나 git/plist 이력 추적.
> **⚠️ 전면 정정(§8-20)**: 본 섹션의 "잊혀진 Phase 2 / dry-run 의도 유지 / 승인 미완료" 결론은 **전부 틀림**(git plist에 키 없는 것만 보고 내린 단일소스 오판). 실제는 **05-28~06-10 정상 활성 → 06-10 재배포 회귀**(with_fill 시간 분포 교차검증으로 확정). 정확한 결론은 §8-20·§8-21.

**추적 결과 — 버그 아닌 설계된 단계적 롤아웃의 Phase 2 미완료**:
- **2026-05-28**: `docs/codex/archive/CODEX_LUNA_PNL_DATA_INTEGRITY_2026-05-28.md` 설계 — reconciliation close pnl=0 왜곡을 2단계로 수정 설계
  - 1단계(즉시): 기존 pnl=0 수정
  - 2단계(신중): reconciliation에 myTrades(fill-resolver) 통합
- **2026-05-29**: 커밋 `2f8f49e3c "add reconcile fill resolver dry-run"` — Phase 2를 dry-run으로 도입(reconcile-open-journals.ts +91, binance-fill-resolver.ts +175)
- **설계 의도(문서 line 221·290)**: `LUNA_RECONCILE_FILL_RESOLVE_ENABLED=false (기본, dry_run)` + "Phase 2: dry_run 1주 + 마스터 승인 필수"
- git plist(bots/investment/launchd/ai.luna.ops-scheduler.plist)에도 플래그 없음 = 처음부터 미설정(dry-run 의도 유지), **배포 누락 아님**

**결론**: 플래그는 버그로 꺼진 게 아니라 **PNL_DATA_INTEGRITY 설계의 의도적 안전장치**. Phase 2를 "dry_run 1주 → 마스터 승인 → 활성화"로 설계했고, 5/29 dry-run 도입 후 ~3주 경과했으나 **마스터 승인/활성화 단계가 미완료** → fill-resolver 계속 dry-run(비활성) → reconcile pnl=0 은폐 지속 = **"잊혀진 Phase 2"가 병목의 진짜 원인**.

**연관 플래그**:
- `LUNA_RECONCILE_FILL_RESOLVE_BACKFILL`(문서 line 223·244): 과거 백필용, 기본 false. 당시 이미 298건 pnl=0 왜곡 인지, 백필 별도 결정 대기.

**보강 방향 (설계대로 진행)**:
1. **[Phase 2 활성화]** dry_run 1주 검증 기간 충족(3주 경과) → dry-run 결과 검증 후 마스터 승인 → `LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true`(신규 reconcile부터 실제 pnl)
2. **[백필]** `LUNA_RECONCILE_FILL_RESOLVE_BACKFILL`로 과거 미처리(298+현재 36건) 백필
3. **[검증]** 활성화 전 dry-run 결과(myTrades 통합 정확성) 확인 + v_trades_real_usd 의존 7곳 영향 점검(문서 line 294)

> 마스터 질문 답: 플래그는 "꺼진" 게 아니라 PNL_DATA_INTEGRITY Phase 2의 안전한 dry-run 단계. "dry_run 1주 + 마스터 승인"이 설계였으나 승인/활성화가 미완료. 즉 의도적 안전장치가 활성화 대기 상태로 방치됨. 마스터 승인 시 설계대로 활성화 가능(단 dry-run 검증 + 의존 점검 선행). 이로써 §8-16~8-18 병목의 근본(왜 fill-resolver 비활성)이 "미완료 Phase 2"로 확정.


### 8-20. ★★fill-resolver 비활성화 근본원인 확정 — plist drift 재배포 회귀 (2026-06-20 메티 정밀검토)
> 마스터 지시: PNL_DATA_INTEGRITY 문서 + Phase 2 상태 정밀 검토.
> **§8-19 정정**: "잊혀진 Phase 2(dry_run에서 멈춤·승인 미완료)"는 **틀림**. 실제는 **활성화돼 정상 작동 중이었으나 06-10 재배포로 소실(회귀)**.

**결정적 증거 (시간 분포 교차검증)**:
| 증거 | 내용 |
|---|---|
| with_fill 31건 분포 | **05-28~06-10 연속 작동**(실제 pnl 기록), 06-10 14:56 마지막 |
| no_position zero 분포 | 06-11 전환 시작 → **06-19 25건 폭증**(="1주 손실 가시성 붕괴") |
| 실로드 plist | `~/Library/LaunchAgents/ai.luna.ops-scheduler.plist` **06-10 23:58 수정, FILL_RESOLVE 0개** |
| git plist | `bots/investment/launchd/...` FILL_RESOLVE **처음부터 없음**(git 이력 전수 확인) |
| a145ca869 (06-10 22:33) | plist에 V2/MAPEK/VALIDATION/PREDICTION env 추가(FILL_RESOLVE **무관**) → 재배포 트리거 |

**확정된 인과 메커니즘**:
```
[drift] Phase2 활성화가 git plist에 미반영 → 실로드 plist에만 수동 LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true
   ↓ (05-28~06-10 정상 작동, with_fill 31건)
06-10 22:33  a145ca869가 정당한 목적(V2 env)으로 git plist 수정
06-10 23:58  배포(launchd-service.ts) → git plist(FILL_RESOLVE 없음)가 실로드본 덮어씀
   ↓
FILL_RESOLVE_ENABLED 소실 → fill-resolver 비활성 → reconcile pnl=0 임의채움 회귀
06-19  zero 25건 폭증
```
= **collateral regression**: a145ca869 자체는 정당했으나, git plist가 SSOT가 아니어서(수동 drift) 의도치 않게 fill-resolver를 죽임.

**핵심 교훈 (마스터 비전 직결)**:
- **운영 설정은 git SSOT에 반영 필수** — 수동 drift는 다음 배포에서 반드시 소실
- 자율 진화 OS에서 **설정 drift = 치명적**: 학습 입력(pnl) 가시성을 조용히 붕괴시킴
- §8-19 "승인 미완료" 가설은 git plist에 키가 없는 것만 보고 내린 **단일소스 오판**(메티 13/14/15 잘못 재발 위험) → 시간 분포 교차검증으로 정정

**보강 방향 (재정의)**:
1. **[SSOT 복구]** git plist에 `LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true` 영구 추가(드리프트 종결) — 단 활성화 전 의존 7곳(line 294) 점검
2. **[백필]** 06-11~현재 미처리분(no_position zero 27건 + unresolved 36건) → `LUNA_RECONCILE_FILL_RESOLVE_BACKFILL`로 실제 pnl 복원
3. **[drift 방지]** 배포 시 실로드 plist vs git plist diff 검증(누락 env 경보) — launchd-service.ts에 가드
4. **[학습 재개]** with_fill은 v_trades_real_usd에 이미 포함(뷰 정밀화 완료) → pnl 복원 시 TP/SL 청산이 자동으로 학습에 반영


### 8-21. ★★★의존 7곳 점검 + 분석 정정 종합 + 확정 태스크 (2026-06-20 메티)
> 마스터 지시: 의존 7곳 영향 점검 + 잘못된 분석 정정 + 앞으로의 태스크 명확화.

#### A. v_trades_real_usd 의존 점검 (fill-resolver 활성화 영향)
- **뷰 성격**: **MATERIALIZED VIEW** (`REFRESH MATERIALIZED VIEW CONCURRENTLY`) — with_fill 반영하려면 refresh 필요. refresh 주체: runtime-guard-outcome-tracker.ts:61, luna-fx-refresh.ts:77
- **뷰 변경 이력**: `20260528000008_v_trades_real_usd_include_reconciled_with_fill.sql`로 **git 정식 반영**(뷰는 drift 아님 — 플래그만 drift였음)

| 의존 파일 | 용도 | 활성화 영향 |
|---|---|---|
| luna-daily-pnl-report (4) | pnl_usd 집계·승률·오늘손익 | 손익 수치 **정확↑** ✅개선 |
| runtime-guard-outcome-tracker (5) | guard outcome 판정(pnl>0 success) | 학습신호 정확↑, **no_trade→success/failure 일부 전환** ⚠️모니터 |
| luna-fx-refresh (3) | 뷰 refresh + FX 적용 | refresh만 ✅낮음 |
| runtime-kis-overseas-funnel-trace (2) | 뷰 존재 체크(to_regclass) | crypto 무관 ✅없음 |
| kis-overseas-funnel-trace-smoke (1) | 테스트 | 기대값 재검증 ⚠️ |
| luna-trades-usd-normalization-smoke (5) | 테스트 | 기대값 재검증 ⚠️ |

- **결론**: 활성화 영향은 **대부분 "개선"**(손익·학습 정확도↑), 위험 낮음. 유일한 주의점: ① guard-outcome 학습신호 변화 모니터 ② smoke 2곳 기대값 재검증. **차단 요소 없음 → 활성화 가능**.

#### B. 분석 정정 종합 (§8-13~8-20 중 틀린 부분 한눈에)
| 섹션 | 틀린 결론 | 정정된 사실 |
|---|---|---|
| §8-13/8-15 | 매수 체결검증 부재가 67건 원인 | 매수 정상 체결. TP/SL 청산이 reconcile 경로(§8-16) |
| §8-16 | pending-reconcile:40 무조건 exclude가 **"근본원인"** | exclude는 **보조 이슈**. 1차 원인은 fill-resolver 비활성(pnl=0). 활성 시 with_fill이 뷰·학습 포함되며 상당 부분 자동 완화 |
| §8-18 | 환경변수 1개 **"미설정"**=기본 false | 05-28~06-10 활성→06-10 재배포 **소실(회귀)**(§8-20) |
| §8-19 | "잊혀진 Phase 2/승인 미완료" | **전면 오판**. 재배포 drift 회귀(§8-20) |
| §8-20 | (정확) drift 회귀 | **유지**. 단 "수동 plist 편집 vs launchctl setenv" 경로는 미확정(결론과 무관) |

> 핵심: 이번 세션은 메티가 **단일소스 판단으로 3회 오판**(§8-13→8-16, §8-18→8-20, §8-19→8-20)했고 매번 live DB 교차검증으로 자기수정. 최종 확정 사실 = **fill-resolver는 정상 작동하던 기능, 06-10 재배포가 git 미반영 설정을 덮어써 죽임**.

#### C. ★확정 태스크 (우선순위·역할·선행조건)
**T1 [최우선·SSOT복구] fill-resolver 재활성화**
- git plist(`bots/investment/launchd/ai.luna.ops-scheduler.plist`)에 `LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true` **영구 추가**(drift 종결)
- 선행: 활성화 전 dry-run 1회로 myTrades VWAP 매칭 정확성 재확인 / 의존 점검은 A로 완료
- 역할: 코덱스(plist 수정) → 마스터(배포·launchctl reload)

**T2 [백필] 과거 미처리 pnl 복원**
- `LUNA_RECONCILE_FILL_RESOLVE_BACKFILL=true` 1회로 06-11~현재 미처리(no_position zero 27 + unresolved 36) 복원 → materialized view refresh
- 선행: T4(closed 재처리)와 연계 — 현재 reconcile-open-journals는 open-only라 closed 백필 경로 필요
- 역할: 코덱스(백필 스크립트/경로) → 마스터(1회 실행 승인)

**T3 [drift방지] 배포 가드**
- launchd-service.ts에 배포 시 실로드 vs git plist env diff 검증(누락 키 경보) → 06-10 회귀 재발 차단
- 역할: 코덱스 → 마스터

**T4 [구조] reconcile-open-journals closed 재시도**
- getOpenJournalEntries(open-only, line 451) → closed unresolved도 주기 재처리(재발 시 자동 복구)
- 역할: 코덱스 → 마스터

**T5 [정책·후속] exclude_from_learning 정렬**
- pending-reconcile-ledger:40 무조건 exclude → fill 매칭 청산(with_fill)은 trusted 학습 포함, fill 미매칭만 exclude
- T1 활성화로 with_fill이 뷰 포함되므로 학습 경로도 정렬(자가진화 청산 피드백 복원)
- 역할: 코덱스 → 마스터

**T6 [후속·모니터] 활성화 후 검증**
- guard-outcome 학습신호 변화(no_trade→success/failure) 모니터 / smoke 2곳 기대값 재검증 / daily-pnl-report로 1주 실제 손실 규모 확정(현재 장부 은폐분)

**의존 순서**: T1 → T2(백필, T4 선행) → T6(모니터). T3·T5는 T1과 병행 가능.
**역할 불변**: 메티=설계·검증만 / 코덱스=구현 / 마스터=plist 배포·launchctl·DDL·실행 승인.


### 8-22. ★T1 선행 검증 — fill-resolver 정확성 100% 입증 (2026-06-20 메티)
> T1(재활성화) 전 dry-run 검증: fill-resolver가 정확한가. 메티 권한 내(코드 정적 + DB 출력 분석) 수행.

**A. 코드 정적 검증 (binance-fill-resolver.ts, 217줄)**:
- 1차 **order_id 매칭**(최정확): TP/SL 청산 fill의 order 필드를 sl/tp_order_id와 직접 매칭 → DCA 오귀속 원천 차단
- 2차 **단일 fill fallback**(보수적): 수량 정확 일치하는 단일 fill만, 누적 매칭 안 함
- 3차 **unresolved**(fail-safe): "부정확한 추정보다 미해결이 안전" — 모호하면 포기
- **읽기 전용**(fetchMyTrades만, DB 미수정) + USDT 페어 제한 + VWAP(value/qty) 정확

**B. 출력 실증 (with_fill 31건 = 05-28~06-10 실제 작동분)**:
| 지표 | 결과 |
|---|---|
| order_id 매칭 | **31/31 (100%)** — 전부 최정확 방식 |
| exit_fill_ids 존재 | 31/31 (실제 거래소 fill 추적) |
| pnl 계산 정합(exit−entry=pnl) | **31/31** (오차<0.01) |
| near_zero(가짜 pnl=0) | **0건** |
| 손익 범위 | -5.0%~+9.4% (TP/SL 부합), 전체 평균 -0.5% |
| incident_link | `fetchMyTrades_orderid:match=order_id:fills=1~7` |

**검증 결론**: fill-resolver는 **이미 실전 검증된 정확한 기능**. 31건 전부 최정확 order_id 매칭으로 실제 거래소 체결 VWAP을 정확 반영했고 pnl 계산도 완벽, 가짜 pnl=0 없음. 단지 06-10 재배포로 꺼진 것뿐. → **재활성화 안전, T1 진행 승인 가능**.


### 8-23. ★코덱스 구현 독립 검증 완료 (2026-06-20 메티)
> CODEX_LUNA_FILL_RESOLVE_REACTIVATE_2026-06-20 구현(코덱스) 독립 검증. 정적 분석 + 하드 테스트(smoke 재실행).

**구현 파일 (코덱스)**:
- `ai.luna.ops-scheduler.plist`: `LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true`(line 51-52), DRY_RUN 미설정
- `luna-fill-resolve-backfill.ts`(352줄, 신규) + `luna-fill-resolve-backfill-smoke.ts`(신규)
- `launchd-service.ts`: `buildLaunchdEnvDriftPlan` 등 drift 감지 순수 helper
- `runtime-luna-launchd-migrate.ts`: FILL_RESOLVE를 `CRITICAL_ENV_KEYS_BY_LABEL` 등록(line 50) + drift plan 연결

**정적 검증 (3 Phase 통과)**:
| Phase | 검증 항목 | 결과 |
|---|---|---|
| A | plist ENABLED=true + DRY_RUN 미설정(게이트 line506 충족) | ✅ |
| B | 대상조회(no_position+match_source NULL+order_id+is_paper=false)·with_fill 전환·조건부UPDATE(동시성)·4중게이트·완전체결만·중복방지·에러격리·view refresh | ✅ |
| C | drift helper(git vs 실로드 env diff + _ENABLED 강조)+FILL_RESOLVE critical key | ✅ |

**하드 테스트 (smoke 재실행)**: `ok:true, dryRunMatched:1, applyUpdated:1, unresolved:1, driftDetected:1` + plist `plutil -lint` OK → 핵심 로직(dry-run매칭/실제업데이트/미매칭fail-safe/drift감지) 전부 동작

**설계 대비 강화점 (코덱스 추가)**: confirm 토큰(실수 실행 차단) + partial_skipped(부분체결 미업데이트) + excludedFillIds(중복 fill 귀속 방지)

**검증 통과**: check:luna-fill-resolve-reactivate(메티 재실행) + tsc --noEmit + git diff --check
**결론**: 구현 정확·안전. Phase A 배포 + Phase B 백필 가능. **미적용분(마스터 대기)**: 운영 DB 백필·launchctl reload·git tag.


### 8-24. ★Phase B 백필 dry-run 버그 발견 + Phase A 진행 결정 (2026-06-20 메티)
> 매칭률 확인(dry-run) 중 backfill.ts 버그 발견. Phase A(재활성화)는 별개라 선행.

**dry-run 버그 (CODEX_LUNA_FILL_RESOLVE_REACTIVATE §8 상세)**:
- 증상: recent 후보 전부 `invalid_symbol_or_qty`+`orderIds:[]` → 매칭 0%(가짜)
- 원인: **normalizeCandidate 이중 적용**(loadBackfillCandidates line108 `.map` + 루프 line237 재적용) → camelCase 재변환 → `row.entry_size`=undefined→0
- DB·db.query 정상 직접 확인(entry_size=2.442, snake_case 반환)
- smoke 미검출: mock injection이 매핑 1회만 거침 → 통과
- 수정(코덱스): loadBackfillCandidates `.map(normalizeCandidate)` 제거 → raw 반환

**Phase A 진행 (backfill 버그와 독립)**:
- reconcile-open-journals 재활성화 경로는 **이미 검증됨**(with_fill 31건 order_id 100%) → backfill.ts 버그와 무관
- 마스터: git plist 배포(drift 가드 적용) + launchctl reload → **"앞으로"의 손익 가시성 회복**
- reload 후 메티가 with_fill 재등장 + exit_match_source='order_id' 검증

**교훈**: **mock injection smoke < 실데이터 dry-run**. mock은 쿼리→매핑 실경로를 우회하므로, 신규 스크립트는 실데이터 dry-run 1회를 필수 검증으로. (§8-23에서 smoke 통과를 근거로 "정확"이라 한 것을 dry-run이 보강 — 또 한 번의 다중소스 검증 원칙)


---

## §8-25. fill-resolver 완전 복구 종결 (2026-06-20)

### 2번째 누락 env 발견 (Phase A 보강)
Phase A reload(LUNA_RECONCILE_FILL_RESOLVE_ENABLED=true) 후 검증 중 fill-resolver 미작동 발견 — ops-scheduler 로그에 `reconcile_open_journals` 실행 이력 없음.
- 원인: **fill-resolver 작동에 env 2개 필요**:
  1. `LUNA_RECONCILE_FILL_RESOLVE_ENABLED` — fill-resolver 호출 게이트 (§8-20에서 복구)
  2. **`RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED`** — reconcile_open_journals 작업 활성화 게이트 (06-03 커밋 48e707bcd 도입)
- `runtime-luna-ops-scheduler.ts:797` = `...(boolEnv('RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED', false) ? [{name:'reconcile_open_journals', cadence:300s, ...nodeScript('reconcile-open-journals.ts',['--write','--confirm-live','--market=crypto','--json'])}] : [])` → false면 작업 자체 미등록 → fill-resolver 호출 경로 부재
- **06-10 재배포가 두 env 동시 소실** (둘 다 실로드 drift, git plist엔 부재)
- reconcile-open-journals 실행 경로는 ops-scheduler reconcile_open_journals(line798)가 유일 (process-integrity-loop line787-788은 evidence 명령 제시만, 실행 아님)

### 보강 (코덱스 + 마스터)
- git plist에 `RECONCILE_OPEN_JOURNALS_PERIODIC_ENABLED=true` 추가
- 두 env 모두 drift critical key 등록 (launchd-service.ts `criticalEnabledKey` + migrate.ts `CRITICAL_ENV_KEYS_BY_LABEL`) → 다음 재배포 시 자동 보호
- smoke가 두 env key 모두 확인하도록 보강
- 배포 + reload → reconcile_open_journals 정상 실행 확인: `{ok:true, status:0, outcome:"ok", dryRun:false, error:null}`

### 백필 버그 수정 (double normalizeCandidate)
- loadBackfillCandidates의 `.map(normalizeCandidate)` 제거 (camelCase 재변환 → snake_case 읽어 0 만드는 버그)
- 회귀 테스트 추가: 실 query 경로가 raw snake_case row 반환해도 루프에서 1회만 normalize

### 백필 apply 결과 (recent 25건)
- matched 25 / updated 25 / unresolved 0 / partial 0 / **order_id 100%**
- near-zero 잔존 **0** (은폐 완전 해소)
- v_trades_real_usd refresh true / errors [] / liveMutation false

### Phase A 작동 직접 증거
- reload(17:54) 직후 오늘 with_fill **0** → 백필+사이클 후 **06-20 자동 with_fill 1건(pnl=-3.36)**
- reconcile_open_journals가 06-20 청산분을 fill-resolver로 자동 기록 = "앞으로의 출혈" 가시화 확인

### 1주 진짜 손익 노출 (06-13~06-20)
- 총 25건 순손익 **-$51.22**
  - with_fill 22건 **-$33.55** (은폐분, 백필로 노출)
  - normal_exit 2건 -$17.67
  - duplicate_open 1건 0
- 백필 전 체감(normal -$17.67) 대비 **-$33.55 추가 손실이 은폐**돼 있었음
- **06-19 -$28.07 집중** → 별도 원인 분석 대상 (자가진화 학습 후보)

### 미해결/후속
- **커밋 상태**: 구현 파일 커밋 완료(`a48551e8d` complete fill resolve phase a, `a1d87d437` reactivate fill resolver backfill); 설계/추적 docs + CODEX archive 이동만 커밋 대기. CODEX_LUNA_FILL_RESOLVE_REACTIVATE_2026-06-20.md → docs/codex/archive/ 이동 완료.
- Phase B 2차: past(~06-10) 245 order_id 백필 (선택, `--since` 범위 지정)
- 06-19 손실 집중 원인 분석

### 핵심 교훈
- **다단계 게이트 함정**: 한 기능에 게이트가 2개(호출 게이트 + 작업 활성화 게이트)일 때, 1개만 복구하면 무력. 단일 env 검증의 위험성 — 호출 경로 끝까지 추적해야.
- **collateral drift는 묶어서**: 06-10처럼 동일 시점 소실된 env는 개별 추적 시 누락. 같은 재배포로 사라진 env 집합을 함께 찾아야 (FILL_RESOLVE만 보고 PERIODIC 놓칠 뻔).


---

## §8-26. 06-19 손실 분석 — 레짐-전략 미스매치 + 개선안 (2026-06-20)

### 분석 경위
세션 시작 점검에서 06-19 with_fill 카운트 불일치 발견 → 타임존 정리 → 06-19 손실 정밀 분석.
- **메티 자기수정**: `trade_journal.pnl_amount`는 KRW/USD 혼합 raw → 손익 집계는 반드시 `v_trades_real_usd.pnl_usd` 사용. `ranging×promotion_ready_shadow "-14,351"`은 KRW raw 오인(229000=KIS domestic), 실제 **-$11.97**(pnl_usd 정상 정규화).
- **타임존**: DB=Asia/Seoul. `extract(epoch from date)`는 UTC 자정 기준 → 9시간 누락 버그. 일별 집계는 `(to_timestamp(...) AT TIME ZONE 'Asia/Seoul')` 사용.

### 근본 원인 (확정)
1. **BASE_SIGNAL_WEIGHTS TRENDING_BEAR** (regime-weight-learner.ts:42): `momentum 0.15, breakout 0.15, mean_reversion 0.30, defensive 0.40` → **defensive(0.40) > mean_reversion(0.30)**, 메모리 원칙(bear→mean_reversion)과 정반대.
2. **LUNA_LEARNED_BIAS_MODE=off** (plist 미설정, 기본 off) → 자가진화 학습 미적용.
3. **learnedBias 메커니즘** (strategy-router.ts buildLearnedRegimeBias): `applied = clamp((학습familyBias − BASEfamilyBias) × alpha(0.2), −0.1, 0.1)` — BASE 대비 delta 보정. 학습 snapshot(TRENDING_BEAR defensive 0.4/mr 0.3, trades=5)이 BASE와 동일 → **delta=0, 보정 효과 없음**.
4. → defensive 항상 선택(weight 최고) → mean_reversion 0건 → **exploration 막힘**(데이터 미축적 → 학습 불가).

### 데이터 근거 (pnl_usd 기준)
- 06-19(KST): 8건 **-$36.15**, 전부 trending_bear × defensive_rotation.
- bear×defensive (30일): 38건 -21.23 **승률 26%** (구조적 손실, 06-19만 아님).
- bear×mean_reversion: **0건** (대안 미검증).
- defensive_rotation 레짐별: volatile +5.06(50%) vs bear -21.23(26%) → defensive는 volatile용 확인.
- crypto 전략 분포(30일): defensive 43건(과다) / momentum 12 / trend_following 8 / micro_swing 6 / breakout 2 / **mean_reversion 0**.

### 핵심 문제 — exploration vs exploitation
현 시스템은 exploitation(defensive 반복)만, exploration(mean_reversion 시험) 없음. defensive weight가 높아 항상 선택 → mean_reversion 0건 → 학습 데이터 없음 → 자가진화가 대안 발견 불가. **learnedBias(BASE 대비 보정)만으론 이 고리를 못 깸 — BASE 자체 조정 필요.**

### 개선안 (3단계)
1. **BASE_SIGNAL_WEIGHTS TRENDING_BEAR 재조정** (exploration 시작):
   - `mean_reversion 0.30→0.40, defensive 0.40→0.30` (momentum/breakout 0.15 유지)
   - 근거: 메모리 원칙 + bear×defensive 손실(승률 26%) + mean_reversion exploration 필요.
2. **LUNA_LEARNED_BIAS_MODE shadow 전환**: plist 추가 + drift critical key 등록. 학습 bias 관찰/로깅(active 전 안전 검증).
3. **관찰/검증** (1-2주): bear×mean_reversion 성과 추적 → defensive 대비 우위 확인 → active 전환 또는 추가 조정.

### 리스크/안전
- BASE weight 변경은 LIVE crypto 직접 영향 → 역전이되 급격하지 않게(0.40↔0.30), 3역할 절차.
- shadow 먼저(관찰), active는 데이터 검증 후.
- mean_reversion이 bear에서 0건 검증이므로 손실 시 자가진화/수동 재조정 대비.

### CODEX 지시
→ CODEX_LUNA_REGIME_BEAR_STRATEGY_FIX_2026-06-20.md (BASE weight 재조정 + LEARNED_BIAS shadow + 검증)


### 배포·검증 결과 (2026-06-20 추가)
- **코덱스 구현**: BASE TRENDING_BEAR `mean_reversion 0.40 > defensive 0.30`, plist `LEARNED_BIAS_MODE=shadow`, migrate critical key, smoke/check 보강
- **메티 독립 검증 통과**:
  - 정적 4: BASE weight / plist shadow / migrate critical key(line 52) / 신규 luna-regime-bear-fix-smoke
  - 회귀 4 시나리오 전부 true: `bearMeanReversionBasePreferred`, `otherRegimeWeightsUnchanged`, `learnedBiasOffNoProvider`, `learnedBiasShadowNoRouteMutation`
  - shadow 분기(strategy-router.ts:413): shadow는 reasonLine 로깅만(scores 무변경), active(417)만 적용 — 안전 확인
- **마스터 배포+reload 완료**: 3 env 로드(FILL_RESOLVE + PERIODIC + LEARNED_BIAS shadow), ops-scheduler 정상(err 0)
- **배포 시점 레짐**: trending_bull(conf 0.69, momentum 정상), 최근 24h bull 33/bear 11/ranging 7 → **bear 22% 비중**(관찰 기회 충분)
- CODEX_LUNA_REGIME_BEAR_STRATEGY_FIX → docs/codex/archive/ 이동 완료

### 관찰 항목 (다음 세션/1-2주)
- bear 레짐 도래 시 **mean_reversion 선택 시작** 확인(defensive 대신)
- LEARNED_BIAS shadow 로깅(reasonLine diff) 발생 확인
- bear×mean_reversion 성과 vs defensive 비교 → active 전환 또는 추가 조정 판단


---

## §8-27 fill-resolver 근본 결함 발견 + Phase B 2차 백필 보류 (2026-06-20 저녁)

### Phase B 2차 백필 dry-run (past ~06-10, --since 2026-04-01 --limit 300)
- 245 후보 → **187 매칭(76%)** / unresolved 58(24%)
- 매칭 출처: fetchMyTrades_orderid 167 + fetchMyTrades(단일) 20
- unresolved 58 = 전부 `ambiguous_no_orderid` (04-26~05-10, ORCA/MEGA 등) → 미변경(안전, pnl=0 유지)
- 기간 2026-03-26~06-10, 표면상 순손익 +1094.2 USD (승 60 +1495 / 패 127 -401, 승률 32%)

### ★ 근본 결함 발견 (2레이어) — apply 보류 결정적 사유
**레이어 1: entry 기록 결함 (entry_size 미세 거래 3건)**
- TRD-20260429-019 BROCCOLI714: entry_size 0.392 → entry_value **$0.0074**
- TRD-20260426-037 ZBT: entry_size 0.0784 → entry_value **$0.0138**
- TRD-20260429-013 BROCCOLI714: entry_size 0.795 → entry_value **$0.0151**
- 바이낸스 최소주문 $5 미만 → 실제 주문일 수 없음, entry 기록 자체 손상 (원인 별도 조사 필요)

**레이어 2: backfill 1차 order_id 매칭 가드 부재** (binance-fill-resolver.ts 라인 132~152)
- `value = matched.reduce(cost 합)`; `pnlAmount = value - expectedEntryValue`
- `partial: qty + tolerance(expectedQty) < expectedQty` → **'부족'만 체크, '초과'·'미세 entry' 미검증**
- 깨진 entry($0.0137)에 실제 exit 체결 cost($136) 차감 → pnl 폭발 (+135.97, pnlPercent 988,662%)
- pnlPercent 공식 확인: pnlAmount/expectedEntryValue×100 (BROCCOLI-019 121.23/0.0074≈163만% ✓)
- 참고: 2차 fallback(라인 163)은 `|amount-expectedQty|<=tolerance` 단일 체결만 → 안전(결함 없음)

### 격리 결과 (pnlPercent로 entry_value 역산: ev=pnl/pct×100)
- 명백 오류 3건 **+379.92** (전체 +1094의 35%) → apply 제외 필수
- 정상(ev≥$5) 184건 **+714.28** (승 57 +1115 / 패 127 -401)
- 단 TRD-20260426-003 ZBT (entry $11.9 → +137, **1154%=12배**) 추가 검증 여지 (exit 수량 미확인)

### 기존 with_fill 무오염 확인 ✅
- 1차 백필(recent 25, 06-11~06-19) + 자동 reconcile: pnl% 최대 **20%**(HOME), entry_value<$5 = **0건**
- 결함은 과거(03~05월) 후보에만 존재 → 1차 백필 정정 불필요

### 메티 권고 (다음 세션 작업)
1. **backfill 1차 order_id 매칭에 가드 추가 (CODEX 프롬프트 → 코덱스)**:
   - ① `expectedEntryValue < MIN_NOTIONAL($5)` → unresolved `micro_entry_invalid`
   - ② `matchedQty`가 `expectedQty` 크게 초과(비율 임계, 예: >1.5×) → partial/unresolved `qty_overflow`
   - ③ (선택) `|pnlPercent| > 임계`(예 1000%) → 의심 플래그
   - 회귀 테스트: 미세 entry → unresolved, 수량 초과 → 차단, 정상 → 통과
2. 가드 추가 후 **재dry-run** → 깨끗한 후보만 apply (마스터, DB write)
3. TRD-20260426-003 ZBT exit 수량 직접 확인(fetchMyTrades) — 12배 실제 익절 여부
4. entry_size 깨진 거래 원인 별도 조사 (entry 기록 로직)

### dry-run 결과 파일
- /tmp/phaseb.json (90KB, 245 후보 전체) — 다음 세션 재사용 가능(단 /tmp는 휘발 가능, 필요시 재실행)


---

## §8-28 fill-resolver 가드 구현 + Phase B 백필 apply 완료 (2026-06-21)

### 가드 구현 (코덱스, 커밋 64b8a4f8e + 22786ac4a)
binance-fill-resolver.ts에 3개 방어:
1. **micro_entry_invalid** (입력검증부, non_usdt 다음): expectedEntryValue < MIN_NOTIONAL_USDT($5) → unresolved. **fetchMyTrades 호출 전 차단**(API 절약). 1차/2차 공통 보호.
2. **qty_overflow** (1차 order_id 매칭, qty 계산 직후): matchedQty > expectedQty × (1+QTY_OVERFLOW_RATIO=0.5) → unresolved. order_id 오귀속/entry 손상 차단.
3. **fallback fix** (expectedEntryValue 계산): num(entryValue,0)이 Number(null)=0으로 fallback 무시하는 버그 → `rawEntryValue = num(entryValue,0); expectedEntryValue = rawEntryValue>0 ? rawEntryValue : expectedQty×num(entryPrice,0)`. entry_value null/0이어도 entrySize×entryPrice fallback.

상수: MIN_NOTIONAL_USDT=5, QTY_OVERFLOW_RATIO=0.5 (env override, plist 불필요).
신규: luna-fill-resolve-guard-smoke.ts (5 시나리오) + check:luna-fill-resolve-guard + check:luna-fill-resolve-reactivate 통합.

### 메티 독립 검증
- **정적**: 코드 diff(상수·가드①②·fallback fix 정확), smoke 5 시나리오, package.json scripts
- **동적**: check:luna-fill-resolve-guard 5 시나리오 PASS(microEntryBlock/qtyOverflowBlock/normalPass/boundaryPass/nullEntryValueFallback) + reactivate 회귀 PASS (메티 직접 재실행)
- **재dry-run(가드 적용)**: 245후보 → matched 173, unresolved 72(micro_entry 34 + qty_overflow 11 + ambiguous 27), **pnlPercent>1000% 0건**(988,662% 완전 제거), 최고 pnl% 12.2%
- **코덱스 지적 검증**: num/safeNumber가 null→0으로 fallback 무시(정확). 단 binance 628건 중 entry_value=null **0건** → 실제 영향 0. fallback fix는 robustness 보강.
- ★ ZBT-003(메티가 의심한 "12배 익절")은 실제가 아니라 qty_overflow(오귀속)로 판명, 가드②가 정확히 격리.


### Phase B apply 결과 (마스터)
- 1차 apply: 171건 정정 (no_position → with_fill)
- 2차 apply(fallback fix 후): scanned 74, matched 0, unresolved 74 (이미 처리된 171 제외, 남은 74 격리 유지), refreshed=false(업데이트 0이라 view refresh 불필요)
- ops-scheduler 재시작 → LIVE reconcile 가드 반영 (3 env active: FILL_RESOLVE + LEARNED_BIAS shadow + PERIODIC)

### apply 후 검증 (메티)
- with_fill 232건, **micro_in_withfill 0**(미세 entry 격리 성공), **max pnl% 19.8%**(비정상 완전 제거)
- 과거(06-11 이전) with_fill 202건 **순 -170.03 USD**(승 55 / 패 147, 승률 27%) — 과거 거래 실제 손실 정확 반영
- no_position 잔존 128건(micro 34 영구 격리 + 기타 94, pnl=0 유지 안전)

### 핵심 발견
- 가드 전 표면 +1094 USD는 미세 entry(34건)·qty_overflow(11건) 오류로 부풀려진 **허구**
- 실제 과거(03~06-10) 거래는 **순손실 -170 USD**였음 → 누적 손익에 정확히 반영
- 가드가 데이터 무결성 보호: 비정상 pnl 0건, 미세 entry with_fill 유입 0건

### 잔여/후속
- micro_entry 34 + qty_overflow 11 = 45건은 entry 기록 손상/오귀속 → 영구 unresolved (entry 기록 로직 원인 조사 가능, 우선순위 낮음)
- order_id 없는 no_position ~54건은 backfill 대상 외 (order_id 부재로 매칭 불가)
- (병행 대기) bear×mean_reversion 관찰 — trending_bear 도래 시 (§8-26 관찰 항목)

### 교훈
- **메티 역산 분석의 한계**: pnlPercent>500% 역산은 3건만 식별했으나, 가드의 entry_value 직접 체크는 34건 전부 포착 (pnl 작은 미세 entry는 역산에 안 걸림). 직접 기준값 검증 > 간접 추정.
- **유틸 함수 null 처리**: num/safeNumber가 Number(null)=0을 유효값으로 처리 → fallback 무시. 방어적 fallback은 `raw>0 ? raw : fallback` 패턴 필요.


---

## §8-29 micro entry(dust) 원인 규명 + 학습 정정 + order_id 없는 no_position 처리 (2026-06-21)

### 배경
§8-28에서 backfill 가드가 micro_entry 34건을 격리. 그 entry_size 손상 원인을 조사.

### micro entry의 정체 = dust position ★
- **정체**: dust position(먼지 잔여, entry_value ~$0.1)
- **원인**: 2026-04-23 dust 처리 로직 대거 변경 (커밋 6개):
  - 6b01e4911 isolate dust from position watch
  - **736616800 fold symbol dust into managed buys** ← 핵심: dust를 managed position에 병합
  - 8279b6c82 trim dust load and flex max positions
  - 4ce25753d separate dust from strategy coverage
  - 648a3b072 separate dust exit signal noise
  - 2d57dc6d7 keep crypto dust out of synced positions
- dust가 managed/strategy position으로 다뤄지며 trade_journal에 entry_size 미세($0.1)로 기록
- **시기**: 04-26~05-10 집중 (04-23 변경 후 ~ 05-10경 수정), 현재 0건 ✅

### 검증 데이터
- 기간별 micro 비율: 04-26 이전 1.3%(3/231) / **04-26~05-10 21.5%(64/298)** / 05-10 이후 0%(0/98)
- execution_origin: cleanup 51 + strategy 16 (dust가 양쪽에 fold됨)
- entry_value ~$0.05~0.16 (정상 $70의 약 1/700), 전부 long
- sweeper(applyManualDustJournalSync)가 dust 청산 시 exclude_from_learning=true 마킹 → 49건 정상 제외
- ★ 단 **18건은 trusted(학습 포함)** — dust인데 strategy origin(16)으로 fold되어 정상 거래로 기록 (normal_exit/signal_reverse 청산)

### 학습 정정 (18건)
- 18건 trusted dust(entry_value<$5, strategy/cleanup origin)를 exclude_from_learning=true로 정정
- 정정 SQL: `UPDATE ... SET exclude_from_learning=true, quality_flag='exclude_from_learning' WHERE binance AND entry_value<5 AND exclude_from_learning=false` (마스터 실행)
- 근거: entry_value<$5는 바이낸스 최소주문 미만 → 실제 진입 불가, dust 확실

### order_id 없는 no_position 54건 처리
- **정체**: TP/SL 미설정(tp_sl_set=false) 초기 거래, exit_order_ids/fill_ids도 null
- cleanup 52 + strategy 2, **정상 크기(avg $16.82, micro 0)**, 03-26~05-02
- order_id 없어 backfill 정밀 매칭 불가, symbol+exit_time 근사 매칭은 모호성(ambiguous)으로 권장 안 함
- **처리 방안**: pnl 미상이므로 exclude_from_learning 마킹 권고 (entry/regime는 유효하나 pnl 학습 노이즈 방지). 정밀 매칭은 보류

### 결론
- micro entry = dust(04-23 fold 로직), 현재 해결됨(05-10 이후 0건)
- backfill 가드가 micro 격리 + 학습 정정으로 18건 dust 제외 → 학습 품질 보강
- order_id 없는 54건은 TP/SL 미설정 초기 거래로 정밀 매칭 불가 → 학습 제외 권고
- 가드는 LIVE에도 적용되어 향후 dust→position 자동 차단(이중 안전)


---

## §8-30. bear 자동 관찰 시스템 + sweeper dust 점검 (2026-06-21)

### 8-30-1. 배경
§8-26 bear 전략 fix 배포(BASE weight: TRENDING_BEAR mean_reversion 0.40 > defensive 0.30) 후 bear×mean_reversion 선택 검증 필요. 그러나 배포 후 계속 trending_bull(24h 49/50)이라 bear 미도래 → 검증 불가. 마스터가 수동으로 계속 확인할 수 없으므로 **자동 관찰 + 알림 시스템** 구축.

### 8-30-2. bear 관찰 현황 (06-21 기준)
- 배포 후(06-20 20:30~) bear 거래 **0건** (계속 bull)
- 최근 7일 bear 거래 18건 전부 배포 **전**(06-14~06-19), 전부 defensive_rotation → 구 weight 하에선 정상
- LEARNED_BIAS shadow 로깅 없음 (bull 국면이라 미발생)
- → bear 도래 시 자동 체크 + 알림이 필요 (대기 상태)

### 8-30-3. bear observer 설계 (자동 관찰)
- 신규 스크립트 `luna-bear-strategy-observer.ts` — guard-effectiveness-report.ts 패턴 복제
- 로직: 배포 후 bear 레짐 거래(exclude_from_learning=false) strategy_family 분포 → 상태 판정
  - waiting(bear 0건) / observing(표본<3) / converted(mean_reversion 우세 ✅) / not_converted(defensive 우세 ⚠️)
- **상태 변화 시에만 Telegram 알림** (평소 조용, 스팸 방지) — 마스터 수동 확인 불필요
- ops-scheduler 6시간 interval task (bear_strategy_observer)
- 출력: /tmp/luna-bear-observer-*.json+md + history.jsonl + 상태파일
- CODEX 프롬프트: docs/codex/CODEX_LUNA_BEAR_STRATEGY_OBSERVER_2026-06-21.md (코덱스 구현 완료 → 메티 독립 검증/운영 배포 대기)

### 8-30-4. sweeper dust 점검 결과 — 모두 정상
- **sweeper dust 로직** (team/sweeper.ts): DUST_USDT=3 임계, dust journal을 walletGone 시 종료하며 `exclude_from_learning=true` + quality_flag 설정 (학습 오염 방지) → 정상
- **consistency guardrail** (sweeper-consistency-check.ts runSweeperConsistencyCheck): binance 포지션 중 notional<$10 → `dust_positions_present` warning 감지
- **현재 open dust = 0건** (binance 미청산 2건 모두 정상 크기)
- **dust→position fold 재발 없음**: 월별 micro(entry_value<$5) 비율 — 3월 0% / 4월 8.8% / 5월 20.5% / **6월 0.0%**. 즉 04-23 fold 도입 → ~05-10 수정 → 6월 완전 청결
- (참고) 임계 이원화: sweep 정리 $3 vs consistency 경고 $10 → 보수적 설계로 판단

### 8-30-5. 인수인계 — 마스터 자동 확인 방법
- **bear 관찰은 observer 구현 후 자동화**: 수동 확인 불필요. bear 도래 + mean_reversion 전환/실패 시 Telegram 자동 알림
- 다음 bear 국면에서 mean_reversion 선택이 자동 검증됨
- 수동 확인이 필요하면: `node bots/investment/scripts/luna-bear-strategy-observer.ts --json` 또는 `/tmp/luna-bear-observer-YYYYMMDD.md` 확인
- sweeper dust: 현재 청결, 재발 없음. consistency guardrail이 dust 포지션 상시 감지


---

## §8-31. 루나 프로세스 구간별 병목 진단 + 즉시/승격 타스크 (2026-06-21 세션2)

### 8-31-1. 배경
세션 작업 3가지: (1) 즉시 구현 가능 타스크(데이터 누적 불필요), (2) 루나 전체 프로세스 구간별 병목 체크(전략/매도/매수 병목 분석의 전체 확장), (3) 데이터 누적 시 승격 대기 타스크.

### 8-31-2. 파이프라인 구간 맵 (ops-scheduler 59 task)
- Active 흐름: market_state -> discovery -> candidate_selection -> analysis_refresh -> market_cycle -> decision_probe(active) -> execution(active) -> position_monitor -> reconcile -> learning (+ guardrail/watchlist/policy/report)
- Shadow 흐름: promotion_shadow(7) + decision/evidence/paper/risk/feedback/strategy/neural shadow + observability(bear observer)
- 핵심: active 거래는 decision_probe/execution뿐, 각 단계 개선판이 _shadow로 병렬 운영(승격 대기)

### 8-31-3. (2) 병목 3계층 [핵심 발견]
거래 결과(7일 crypto): 24건(open2/closed22), 실현 -45.78 USD, 3승17패(승률15%). 전부 배포 전. regime×strategy: trending_bear×defensive 17건 -35.04(주범, §8-26 수정완료), trending_bull×momentum 2건 0승(신규 주목), ranging×micro_swing 1건. exit_reason: reconciled_with_fill 19건(TP/SL).

병목 계층 (universe->bull->entry funnel 측정):

| 계층 | 제약 | 값 | 근거 |
|---|---|---|---|
| 1. 후보 평가 | universe | 8 | getCryptoScreeningMaxDynamic 기본 8 |
| 2. 동시 슬롯 | MAX_POSITIONS | ~4 | signal.ts SAFETY 3 + cfg override, 로그 슬롯4->4 |
| 3. 총 노출 | 가용 자금 | ~474 USDT | 로그 "가용 474.60", capital_backpressure |

funnel: 전체 binance 1d 181심볼 -> daily bull 78(43%) -> universe 동시 8 -> 7일 회전 34심볼 -> trigger fired 29건(18심볼) -> 진입 24건. fired->진입 83%(양호).

핵심: bull 후보 78개 충분. no_bullish_candidate는 funnel-report 진단이 상위 5개만 평가(LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_LIMIT=5, 캡10)한 메시지일 뿐, 실제 발굴(markets/crypto.ts: buildDiscoveryUniverse + binance top volume gate)은 별개. 자금 sizing: perSlotAmount=buyableAmount/effectiveSlots (capital-manager.ts:1209) -> 슬롯 증가 시 포지션크기 감소(자금 고정).

### 8-31-4. (1) 즉시 구현 가능 타스크 (데이터 누적 불필요)

| # | 타스크 | 방법 | 효과 |
|---|---|---|---|
| 1 | universe 확대 | screening_crypto_max_dynamic 8->15 | 후보 품질 향상 (자금 무관, 안전) |
| 2 | MAX_POSITIONS 상향 | cfg.max_concurrent_positions 4->5 | 분산 증가 (자금 무관, 포지션 축소) |
| 3 | bull×momentum 로직 점검 | 진입/exit 기준 검토 | 0승 원인 규명 |
| 4 | funnel-report 진단 정확도 | TA_LIMIT 5->10 + 캡 상향 | no_bullish 오진단 해소 |

근본 성장: 자금 증액 (474 USDT -> 증액 시 총 운용규모 증가). 기타 대기: KIS 전략 개선 / Hub LLM Week 2 / 블로 B3.

### 8-31-5. (3) 승격 대기 타스크 [데이터 부족]
- paper_promotion_gate: backtest winRate 64%(양호)인데 insufficient_oos_sample(trades=14, bars=710) + sharpe 0 -> would_block. strategy_quality not_shadow_ready.
- LEARNED_BIAS shadow: 0 로깅 (bull 국면, bear 대기)
- bear observer: waiting (bear 미도래)
- intent_promotion_candidates: 0 rows (NLU 의도학습용, 거래 승격과 무관)
- 결론: 즉시 승격 가능 타스크 없음 -> 거래 데이터 누적이 선행 (discovery 병목과 연쇄)

### 8-31-6. 핵심 통찰 [연쇄 구조]
universe 8 + 자금 474 -> 진입 적음(7일 24건) -> OOS 표본 부족(14건) -> 승격 차단 + 학습 데이터 부족. 즉 입구(universe/자금)가 근본 병목. 진입 증가 -> 데이터 증가 -> 승격/학습 증가의 선순환 가능. 단 fired->진입(83%)은 양호하므로 진입 판정 로직은 정상.

### 8-31-7. sweeper dust 점검 (참고, 동일 세션그룹)
dust 로직 정상(DUST_USDT=3, exclude_from_learning=true), consistency guardrail($10 감지), 현재 open dust 0, fold 재발 없음(월별 micro: 3월0%/4월8.8%/5월20.5%/6월0%).


[정정 2026-06-21 세션2] 가용 자금 실측(지갑 직접 조회 getBinanceBalanceSnapshot): USDT free = 680.80. 본문 8-31-3의 "~474"는 로그 스냅샷(buyable 부분값)이었고 실제 가용 USDT는 680.80. used(포지션 묶임): SOL 1.439, MEGA 1952.5. dust: BNB/TRU/LUNC/PEPE. 따라서 MAX_POSITIONS 상향 여지 더 큼: 680/5슬롯=136, 680/6슬롯=113 USDT(포지션당 충분).


[실측 정정 2026-06-21 세션2-B] getLunaBuyingPowerSnapshot 실측: totalCapital=892.05(not 2080), freeCash=680.80, reservedCash=89.20(reserve 10%), buyableAmount=590.24(not 474; 474는 과거 시점값), max_concurrent_positions=7(NOT 4!), openPositionCount=2, remainingSlots=5, minOrderAmount=34.04, universe=8.
★ 병목 재진단: 슬롯(7개중 2개 사용, 5개 여유) + 자금(buyable 590 = minOrder 17개분) 모두 여유. 동시 open 2개뿐 -> 진짜 병목은 universe 8(후보 평가 게이트)+신호 생성. MAX_POSITIONS 상향 불필요(이미 7). 핵심 조정 = universe 8->15. reserve 10->7%는 선택(buyable 590->625).


[전략 분포 실측 2026-06-21 세션2-C] v_trades_real_usd 전체 LIVE regime×strategy:
- trending_bull×momentum_rotation: 353건 +2045.62 104승(29.5%) [주력 흑자]
- trending_bear×mean_reversion: 41건 +842.62 11승 [흑자; observer가 기다리던 조합이 이미 흑자]
- ranging×mean_reversion: 70건 +478.30 25승 [흑자]
- trending_bear×defensive_rotation: 71건 -649.90 15승 [유일 주요 손실; §8-26 수정완료]
- trending_bull×equity_swing: 9건 -59.06 [KIS 주식, crypto 무관]
★ "bull×momentum 2건 0승"은 최근 7일 2건(-7.37) 착시 -> 전체 353건 흑자, 표본 부족. crypto 전략 건강(손볼 손실 없음). bull×momentum 점검 불필요. 진짜 레버는 universe 8->15(진입 기회 확대).


## §8-32. sizing 단일화 완료 + 병목 재진단 종합 (2026-06-21 세션3, 메티)

### 8-32-1. sizing unify 5단계 완료
CODEX_LUNA_SIZING_UNIFY(v3, archive 이동) 5단계 코덱스 구현 + 메티 독립검증 + 마스터 분리커밋 완료. 상세는 TRACKER ## SIZING.
- Phase 1 레짐멀티->calculatePositionSize(25dd01324) / Phase 2 LIVE·PAPER 통일(6fbd4693d) / Phase 3 signal.amount 정합(1dabb91b3) / Phase 4 거래데이터 가드 sizing 실제연결(57d4e0844) / Phase 5 capital snapshot invalidation dead code 폐기(8c4d2707d)
- 결과: 실제 주문 = calculatePositionSize(레짐멀티) × combined(재진입 × 실행모드 × 거래데이터가드) 단일경로. LIVE/PAPER 동일 로직, signal.amount=실제체결 정합.

### 8-32-2. 병목 재진단 (§8-31-4 즉시타스크 정정)
§8-31-4 즉시타스크 4개 중 universe만 유효, 나머지 정정(세션2-B/C 실측):
- universe 8->15: 적용 완료(18:36 KST). 핵심 레버.
- MAX_POSITIONS: 이미 7(NOT 4). 동시 open 2개로 슬롯 5 여유 -> 상향 불필요.
- bull×momentum 0승: 최근7일 2건(-7.37) 착시. 전체 353건 +2045 USD 104승 주력흑자 -> 점검 불필요.
- funnel TA_LIMIT 5->10: 진단 메시지 정확도만(실제 발굴 별개경로) -> 우선순위 낮음(로그 노이즈).

### 8-32-3. 현 국면 = 데이터 대기
입구(universe) 확대 직후라 즉시 실거래 코드 작업 거의 없음. 대기 항목:
- universe 15 효과 검증: 1~2일 후 진입수(baseline 3.7/일)·동시open(2)·심볼다양성(18/주) 비교
- 승격 게이트: OOS 14건 부족 -> 진입 누적 선행
- bear observer / LEARNED_BIAS: bear 국면 도래 대기
- 다음 우선순위: 데이터 누적 후 effect 분석 -> 결과로 다음 조정. 즉시는 TA_LIMIT 로그픽스(선택) 또는 타팀(KIS/Hub/블로) 전환.
