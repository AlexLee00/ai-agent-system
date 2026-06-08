# 루나팀 보강안 상세 설계 (BOOST DESIGN)

> 작성: 메티 · 2026-06-08~ · 상태: 작성 중 · 입력=LUNA_VIDEO_REINFORCEMENT.md(B-01~B-20) + 기술 서베이
> 목표: B-01~B-20 각각을 **소스코드 딥분석 + 최신 기술(Skills·Hooks·MCP·A2A·Workflows) 적용·최적화 + 외부 베스트프랙티스** 기반 구현 가능 보강안으로. → DESIGN/TRACKER v0.3 통합 → Phase 1 CODEX.
> 원칙: 부품 재사용 우선 · advisory 게이트(차단=경계만) · PROTECTED/LIVE 무중단 · 3역할.

## §1. 기술 서베이 (전 보강안 공통 입력)

### 1.1 Skills (Anthropic + Codex, agentskills.io 공통 표준)
- **anthropics/skills**(공식·Apache2.0): SKILL.md(지시+메타) 폴더, 동적 로드, **progressive disclosure**(이름/설명/경로 먼저 → 사용 시 본문). Claude Code 플러그인 마켓플레이스(`/plugin install …@anthropic-agent-skills`), Skills API. **mcp-builder 스킬**(MCP 서버 생성)·docx/pdf/pptx/xlsx·web-artifacts.
- **Codex Skills**(2025-12~): `~/.agents/skills/SKILL.md` **동일 포맷** → **Claude Code ↔ Codex 포터블**. 플러그인(skills+MCP+app, `.codex-plugin/plugin.json`), `$skill-installer`, config.toml.
- **루나 적용**: 도메인 절차/전략/용어를 **SKILL.md로 패키징**(B-02 CONTEXT.md=glossary skill, B-03 grill skill, B-17 self-evolving skill, 전략 템플릿 skill). 메모리 `packages/core/lib/skills`·시그마 A2A Skills 12개 재사용. 메티→코덱스(Claude Code/Codex) 동일 스킬.

### 1.2 Hooks (Claude Code 12~21 이벤트 + Codex `codex_hooks`)
- 이벤트: **PreToolUse**(실행 전, exit 2=차단/거부), **PostToolUse**(사후, 검증/포맷/로그·undo 불가), SessionStart(컨텍스트 주입), Stop(exit 2=계속), SubagentStop, UserPromptSubmit.
- 핸들러 4종: **command**(셸) · **http**(엔드포인트 POST) · **prompt**(경량 LLM 평가) · **agent**(서브에이전트 검증). `async:true` 비차단. `.claude/settings.json`. JSON stdin(tool_name·tool_input·tool_response).
- 핵심=**결정론적 강제**("프롬프트 요청이 아니라 보장된 실행" — 모델이 못 잊고 못 건너뜀).
- **루나 적용**: **B-13 회로차단기=PreToolUse 훅**(주문 도구 차단, drawdown 한도 hit 시 exit 2 → "하드코딩·모델독립 veto"의 정확한 구현). **B-05 스코어러/B-18 검증=PostToolUse 훅**(매 결정 점수화·로그→CVRF, async). **point-in-time 누수=PreToolUse**(미래데이터 접근 차단). **우리 advisory 가드=prompt 핸들러**(경고 stderr+exit 0, 비차단). SessionStart=회의 시작 시 메모리/RAG 주입(stateless-wake).

### 1.3 A2A (Agent2Agent, Linux Foundation, v1.0 2026)
- **Agent Card**(`/.well-known/agent-card.json`: 능력·엔드포인트·인증·메타, v1.0 **서명**) · **Task 라이프사이클**(submitted→working→**input-required**→completed/failed/canceled) · Message(user/agent) · Artifact. HTTP+SSE+JSON-RPC(+gRPC). MCP(수직·도구)와 **상보**(수평·에이전트).
- **루나 적용**: 메모리 "A2A Skills 12개"와 정합. **Task 라이프사이클 = B-09 에이전트 상태/needs-master-input 모델 표준**(input-required=마스터 승인점). **Agent Card = 6레인 에이전트 능력 광고·위임**(Argos/Aria/Nemesis/Luna/Hanul/Chronos). 외부 에이전트(저스틴 등) 통합 시 표준. (전 내부 시스템이라 서명·멀티벤더는 선택.)

