# 루나팀 보강안 — 코드 vs 보강안 정밀 적용 검토 (APPLY REVIEW)

> 작성: 메티 · 2026-06-08~ · 입력=LUNA_BOOST_DESIGN.md(20개 보강안) + 기존 소스 재독
> 목적: v0.3 통합 전, 각 항목을 **기존 코드(프로세스) ↔ 보강안 정밀 대조** → 구현 가능 적용안 확정.
> 양식: ① 기존 실측(file:line) ② Δ 3분류(기존/비활성/신규) ③ 적용안 정밀(파일·함수·advisory vs 경계·무중단·테스트) ④ 리스크/순서.
> ⚠️ 실측은 재독 기반이나, 실제 변경 전 해당 파일 전체 재독 필수.

## 강력권장 정밀 검토

### B-13. 리스크 회로차단기 — 모델독립 veto
**기존 실측**:
- `shared/capital-manager.ts:704 checkCircuitBreaker(exchange,tradeMode)` → ① 일간손실(:712) ② 주간손실(:722) ③ 연속손실 쿨다운(+`getCryptoGuardSofteningPolicy`:874 완화). `{triggered,type,reason}`.
- `preTradeCheck`(:793): 잔고→포지션수(`max_concurrent_positions`)→**checkCircuitBreaker(:828, triggered 시 차단)**→일일거래→`buildAllowedTradeDecision`.
- 설정 `getCapitalConfigWithOverrides`(:150): `max_daily_loss_pct?0.10`·`max_weekly_loss_pct?0.20`·`max_capital_usage?0.50`·cooldown. override range(:158).
- `getTotalCapital`(:425) = **현재값만**(고점 이력 없음). 자본 스냅샷 테이블 없음.
- **기존 kill-switch**: `scripts/luna-kill-switch-consistency.ts`·`luna-live-fire-final-gate.ts`(killSwitch blockers) + `.lock` 패턴(`kis-client.ts:244`)·`tradingHalt`(domestic-official-reference).
- `nodes/l31-order-execute.ts:8 run({sessionId,market,symbol,saved})` = 주문 실행점.

**Δ 3분류**:
- **기존**: 일/주/연속손실 회로 + 완화 + preTradeCheck 통합 + 설정 override + **kill-switch 인프라**.
- **비활성**: —
- **신규**: ① peak-drawdown 체크 ② **HWM(고점자본) 영속**(전제) ③ correlation 체크 ④ `max_peak_drawdown_pct` 설정.

**적용안 정밀**:
1. **HWM 영속(신규 전제)**: 자본 스냅샷마다 high-water-mark 갱신·영속(신규 컬럼/state). `getTotalCapital` 호출 지점에서 HWM 비교.
2. `checkCircuitBreaker`에 **체크#4 peak-drawdown**: `totalCapital ≤ HWM*(1−policy.max_peak_drawdown_pct)` → `{triggered:true,type:'peak_drawdown',halt:true}`. **완화 미적용(경계)**.
3. **halt = 기존 kill-switch 확장**(신규 lock 신설 X): peak_drawdown 시 kill-switch state set → `live-fire-final-gate`·`preTradeCheck`·`l31-order-execute.run()` 진입부가 이를 존중·차단. **해제=마스터 명시 행동**.
4. `getCapitalConfigWithOverrides` defaults에 `max_peak_drawdown_pct?0.10` + override range 추가.
5. **correlation(신규)**: preTradeCheck(또는 Nemesis)에서 후보 vs 오픈포지션 상관 임계 초과 시 **advisory 감산**(B-19 연계).
- **advisory vs 경계**: 일/주/streak=advisory(완화) · **peak_drawdown halt=경계(하드·비완화)** · correlation=advisory(감산).
- **무중단/롤아웃**: ① peak-drawdown **shadow-log**(차단 없이 트리거 기록) → ② HWM 영속 → ③ kill-switch 연동+l31 진입 체크 → ④ **마스터 게이팅 활성화** → ⑤ correlation. crypto LIVE 무중단.
- **테스트**: peak-drawdown 유닛(트리거/비트리거)·HWM 갱신·kill-switch set+차단+수동해제·l31 abort·correlation. node --check + 스모크 + OPS.

