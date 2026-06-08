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

### B-05. 성공/실패 스코어러
**기존**: `shared/luna-self-rewarding-engine.ts` calcSelfReward(SelfRewardInput)·recordSelfReward(agentsInvolved)·WeeklyLearningReport. **posttrade-auto-trigger**(SELL→품질평가→posttrade-skill-extractor 자동). = 스코어러 **구축+자동**.
**Δ**: 기존=스코어러·자동 트리거·agent 귀속·주간학습 / 신규=결정 목표·가설(B-01/06) 대비 채점 + 레짐별 분해.
**적용**: calcSelfReward 입력에 decision_goal/hypothesis_ref 추가 → posttrade 평가가 목표 대비 측정 + 레짐 태그. advisory. 무중단(기존 파이프 확장). 테스트=목표대비 채점·레짐 분해.
**순서/의존**: B-01·B-06 후. 롤백=필드 무시.

### B-11. 차등 사이징 P(bull)−P(bear)
**기존**: `shared/dynamic-position-sizer.ts computeDynamicPositionSizing` 입력=pnlPct·currentWeightPct·targetVolatility·realizedVolatility·rewardRisk·winRate → half-Kelly+vol-targeting+momentum+defensiveFloor. **레짐 확률 입력 없음**.
**Δ**: 기존=Kelly+vol-targeting 사이징 / 신규=레짐 확률 conviction 입력.
**적용**: 입력에 `regimeProbDelta`(=P(bull)−P(bear), detectHMMRegime) 추가 → targetWeight conviction 배수. **B-12 안정성 필터 통과 시만**. advisory. 무중단(옵셔널, 기본 0=무영향). 테스트=conviction 스케일·안정성 게이트.
**순서/의존**: B-10/B-12 후. 롤백=regimeProbDelta=0.

### B-16. 검증 보강 — 캘리브레이션·벤치마크
**기존**: B-18 게이트(DSR/PBO/MC/stress) 보유. **캘리브레이션(Brier/reliability) 확인 결과 부재**.
**Δ**: 기존=검증 게이트 / 신규=확률 캘리브레이션(Brier·reliability: 레짐/신호 확률)·벤치마크(buy-hold/random, RST 연계).
**적용**: 신규 calibration 모듈(Brier·reliability bins) — 레짐/신호 확률 보정 측정 → shadow 컬럼. 벤치마크=buy-hold/random(B-18 RST 공유). advisory. 무중단(shadow). 테스트=Brier·reliability.
**순서/의존**: B-18 후(검증 인프라 공유). 롤백=shadow만.

### B-19. 스마트머니/수급 추적
**기존(중요)**: OpenDART **광범위 기구현** — `python/korea-data/opendart_client.py`·`team/discovery/domestic/dart-disclosure-collector.ts`·A2A `disclosure-event-driven.ts`·migration `corp_disclosures.sql`·financial-batch/disclosure-refresh 스크립트. korea-data-promotion-gate가 `openDartConfigured`(API키) 체크. `signal.ts MARKET_FLOW`(장중 수급)·discovery `LUNA_DISCOVERY_DART`(기본 OFF).
**Δ**: 기존=공시/재무 수집·disclosure-event A2A·DART 클라이언트 / 비활성=OpenDART 키 미설정·LUNA_DISCOVERY_DART OFF / 신규=외국인·기관 순매수 흐름(KRX 수급, 공시와 별개일 수)·5%/내부자/행동주의 신호 정제.
**적용**: ① **활성화**=OpenDART 키(secrets-doctor)+LUNA_DISCOVERY_DART ON. ② disclosure-event-driven → 5%대량보유·임원·행동주의를 Research 신호로. ③ **외국인/기관 순매수(KRX 수급)** 어댑터 — 미보유 시 신규. advisory(Research). 무중단(shadow→활성). 테스트=공시 신호·수급 어댑터.
**순서/의존**: OpenDART 키 선결. 롤백=flag OFF.