### 1.4 MCP (도구 접근 — 기존 서베이 + 신규)
- **mcp-builder 스킬**(anthropics)로 루나 전용 MCP 서버 생성. Codex-as-MCP(코덱스를 도구로 호출). 
- 금융/데이터 MCP(기 서베이): TradingView MCP(데이터형만 보조·CDP 제어형 보안/ToS 비채택), korea-stock-mcp(DART+KRX)·korea-stock-analyzer(수급/DCF)·네이버. **agent-cost-mcp**(비용 추적·예산경보·대시보드→B-08), **brain MCP**(SQLite 영속 메모리).
- **루나 적용**: meeting-room 독립 loopback(결정②)을 Hub `hub-proxy` 경유 노출. 데이터 어댑터(OpenDART/KIS)·B-19 수급/공시 소스. mcp-builder로 표준화.

### 1.5 Codex 오케스트레이션 / 워크플로우
- **Agents SDK 멀티에이전트**: PM 에이전트(REQUIREMENTS/TEST/AGENT_TASKS.md 작성)→설계/구현/테스트 에이전트 hand-off + **guardrails** + **Traces**(매 프롬프트·tool-call·hand-off 기록→대시보드 감사).
- Codex 슬래시(/review·/fork·/side·커스텀), 서브에이전트, AGENTS.md(=CLAUDE.md 대응), Codex Security(취약점).
- **루나 적용**: **Traces = 회의록 + B-01 ADR + 관측성**(매 lane hand-off 감사). PM 에이전트=Luna 오케스트레이터, hand-off=lane 전이, guardrails=advisory 게이트. compound-engineering/multi-agent 워크플로우 패턴 차용.

## §2. 보강안 작성 프레임 (각 B-항목 공통)
각 항목: **① 소스코드 딥분석**(실측 파일·계약) → **② 적용 기술**(§1 매핑) → **③ 외부 베스트프랙티스** → **④ 최적화 제안**(재사용·advisory·무중단) → **⑤ v0.3 반영 + WS/CODEX 연결**.

## §3. 우선순위
- **강력권장 6** (이번 세션 우선): B-01 ADR · B-06 단일변수 자기개선 · B-10 Markov 레짐 · B-12 레짐 정밀화 · B-13 회로차단기 · B-18 검증 3종.
- **권장 12**: B-02·B-03·B-05·B-07·B-08·B-09·B-11·B-15·B-16·B-17·B-19·B-20.
- **참고/선택**: B-04·B-14·전략 템플릿·도구 패턴.

---
## §4. 강력권장 보강안 (상세)

### B-13. 리스크 회로차단기 — 하드코딩·모델독립 veto [강력권장]
**① 소스코드(실측)**: `shared/capital-manager.ts:704 checkCircuitBreaker(exchange,tradeMode)` → `{triggered,type,reason}`. 현재: ① 일간손실(`policy.max_daily_loss_pct`) ② 주간손실(`max_weekly_loss_pct`) ③ 연속손실 쿨다운(`cooldown_after_loss_streak`/`cooldown_minutes`). **dev 완화**(`getCryptoGuardSofteningPolicy`→`softened:true`+`reductionMultiplier`) = 우리 "가드 최소" 철학이 이미 코드화. `preTradeCheck`가 호출→`{allowed,circuit,circuitType}`. 인접: risk-approval-chain/mode/execution-guard + `shared/quant/{monte-carlo,stress-test}.ts`(`killSwitchWouldTrigger`).
**② 적용 기술(§1.2 Hooks)**: 현 checkCircuitBreaker는 **앱 경로**(에이전트가 preTradeCheck 호출해야 작동)→모델이 건너뛸 여지. **PreToolUse 훅 승격**: order-execute(L31)/order-adapter 도구 호출 전 훅이 회로차단+halt 평가→`exit 2`=차단(stderr=사유). = 영상의 "하드코딩·모델독립 veto" 정확 구현(모델이 못 잊고 못 건너뜀).
**③ 외부 베스트프랙티스**: 영상 임계값(일 −2%→반감/−3%→청산·주 −5%→반감·**peak −10%→중단**) + correlation 체크(기존 포지션 상관) + López de Prado 자본보존. block-file=수동 재개.
**④ 최적화 제안**:
- **신규 peak-drawdown halt**: `policy.max_peak_drawdown_pct`(기본 0.10) 추가 → 트리거 시 `{type:'peak_drawdown',halt:true}` + **block 파일**(`state/luna-halt.lock`) 기록. preTradeCheck/훅이 lock 존재 시 전량 차단. **lock 삭제=마스터 명시 행동**("실거래=마스터" 정합). dev 완화 **미적용**(=경계).
- **신규 correlation 체크**: preTradeCheck에 기존 오픈포지션 vs 후보 상관 임계 초과 시 차단(Nemesis 노출/과집중, B-19 수급과 연계).
- **재사용**: 일/주/연속손실 + 완화 정책 그대로 · monte-carlo/stress-test killSwitch 임계 정합.
- **advisory vs 경계 구분**: 일/주/streak=완화 가능(절차 마찰) · **peak-drawdown halt=하드 veto(되돌릴 수 없는 손실=경계, 비완화)**.
**⑤ v0.3/WS**: DESIGN §3 가드 "경계"에 peak-drawdown halt 명시 · 신규 **WS-I(리스크 훅)**: capital-manager에 `max_peak_drawdown_pct`+correlation, order 도구 PreToolUse 훅, halt-lock 수동 재개. CODEX: 기존 checkCircuitBreaker **확장**(신규 로직 최소). 검증: 하드/소프트 트리거 + lock 재개 테스트.