**리스크/순서**: HWM 영속이 선결(없으면 peak-drawdown 불가). 순서 ①→⑤. 롤백: kill-switch 해제 + `max_peak_drawdown_pct=0`/env OFF.

### B-18. 검증 3종 — shadow→활성 + RST 신규
**기존 실측**:
- `shared/candidate-backtest-gate.ts`: `getCandidateBacktestGateMode`(:8, `LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE` 기본 **shadow**). `evaluateCandidateBacktestStatus`(:139): `effectiveSharpe`=sharpe_oos_deflated(과적합 차단)·`minSharpe`(`LUNA_CANDIDATE_BACKTEST_MIN_SHARPE`)·`maxOverfitGap`(`LUNA_BT_MAX_OVERFIT_GAP?2.0`)·**DSR 게이트**(`LUNA_DSR_GATE_ENABLED?false`·`LUNA_DSR_MIN?0.90`·`LUNA_DSR_MIN_TRADES?30`·`dsrWouldBlock`). `evaluateCandidateBacktestEntryGate`(:263).
- `shared/quant/monte-carlo.ts buildMonteCarloShadow` · `stress-test.ts buildStressTestShadow` · `korea-data-promotion-gate.ts buildKoreaDataPromotionGate`(데이터 readiness 임계).
- 컬럼: walk_forward_sharpe·sharpe_oos_deflated·dsr·**pbo**·oos_sample(migration).

**Δ 3분류**:
- **기존**: DSR 게이트 로직·OOS deflated·overfit-gap·walk-forward·MC·stress·promotion gate.
- **비활성(flag OFF/shadow)**: 전체 entry gate(mode=shadow)·DSR 게이트(ENABLED=false)·MC/stress(shadow).
- **신규**: ① **RST**(랜덤 엔트리 유의성 — 확인 결과 부재) ② **PBO 게이트 배선**(pbo 컬럼만 존재, 게이트 로직 없음) ③ MC 2종 확인 ④ 레짐 OOS 결합.

**적용안 정밀**:
1. **활성화=env 플래그(마스터)**: `..._ENTRY_GATE_MODE` shadow→enforce · `LUNA_DSR_GATE_ENABLED=true`(+MIN/MIN_TRADES) · `LUNA_CANDIDATE_BACKTEST_MIN_SHARPE` · `LUNA_BT_MAX_OVERFIT_GAP`. **검증 후 단계 ON**.
2. **PBO 게이트(신규)**: DSR 미러 — `LUNA_PBO_GATE_ENABLED`+`pboMax`+`pboWouldBlock`(pbo>max 차단). 컬럼 재사용.
3. **RST(신규)**: 엔트리 vs N 랜덤변형 permutation p-value → shadow 컬럼 + DSR/PBO **앞단 프리필터**. `python/quant`(monte_carlo.py 인접) 구현.
4. **MC 2종 확인**: buildMonteCarloShadow가 거래셔플+합성캔들 둘 다인지 재독·확장.
5. **레짐 OOS**: oos_sample을 레짐 라벨(B-10/12)과 결합.
- **advisory vs 경계**: 검증 게이트=**승급(promotion) 차단**(신규 후보 진입 차단)이지 실거래 즉시중단 아님 → advisory. 활성화=마스터 게이팅.
- **무중단/롤아웃**: 전부 shadow→enforce는 env 단계 전환. 기존 LIVE 무중단. 롤백=env OFF.
- **테스트**: 게이트 모드별 판정·DSR/PBO 차단·RST p-value·MC 2종. 스모크.

**리스크/순서**: ① RST/PBO 게이트 코드(shadow) → ② 과거 데이터로 합리적 차단 검증 → ③ 마스터 env 활성화(DSR→PBO→mode enforce). 롤백=env OFF.

### [메모] B-20 재검토 필요
`shared/dynamic-trail-engine.ts` 존재 발견 → B-20 트레일링 스톱이 부분 기구현일 수 있음. B-20 검토 시 dynamic-trail-engine 재독(트레일링 래칫·래더 Δ 재분류).