### B-17. self-evolving 스킬 — [정정] 기반 구축
**기존(중요)**: `shared/posttrade-skill-extractor.ts`(성공 거래→스킬 추출) + **`bots/investment/skills/luna/*.skill.md`**(posttrade-feedback·weekly-review·entry-trigger·**shadow-auto-promote**·l5-readiness…) + 3층 Reflexion. = **self-evolving 기반 구축**.
**Δ**: 기존=스킬 추출·SKILL.md 패턴·shadow-auto-promote / 신규=reflexion 결과가 스킬 **UPDATE**(추출뿐 아니라 갱신) + B-06 단일변수 원장 경유.
**적용**: posttrade-skill-extractor + reflexion-engine 연결 → 검증된 개선이 SKILL.md 갱신(B-06 원장 + **B-18 검증 통과분만**). curated memory(pgvector). 하니스 교체 X. advisory(스킬=절차). 무중단(확장).
**순서/의존**: B-06·B-18 후. 롤백=갱신 중단.

### B-02. CONTEXT.md 글로사리
**기존**: `skills/luna/` SKILL.md 패턴 확립(다수). 글로사리 skill 없음.
**Δ**: 신규=글로사리 skill(용어·레짐·에이전트·계약).
**적용**: skills/luna/에 glossary.skill.md 신규(기존 패턴 재사용). agentskills.io 포터블. progressive disclosure(B-15). 무중단(추가).
**순서/의존**: 독립. 롤백=파일 제거.

### B-03. grill 자기심문
**기존**: reflexion(자기평가)·skills/luna 패턴. grill skill 없음.
**Δ**: 신규=grill skill(설계/전략 가정 심문, ADR 전).
**적용**: skills/luna/에 grill.skill.md(체크리스트) + 회의 FSM grill 단계. 무중단(추가).
**순서/의존**: B-01 연계. 롤백=단계 제거.

### B-07. CEO 단일 창구
**기존**: `team/luna.ts orchestrate()`(:703) + Hub 단일 API + A2A `multi-agent-coordination`. = 단일 진입 거의 존재.
**Δ**: 기존=orchestrate·Hub·coordination / 신규 최소=회의 단일 창구(웹 "회의 시작"+다이얼) 통일.
**적용**: meeting-room을 Hub hub-proxy 단일 경유(결정②). orchestrate 재사용. 무중단.
**순서/의존**: B-09와 함께. 롤백=기존 경로.

### B-08. 비용 최적화 가드
**기존**: `trade-quality-evaluator.ts ensureDailyEvaluationBudget`(`llm_daily_budget_usd?5`→`llm_daily_budget_exceeded`) = **일일 LLM 예산 가드 부분 존재**. Hub llm-models.json·HUB_LLM_GEMINI_DISABLED.
**Δ**: 기존=일일 LLM 예산 가드(품질평가) / 신규=회의/사이클 전체 예산 가드 + agent-cost-mcp 대시보드.
**적용**: ensureDailyEvaluationBudget 패턴을 회의/사이클로 확장 + per-message 비용 로그(PostToolUse). 초과=advisory 경고(하드 정지=경계). local 우선 라우팅. 무중단(확장).
**순서/의존**: 독립. 롤백=예산 무제한.

### B-09. 병렬 에이전트 뷰 + needs-input 큐
**기존**: A2A `multi-agent-coordination`·`multi-agent-trade-decision`·`cross-agent-validation`(조정 백엔드 존재). meeting-room UI 설계 중.
**Δ**: 기존=멀티에이전트 조정 백엔드 / 신규=meeting-room UI 뷰(A2A Task 상태)+needs-input 큐.
**적용**: A2A Task 상태(submitted→working→input-required→completed)=패널 모델 · input-required=마스터 승인 큐(B-07). 기존 coordination skill 재사용. 무중단(UI 신규).
**순서/의존**: meeting-room WS. 롤백=뷰 비활성.