---
## 진행 상태 (2026-06-08)
- ✅ §1 기술 서베이 5축(Skills·Hooks·A2A·MCP·Codex오케) · §2 프레임 · §3 우선순위 · §4 **B-13 회로차단기** 완성.
- ⏭️ 다음 = 강력권장 잔여 5개(각 소스 딥분석):
  - **B-01 ADR** → 회의록/decision artifacts + Codex Traces 매핑.
  - **B-06 단일변수 자기개선** → reflexion-engine/CVRF + darwin/sigma 소스.
  - **B-10 Markov 레짐** → L04 market-flow + python/quant 소스.
  - **B-12 레짐 정밀화** → HMM forward-only(신규 가능성).
  - **B-18 검증 3종** → 기존 `shared/quant/{monte-carlo,stress-test}.ts` **확장** + RST(신규) + 멀티기간 OOS + korea-data-promotion-gate.
  - → 이후 권장 12 → **DESIGN/TRACKER v0.3 통합** → Phase 1 CODEX 프롬프트.
- 발견 메모: `monte-carlo`·`stress-test`·`risk-approval-chain/mode/execution-guard`·`rl-policy-shadow` 기존 보유 → B-18·B-13 확장 기반(신규 최소).

### B-10. Markov 레짐 전이행렬 [강력권장]
**① 소스(실측)**: `shared/hmm-regime-detector.ts:51 transitionMatrix(probs)` = **휴리스틱**(대각 stay=clamp(0.55+prob·0.25, 0.55, 0.82), spill=(1−stay)/3) — 데이터 추정 아님. `detectHMMRegime`=softmax 4레짐(bull/bear/sideways/volatile), **`shadowOnly:true`**. 인접 자산: `regime-weight-learner.ts`·`regime-transition-position-smoke.ts`·migration `luna_regime_weight_snapshots.sql`·A2A `market-regime-analysis.ts`.
**② 적용 기술**: 데이터/quant(python finrl-x 레짐 환경 보유). 산출 전이행렬을 기존 A2A skill로 노출.
**③ 외부**: 영상 "20일±5% 3×3 stickiness"=경험적 전이확률 · Hamilton regime-switching.
**④ 최적화**: 휴리스틱 transitionMatrix → **경험적 추정**(과거 레짐 라벨 롤링 N-window 전이 카운트 → P(r_{t+1}|r_t)). `regime-weight-learner` 재사용·`luna_regime_weight_snapshots` 영속. 전이확률 기반 사이징(transition-position-smoke 연계, B-11). **shadow 유지 → 검증 후 승격**.
**⑤ v0.3/WS**: Research 레인 레짐 신호 강화. WS(레짐): transitionMatrix 경험추정 + 스냅샷. CODEX: hmm-regime-detector 확장(신규 최소).