### B-10 · B-12. 레짐 전이행렬 + HMM 정밀화 (shadow→활성, 쌍)
**기존 실측**:
- `shared/hmm-regime-detector.ts detectHMMRegime`(`shadowOnly:true`) — 소비처 **단 1곳** `luna-analysis-prediction-phase-a.ts:69`(shadow phase-a). `transitionMatrix`(:51)=휴리스틱(stay 0.55~0.82).
- 실거래 레짐: 규칙기반 + `regime-strategy-policy.ts`(`resolveRegimeExpansionPolicy`:266)·`regime-expansion-policy.ts`. soft buy gate `LUNA_REGIME_BUY_SOFT_GATE_ENABLED`(advisory, signal-pre-filter).
- `regime-weight-learner.ts`(daily 0700, 게이트 `LUNA_ADAPTIVE_WEIGHT_ENABLED` 기본 true, false면 dry-run; `luna_regime_weight_snapshots` 영속). `dynamic-universe-selector`(regime, `shadow_only`). Elixir `llm_regime_analyzer`+`luna_regime_llm_shadow`.

**Δ 3분류**:
- **기존**: HMM detector(shadow)·규칙기반 레짐·weight-learner(env-gated, 레짐별 영속)·soft buy gate·universe selector·regime 스냅샷 테이블.
- **비활성(shadow/flag)**: HMM(shadowOnly·phase-a만)·universe selector(shadow_only)·weight apply(`LUNA_ADAPTIVE_WEIGHT_ENABLED`).
- **신규**: B-10 경험적 전이행렬(현 휴리스틱)·B-12 상태수 자동선택·forward 필터·안정성 필터.

**적용안 정밀**:
1. **B-10 경험적 전이(신규)**: `transitionMatrix` 휴리스틱 → `luna_regime_weight_snapshots` 시계열 레짐 라벨 전이 카운트로 P(r_{t+1}|r_t) 추정. **regime-weight-learner 재사용**(이미 레짐별·daily 영속). shadow 컬럼.
2. **B-12 정밀화(신규)**: detectHMMRegime — 상태수 자동선택(BIC) + forward 필터(엄격 인과, 인샘플 누수 차단) + 안정성 필터(≥3bar 지속 + 규칙기반 일치). `python/quant`(hmmlearn) 또는 TS 확장.
3. **shadow→활성**: phase-a/shadow 검증 → **env 플래그(`LUNA_HMM_REGIME_ENABLED` 신규, weight-learner 패턴)** + korea-data-promotion-gate/검증 통과 → 실거래 레짐 신호 승격(`regime-strategy-policy`/`signal-pre-filter` 소비). **마스터 게이팅**.
- **advisory vs 경계**: 레짐=Research advisory 신호(soft buy gate 기존 advisory). 실거래 차단 아님.
- **무중단/롤아웃**: HMM shadow 유지 → env 단계 활성화. 롤백=env OFF.
- **테스트**: 전이행렬 추정·상태수 BIC·**forward 인과(누수 0 검증)**·안정성(≥3bar). 스모크 + phase-a 대조.

**리스크/순서**: ① B-10 경험전이(shadow)+B-12 정밀화(shadow) → ② phase-a/shadow 검증 → ③ env 활성화 → ④ 실거래 소비(regime-strategy-policy). 의존: B-11(차등사이징)은 B-12 안정성 필터 통과 전제. 롤백=env OFF.

---
## 진행 상태 (2026-06-08 세션 4)
- ✅ 강력권장 정밀 검토 **4/6**: B-13(회로차단기)·B-18(검증 shadow→활성)·B-10·B-12(레짐 쌍).
- 정밀 검토에서 확인된 핵심: **활성화는 대부분 env 플래그**(LUNA_DSR_GATE_ENABLED·LUNA_ADAPTIVE_WEIGHT_ENABLED·신규 LUNA_HMM_REGIME_ENABLED 등) + 마스터 게이팅. 진짜 신규는 HWM 영속·RST·PBO 게이트 배선·경험적 전이행렬·HMM 정밀화·correlation.
- ⏭️ 다음 = 강력권장 잔여 **B-06(단일변수 자기개선)·B-01(ADR)** 정밀 검토 → 권장 12(특히 **B-20 dynamic-trail-engine 재독**) → 참고 → v0.3 통합.