### B-15. 컨텍스트 예산
**기존**: skills progressive disclosure·local 우선. 컨텍스트 예산 정책 명시 없음.
**Δ**: 신규=회의 안건별 컨텍스트 예산 + RAG 회수 상한.
**적용**: progressive disclosure(이름/설명 먼저)·안건별 토큰 예산·RAG top-k 상한. B-08 연계. 무중단(정책).
**순서/의존**: B-08 연계. 롤백=상한 해제.

---
## 진행 상태 (2026-06-08 세션 6 — 권장 정밀 검토 종료)
- ✅ **권장 11/11 완료**(B-05·11·16·19·17·02·03·07·08·09·15). 강력권장 6 + 권장 11 + B-20 = **18개 정밀 검토 완료**(참고/선택 4 제외).
- **거듭 확인된 정정**: B-17(skill-extractor+skills/luna 기구현)·B-08(예산가드 부분존재)·B-09(coordination 백엔드존재)·B-19(OpenDART 기구현)·B-05(scorer 자동) — 보강안 다수가 **활성화/확장/스킬추가**, 진짜 신규는 소수(글로사리·grill·캘리브레이션·conviction 입력·단일변수 원장·ADR·HWM·RST·PBO 게이트·경험 전이행렬·HMM 정밀화·correlation·래더·외국인수급).
- ⏭️ 다음 = (선택)참고 4 간단 + **DESIGN/TRACKER v0.3 통합**(가드 "경계"=peak-drawdown halt, Validation 레인=env 활성화 경로, 신규 WS, advisory vs 경계 표) → Phase 1 CODEX 프롬프트.

## 참고/선택 정밀 검토 (4)

### B-04. 좋은 에이전트 4기준 [프레임워크]
**기존**: 데이터 어댑터(OpenDART/KIS)·launchd 무중단·목표(수익)·reflexion 자기개선 = 4기준 대부분 충족.
**적용**: 신규 구현 아님 — 회의/리뷰 **체크리스트**(정확데이터·24/7·명확목표·자기개선). 무해.

### B-14. 펀더멘털/스윙 원칙 [상위 원칙]
**기존**: signal.ts MARKET_FLOW·펀더멘털 파이프(OpenDART)·레짐 스윙. 스캘핑 미채택.
**적용**: 코드 아닌 **전략 선택 가드레일 원칙** — 전 보강안(B-10/11/19) 상위. 문서화만.

### 전략 템플릿 [선택]
**기존**: Donchian/EMA/ATR 부품 산재. 통합 추세추종 템플릿 없음.
**적용**: skills/luna/에 trend-following.skill.md(B-02/17 패턴). 선택. 무중단(추가).

### 도구 패턴 [선택]
**기존**: A2A skills 18개·MCP(korea-data). TradingView 제어형/paperclip 거버넌스는 외부 참고.
**적용**: TradingView **데이터형만** 보조 · paperclip 롤백 패턴 차용 · Codex-as-MCP. 채택 시 신규.

---
## ✅ 정밀 검토 종료 — 전 20개 + 참고 4
- 강력권장 6 + 권장 11 + B-20 + 참고/선택 4 = **전 항목 코드 vs 보강안 대조 완료**.
- **신규(net-new) 최종 목록**: HWM 영속 · correlation · RST · PBO 게이트 배선 · 경험적 전이행렬 · HMM 정밀화(상태수/forward/안정성) · 캘리브레이션(Brier) · conviction 입력(P(bull)−P(bear)) · 단일변수 실험원장 · ADR 메타로그 · 래더 엔트리 · 외국인/기관 수급 어댑터 · 글로사리/grill skill · meeting-room UI.
- **활성화(env/flag)**: DSR 게이트·HMM 레짐·adaptive weight·OpenDART·dynamic-trail·entry-gate mode.
- **확장**: 회로차단기·sizer·scorer·skill-extractor·예산가드·coordination.
- ⏭️ 다음 = **DESIGN/TRACKER v0.3 통합** → Phase 1 CODEX.