### B-12. 레짐 정밀화 — HMM forward-only·안정성 [강력권장]
**① 소스(실측)**: 현 `detectHMMRegime`은 사실상 **softmax 휴리스틱 분류기 + 휴리스틱 전이**(고정 4레짐, `shadowOnly:true`). 진짜 HMM(가우시안 방출·Baum-Welch 전이·forward 필터)·상태수 자동선택·안정성 게이트 **없음**. `regime-expansion-policy.ts`는 레짐별 포지션 확장(상태수 아님). Elixir `llm_regime_analyzer.ex`+shadow 보유.
**② 적용 기술**: python/quant(hmmlearn) + 기존 hmm-detector 확장. Validation 레인 승격(korea-data-promotion-gate).
**③ 외부**: Gaussian HMM·Baum-Welch·forward-backward · BIC/AIC 상태수 선택 · 레짐모델 look-ahead 편향(OOS 적합).
**④ 최적화**:
- **상태수 자동선택 3~7**(BIC/AIC) — 신규(현 고정 4).
- **forward-algorithm 필터링**(엄격 인과: 과거로 적합·현재만 필터 → 인샘플 누수 차단).
- **안정성 필터**: 레짐 ≥3bar 지속 + 규칙기반 `market-regime.ts` 일치 시에만 실거래(B-10 전이확률 동반).
- 기존 shadow HMM 확장(재구축 X) · shadow→코어 승격은 검증 후.
**⑤ v0.3/WS**: DESIGN Validation 레인 "약→코어 승격" 정합. WS(레짐): HMM 정밀화+안정성 게이트. CODEX: hmm-regime-detector + python 확장.

### B-18. 검증 3종 게이트 — 대부분 기보유, RST만 신규 [강력권장]
**① 소스(실측·중요)**: `shared/candidate-backtest-gate.ts`에 **이미** `walk_forward_sharpe`·`sharpe_oos_deflated`·**`dsr`**(Deflated Sharpe)·**`pbo`**(Probability of Backtest Overfitting) 컬럼 + DSR 게이트(env 기본 OFF, 마스터 명시 활성화) + OOS deflated로 과적합 차단. `shared/quant/monte-carlo.ts buildMonteCarloShadow`·`stress-test.ts buildStressTestShadow`(+HISTORICAL_STRESS_SCENARIOS)·python `quant/{monte_carlo,stress_test}.py`. migration: pbo/dsr/meta_label/walk_forward_pooling/oos_columns/oos_sample. + `korea-data/hybrid/paper` promotion gate · `worldquant-101-korean.ts`(알파) · Elixir `validation/backtest.ex`. → **C2(CPCV/DSR/PBO 리더보드)는 이미 shadow로 구축됨.**
**② 적용 기술(§1.2 Hooks)**: 검증 metric 계산/로그=PostToolUse(async) · 리더보드=advisory(prompt 핸들러) · 약→코어 승격=promotion gate들.
**③ 외부**: 알고제왕 RST(엔트리 vs 2000 랜덤 P<임계) + MC(거래셔플+합성캔들) + 멀티기간 OOS · "엣지≠수익"=net(수수료 후)+거래빈도 패널티 · López de Prado(DSR/PBO/CPCV/meta-label — **이미 보유**).
**④ 최적화**:
- **RST 신규**(유일한 net-new): 엔트리 vs N 랜덤변형 → 경험적 p-value, **DSR/PBO 앞단 저비용 프리필터**(엣지 없으면 조기 탈락). shadow 컬럼/A2A skill.
- **MC 2종 정합**: `buildMonteCarloShadow`가 거래순서 셔플 + 합성캔들 둘 다 커버하는지 확인·확장.
- **레짐 OOS**: OOS 샘플을 레짐 라벨(B-10/12)과 결합 → bull/bear/sideways 횡단 보장.
- **net 기준 + 거래빈도 패널티**(엣지≠수익).
- **shadow→활성 승격**: DSR/PBO/MC/stress를 Validation 레인 + korea-data-promotion-gate로 활성화(DSR 게이트처럼 마스터 게이팅). **재구축 불필요**.
**⑤ v0.3/WS**: DESIGN §12(C2) — **기존 DSR/PBO/walk-forward/MC/stress가 이미 shadow임을 명시**(재작성 X, 활성화 경로 + RST만 추가). Validation 레인=이 게이트 엔진. WS(검증): RST 신규 + MC 2종 + 레짐 OOS + shadow→gate. CODEX: candidate-backtest-gate + monte-carlo 확장 + RST 신규.