### B-06. 단일-변수 자기개선
**기존 실측**:
- `shared/reflexion-engine.ts`(438줄): `runReflexion`(:40)·`checkAvoidPatterns`(:93)·`getAllAvoidPatterns`(:133) — 평가 + **오류 회피 패턴** 저장/회수.
- `python/finrl-x/layer3-strategy-evolution.py`: `MutationEvent`(mutation_type·old_params·new_params)·`generate_mutation`(:86) — **이미 단일-파라미터 변경**(regime_filter none→trend_only·confidence 0.55→0.65·tp_sl).
- darwin `v2/cycle/apply.ex`·`edison.ex`·jido `apply_mutation.ex` — 자율 적용 사이클. + 3층 Reflexion(l1/l2/l3) + self-rewarding(B-05).
- **실험/가설 원장: 부재**.

**Δ 3분류**:
- **기존**: reflexion 평가·오류 회피 루프·단일-파라미터 mutation·darwin 자율 적용·self-rewarding.
- **비활성**: —
- **신규**: **단일-변수 실험 원장**(가설+대조+측정Δ+keep/revert). mutation은 이미 단일-파라미터지만 과학적 원장(가설·대조·인과 귀속) 없음.

**적용안 정밀**:
1. **실험 원장(신규)**: mutation(finrl-x)/reflexion 제안마다 레코드 = {hypothesis, variable(단일), old/new, control_ref, target_metric, measured_delta, decision(keep/revert), trace}. JSONB/테이블. `generate_mutation` 출력에 가설/대조 부착.
2. **단일-변수 강제 게이트**: darwin `apply.ex`(proof-r 단계)에서 1실험=1변수 검증 + **OOS/검증(B-18) 통과 강제** 후 apply(jido apply_mutation 앞단).
3. **scorer 연동**(B-05 calcSelfReward) + **ADR 연동**(B-01: 실험=결정기록).
4. **오류 회피 재사용**: reflexion-engine checkAvoidPatterns/getAllAvoidPatterns로 실패 실험 재발 차단.
- **advisory vs 경계**: 자기개선=실험/shadow 영역 → advisory. **darwin 자율 apply는 B-18 검증 통과 필수(경계: 미검증 전략 실거래 진입 금지)**.
- **무중단/롤아웃**: 원장 기록(shadow) → 단일-변수 강제 게이트 → darwin apply 연동. 롤백=게이트 OFF.
- **테스트**: 원장 기록·단일-변수 위반 거부·keep/revert·avoid-pattern 재발 차단. 스모크.

**리스크/순서**: ① 실험 원장(기록) → ② 단일-변수 강제 + B-18 검증 게이트(proof-r/apply) → ③ scorer/ADR 연동. 의존: B-18·B-05·B-01. 롤백=게이트 OFF.

### B-01. ADR 결정 기록
**기존 실측**:
- `shared/trade-journal-db.ts trade_rationale`(:394): per-trade provenance — aria/sophia/oracle/hermes_signal·zeus_bull_case·athena_bear_case·`luna_decision`(NOT NULL)·`luna_reasoning`(NOT NULL) + JSONB(analyst_signals·strategy_config·**debate_log**·autonomy_phase). `insertRationale`.
- **범용 JSONB 이벤트 스토어 패턴**: `VALUES ('<event_type>', $1::jsonb)` — reflexion-engine(:76)·trade-quality-evaluator(:154)·luna-feedback-loop-orchestrator(:333)·luna-agent-evolution(:113)·finrl-orchestrator(:158).
- **ADR 메타 레이어·회의/전략 결정 영속: 부재**.

**Δ 3분류**:
- **기존**: per-trade rationale(debate_log 포함)·범용 JSONB 이벤트 스토어.
- **비활성**: —
- **신규**: **ADR 메타 레이어**(아키텍처/전략 3기준 결정)·3기준 필터·Codex Traces 매핑.

**적용안 정밀**:
1. **ADR 저장(신규, 스토어 재사용)**: 신규 테이블 대신 **기존 JSONB 이벤트 패턴 재사용** — `('adr_decision', {context, alternatives, tradeoff, decision, outcome, criteria_passed, debate_ref}::jsonb)`. (또는 전용 경량 테이블.)
2. **3기준 필터**: 되돌리기 어려움 + 맥락 없이 의아 + 실제 트레이드오프 — 통과분만 ADR(회의/B-06 실험/가드 정책 결정).
3. **debate_log 링크**: trade_rationale.debate_log를 ADR 근거로 참조.
4. **Codex Traces 매핑**: lane hand-off=Traces, 결정점=ADR 엔트리(회의록).
- **advisory vs 경계**: ADR=기록 레이어(부수효과 없음) → advisory.
- **무중단/롤아웃**: 순수 추가(기존 로직 불변). meeting-room(B-09) 회의록과 함께 산출.
- **테스트**: ADR 기록·3기준 필터·debate_log 링크. 스모크.