### B-06. 단일-변수 과학적 자기개선 [강력권장]
**① 소스(실측)**: **3층 Reflexion** — Elixir `reflexion/l1_immediate.ex`(Shinn 2023 + Du 2023 Self-Rewarding)·`l2_daily.ex`(AutoGen Wu 2023 GroupChat)·L3 큐. `shared/reflexion-engine.ts`·`failed-signal-reflexion(-trigger).ts`(실패→학습)·`reflexion-guard.ts`(엔트리 게이트)·`meta-neural-reflexion-shadow.ts`+A2A. `runtime-z7-reflexion-avoidance-verify`(재발 회피). darwin(graft→edison→proof-r)·sigma(메타). python `finrl-x/layer3-strategy-evolution.py` mutation=**단일 파라미터**(tp_sl_adjust/confidence_relax·tighten/regime_filter/timeframe_shift). = 메모리 "오류 피드백 루프".
**② 적용 기술(§1.1·1.5)**: 자기개선 루프=**self-evolving 스킬**(B-17 Hermes 패턴) + **Codex Traces**(실험 감사). darwin 자율 적용.
**③ 외부**: 알고 영상 과학적 방법(변수 1개·측정·keep/revert) · Shinn Reflexion(기 인용) · ablation 규율.
**④ 최적화**:
- **단일-변수 실험 원장(신규)**: 각 실험 = 정확히 1개 변수 변경 + 가설 + 목표 metric + 대조군 + 측정 Δ + keep/revert. reflexion-engine 제안을 이 원장으로 강제(finrl-x mutation은 이미 단일-파라미터 → 가설/대조 부착).
- **scorer 연동**(B-05) · **ADR 연동**(B-01: 실험=결정기록).
- **darwin proof-r에 단일-변수 + OOS/검증(B-18) 통과 강제**.
- **오류 회피 루프 재사용**(failed-signal-reflexion-trigger + avoidance-verify → 재발 차단 게이트).
- 신규 최소: 원장 + 단일-변수 강제.
**⑤ v0.3/WS**: DESIGN 자기개선/Review 레인. WS(자기개선): 단일-변수 실험 원장 + reflexion 연동 + darwin proof-r 게이트. CODEX: reflexion-engine + 원장 신규.

### B-01. ADR 결정 기록 [강력권장]
**① 소스(실측)**: `shared/trade-journal-db.ts`에 **`trade_rationale` 테이블**(JSONB: `analyst_signals`·`strategy_config`·**`debate_log`**·`autonomy_phase`) + `insertRationale`/`linkRationaleToTrade` → **per-trade 근거는 이미 영속**. `nodes/l13-final-decision.ts`(type 'decision') 산출. 단 **아키텍처/전략 ADR**(시스템 메타 결정: 가드 정책·검증 방법·레짐 임계 선택 이유)은 비형식화.
**② 적용 기술(§1.5)**: **Codex Traces = ADR + 회의록 + 관측성**(매 hand-off/결정 기록·감사 대시보드). 회의(meeting-room) 전략 결정 = ADR 엔트리. ADR 템플릿=Skill(B-02 동반).
**③ 외부**: grill-with-docs **ADR 3기준**(되돌리기 어려움 + 맥락 없이 의아 + 실제 트레이드오프) — 모든 결정 아닌 3기준 통과분만.
**④ 최적화**:
- **ADR 로그(신규·경량)**: 회의(일/주)·자기개선 실험(B-06)·가드 정책 등 **3기준 통과 결정만** 기록(맥락·대안·트레이드오프·결정·결과). `trade_rationale`(거래용)와 별개 메타 결정 레이어.
- **debate_log 재사용**: 이미 영속되는 debate_log를 ADR 근거 링크로.
- **Traces 매핑**: lane hand-off=Traces, 결정점=ADR.
- 신규 최소: ADR 테이블/문서 + 3기준 필터.
**⑤ v0.3/WS**: DESIGN Review 레인 + 회의록에 ADR 섹션 · 8-step FSM 결정 단계에 ADR 훅. WS(ADR): ADR 로그 + 3기준 필터 + debate_log 링크. CODEX: ADR 영속 신규.

---
## 진행 상태 (2026-06-08 세션 2)
- ✅ **강력권장 6/6 완료**: B-13(회로차단기)·B-10(전이행렬)·B-12(HMM 정밀화)·B-18(검증 3종)·B-06(단일변수 자기개선)·B-01(ADR).
- 핵심 교훈: **루나는 이미 풍부**(HMM shadow·DSR/PBO/walk-forward/MC/stress shadow·3층 Reflexion·trade_rationale). 보강 대부분 = **기존 확장 + shadow→활성 승격**, 진짜 신규는 소수(peak-drawdown halt·correlation·경험적 전이행렬·HMM 상태수 자동선택·안정성 필터·RST·단일변수 원장·ADR 메타로그).
- ⏭️ 다음 = **권장 12**(B-02·03·05·07·08·09·11·15·16·17·19·20, 각 소스 딥분석) → 참고/선택 → **DESIGN/TRACKER v0.3 통합** → Phase 1 CODEX.