**리스크/순서**: meeting-room(B-09)과 함께(회의=ADR 산출 맥락) 또는 단독 선행 가능(기록 레이어). 의존 적음. 롤백=기록 중단(무해).

---
## 진행 상태 (2026-06-08 세션 5)
- ✅ **강력권장 정밀 검토 6/6 완료**: B-13·B-18·B-10·B-12·B-06·B-01.
- 공통 결론: 활성화=env 플래그+마스터 게이팅 / 저장=기존 JSONB 이벤트 스토어·kill-switch·regime 스냅샷 재사용 / 진짜 신규=HWM·RST·PBO 게이트·경험 전이행렬·HMM 정밀화·correlation·단일변수 실험원장·ADR 메타.
- ⏭️ 다음 = **권장 12 정밀 검토**(우선 **B-20 `dynamic-trail-engine` 재독** — 트레일링 기구현 여부) → 참고 → **DESIGN/TRACKER v0.3 통합** → Phase 1 CODEX.

## 권장 정밀 검토

### B-20. 트레일링 스톱 + 래더 — [정정] 트레일링 기구현
**기존 실측(BOOST 오판 정정)**:
- `shared/dynamic-trail-engine.ts`(114줄) `computeDynamicTrail`(:21): **chandelier·SAR·VWAP·ATR 트레일링** + breach(`dynamic_trail_stop_breached`). 트레일링 스톱=본질상 래칫(상승만) → **영상의 단순 플로어 이미 능가**.
- 실거래 배선: `position-reevaluator.ts:1622 computeDynamicTrail(buildDynamicTrailInputFromChart(...))`, 게이트 `shouldApplyDynamicTrail()`(position-lifecycle-flags:134·position-monitor-agent-plan:75). 스모크 `runtime:dynamic-trail-engine-smoke`. `optimal-exit-analysis:454 profit_trailing_engine` 권고.

**Δ 3분류(정정)**:
- **기존**: 트레일링 스톱 엔진(다종)·breach·실거래 배선·profit_trailing 권고. (BOOST의 "트레일링 신규"는 **오판** — 기구현.)
- **비활성**: `shouldApplyDynamicTrail()` 게이트(모드별 OFF 가능).
- **신규**: **래더 엔트리(하락 분할매수, scale-in)** — 미발견(진입측).

**적용안 정밀**:
1. **트레일링=재사용/활성 확인**: `shouldApplyDynamicTrail()` 적용 모드 점검(필요 시 활성화). 단순 "플로어만 상승"은 chandelier/ATR의 부분집합 → 추가 구현 불필요.
2. **래더 엔트리(신규)**: 하락 분할매수 로직 — **B-13 회로차단기/HWM halt와 결합 필수**(래더가 drawdown halt·max_capital_usage 위반 금지). preTradeCheck 통과 하에서만.
- **advisory vs 경계**: 트레일링=출구 보호(기존) · 래더=진입(경계 인접 — 자본사용률·drawdown 한도 준수).
- **무중단/롤아웃**: 트레일링 그대로 · 래더는 신규(shadow→소액 검증). 롤백=래더 OFF.
- **테스트**: 트레일링 모드 활성·래더 진입 시 B-13 한도 준수·자본사용률. 스모크.

**리스크/순서**: 트레일링 선검토 완료(기구현) → 래더만 신규(B-13 의존). 롤백=래더 OFF.

---
## 진행 상태 (2026-06-08 세션 5 — 추가)
- ✅ 강력권장 6/6 + 권장 B-20(정정: 트레일링 기구현, 래더만 신규).
- **누적 정정**: B-13 halt=kill-switch 확장 · B-18 대부분 shadow 기구현 · B-10/12 HMM shadow · B-20 트레일링 기구현. → **보강안 다수가 "신규"가 아니라 "활성화/확장"**임이 정밀 검토로 거듭 확인.
- ⏭️ 다음 = 권장 잔여 11(B-02·03·05·07·08·09·11·15·16·17·19) 정밀 검토 → 참고 → v0.3 통합.
