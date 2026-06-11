# 루나 투자회의 + 펀더멘털 리서치 — 설계 (SSOT)

> 버전 v0.8 (2026-06-11) · 작성: 메티 · 상태: 실험판 + 성장 통합 + **재설계 정합(§21)·사용 시뮬레이션(§22)·3시장 회의 체계(§23)·v1.2~1.3 정합(§24)** · 보강=LUNA_BOOST_DESIGN.md · 적용 검토=LUNA_BOOST_APPLY_REVIEW.md · 성장=LUNA_GROWTH_REINFORCEMENT.md
> 전제: 단일 사용자 · 개발 중 · paper 단계. **실험 우선 · 성능 비중(완전 교체 비용 무시) · 가드 최소("게이트를 치우고 계측을 깐다")**.
> 상위 자산 재사용: `bots/investment`(루나팀). 회의실=신규 오케스트레이터만, 분석/실행/리스크/메모리/졸업은 기존 부품 재사용.

## 1. 목적 · 범위 · 비목표
- 목적: 국내주식 **일일/주간 투자회의(웹)** + **펀더멘털 리서치 파이프라인**. 보조(human-in-the-loop) → 점진 자율.
- 목표: 국내주식 검증 시 → 해외주식·암호화폐 확장(markets/{overseas,crypto}·KIS 해외·루나 crypto LIVE 활용, 자율 졸업 프레임 연동).
- 비목표: 즉시 LIVE 자동매매 · 자동 부작용(실거래/이체/공시) · 외부 투자추천.

## 2. 운영 정책 · 불변 원칙
- 국내주식 우선 · 보조 · 리서치/회의 LLM=Claude Code/OpenAI(클라우드), LOCAL LLM=백테스트 전용 · 출력=RAG(pgvector)+리포트 파일.
- 마스터 부재 시 루나 단독=모의주문(→다이얼로 LIVE 확장). 고정값→동적/자율 지향.
- **불변(무중단)**: PROTECTED launchd `ai.{ska,luna,investment,claude,elixir,hub}.*` · crypto LIVE · 스카 실매출 · 3역할 절차.

## 3. 가드 철학 — "게이트를 치우고 계측을 깐다" [실험판 핵심]
세 종류를 구분해 **가드만 제거**:
- **가드(절차 마찰)** = 제거 → G1~G10·승급 게이트·액션 승인은 **차단이 아니라 표시·점수·advisory**로 강등.
- **계측(데이터 진실성)** = 유지 → 측정이 거짓이면 실험 자체가 무의미.
- **경계(되돌릴 수 없는 손실)** = 유지 → 실거래·자금이동·운영 중단 · **자본보존 halt**(B-13).
**유지하는 3개(마찰≈0)**:
1. **실거래·자금이동 = 명시적 마스터 행동**(모의/섀도는 무제한 자율).
2. **point-in-time / 누수 차단**(계측 진실성 — 룩어헤드·정보누수 금지).
3. **crypto LIVE · 스카 무중단**.
→ 그 외 모든 게이트는 실험 속도를 위해 advisory(통과 가능, 점수만 기록).

## 4. 시스템 아키텍처
- 컴포넌트: 회의실 오케스트레이터(신규) ↔ 기존 노드/팀(어댑터 경유) ↔ Hub(:7788) ↔ 대시보드(:7787) ↔ PostgreSQL17/pgvector.
- 데이터 흐름: 트리거 → 세션 생성(DB) → 안건 FSM 진행(Lane 구동) → 발언/토론/결정 → 회의록·모의주문 원장(DB) + 리포트 파일 → RAG 색인.
- 결합도: 노드 간 결합 0 · RAG 간접 연동 · 회의실은 기존 부품의 **오케스트레이션 계층**일 뿐.

## 5. 레포 배치 · 재사용 매핑
- 회의실=`bots/investment/services/meeting-room/`:
  - `server/orchestrator/{meeting-session.ts, speaker-select.ts, action-guards.ts}`
  - `server/adapters/{nodes-adapter, fundamentals-adapter, order-adapter, rag-adapter}`
  - `server/{minutes, ws, index.ts}` · `web/`(React) · `config/meeting.config.ts`
- 신규 최소: 오케스트레이터·어댑터·웹·`isKrTradingDay` 헬퍼·migration·폴백 plist 2개·슬래시 액션.
- 재사용: `nodes/l01~l34`(l11/l12 불·베어 토론 보유) · `team/{aria,sophia,nemesis,luna,hanul,chronos…}` · `shared/{kis-client,autonomy-phase,korea-data-promotion-gate,dynamic-position-sizer,execution-risk-and-capital,kis-market-hours-guard…}` · reflexion-engine · agent-memory-4layer · `python/{finrl-x,quant,rl}` · shadow-mode-runner.

## 6. 회의 운영 모델
- **안건 8단계 FSM**(인간 뷰) → 내부적으로 6 Lane(§10)을 구동. FSM은 충돌이 아니라 Lane의 진행을 사람이 보는 창.
- 의장 = 마스터(부재 시 루나). 발언자 선택 = manual/auto.
- 토론 = 2R 기본 / cap 3 + 이종 모델 + 조기 합의 탐지(§15).
- 케이던스 = **3시장 장전/장후 + 주간 전략**(§7 → §23 개정).

## 7. 회의 시작 트리거 — 웹 버튼 + 루나 폴백
- **트리거 = 웹 "회의 시작" 버튼**(마스터 주도, launchd 자동발사 아님). 휴장일=버튼 비활성+안내 팝업. 버튼=수시(ad-hoc) 시작도 겸함.
- 버튼 → Hub `POST :7788/luna/meeting/start` (+ CLI `run-meeting --mode=adhoc`).
- **일일**: 05:00–06:00 KST 창(국내 거래일만). 창 내 미클릭 시 → **루나 자동 폴백**.
  - 구현: 폴백 launchd `ai.luna.meeting-room-daily-fallback.plist`(hour=6, 거래일 게이트) → 오늘 일일 세션 없으면 루나 시작. 버튼 클릭=세션 생성 → 06:00 체크 skip(폴백 취소).
- **주간**: 일요일 06:00–07:00 KST 창. 폴백 `ai.luna.meeting-room-weekly-fallback.plist`(weekday=0, hour=7) → 이번 ISO주 주간 세션 없으면 루나 시작.
- launchd 역할 = **폴백 워처**(비-PROTECTED). 이번 주=버튼 수동, 다음 주=폴백 정례화.
- **일일=전술**(밤사이 스캔→당일 포지셔닝, morning-note+모의주문, ~30–45분, 1p). **주간=전략**(성과 리뷰·thesis·CVRF 신념 갱신·전략 리더보드·승급·ic-memo, ~60–90분).

## 8. 회의실 UI (2화면 · :7787 연동)
- 스택=React(네이티브 TS 재사용, Magentic-UI는 참고만/fork X). 전용 웹.
- 화면① 일일 회의실: 안건 진행·참석 에이전트·발언/토론·결정·회의록.
- 화면② 에이전트 직접 질의: @멘션으로 개별 에이전트 질의(보조). 기본 창구는 루나.
- 팀 제이 대시보드 :7787 연동(상호 링크 + 동일 PostgreSQL).

## 9. 펀더멘털 리서치 파이프라인
- 데이터: OpenDART(Hub 키)·KIS·korean-factor / 갭 후보: KRX 공식 시세·지수, 수급·외국인5%·행동주의 공시, 네이버 금융 컨텍스트.
- 포맷: **morning-note**(밤사이 필링·트랜스크립트·뉴스→당일 브리프) · **ic-memo**(불/베어 + 과집중 체크 + "what makes this wrong"). financial-services SKILL.md 컨벤션 차용.
- 슬래시 액션(차용): `/morning-note`·`/screen <섹터>`·`/comps`·`/earnings`·`/thesis`·`/catalysts`.

## 10. 6 Lane 매핑 (LUNA_REDESIGN_PHASE_1_TO_5 §4)
- **Research**: Argos·Aria·Hermes·Sophia·Oracle·Zeus(불)·Athena(베어).
- **Decision**: Luna(제약형 후보 선택, 자유 BUY/SELL 아님).
- **Policy**: Nemesis(예산·포지션·재진입·노출·타임존).
- **Execution**: Hanul·Hephaestos.
- **Validation**: Chronos + 엔진 — **가장 약한 레인 → 코어로 승격(회의실의 핵심 기여)**.
- **Review**: 사후 리뷰·학습 피드백.
- 안건 8단계 FSM = 이 레인들을 사람이 보는 뷰. 노드 결합 0 · RAG 간접.

## 11. 자율 · 다이얼 (C1)
- **마스터 수동 다이얼 + earned 텔레메트리(advisory)**. 별도 L0~L3 병렬 체계 신설 안 함.
- 기존 `LUNA_AUTONOMY_PHASES`(L4_PRE/POST_AUTOTUNE·L5) + `resolveLunaAutonomyPhase`/`buildLunaAutonomyPhaseContext`(time-cutover 모델) **정렬**.
- 경계 = 실거래(L5)/자금이동에만 — 그 외 자율도는 텔레메트리로 권고만(차단 X).

## 12. 백테스트 (C2)
- **walk-forward → CPCV 교체**(purge+embargo · multi-path).
- **DSR / PBO / MinTRL = 리더보드/계측**(비차단). 백테스트는 필터지 증명이 아님 → 승급은 post-cutoff forward 실적으로.
- 기존 백테스트 마이그레이션(DSR/PBO/OOS/walk-forward/meta-label) 재사용, **CPCV만 신규 갭**.

## 13. 기억 · 학습 (C3)
- **flat RAG 회수 → temporal-validity 교체**: 사실에 유효기간(validity window) 부여 → 시점정합(누수 차단) 강제.
- **CVRF 신념층 추가**: 에피소드 자기비판 → 투자 신념(자연어) → **필요한 노드에만 전파**. 기존 4-layer 메모리 보강.
- napkin 실수노트 · async write.

## 14. 의사결정 (C4) — 듀얼 모드
- **제약형(allowed universe, trust 트랙)**: 루나가 허용 유니버스 내 후보 선택. 신뢰 누적 트랙.
- **자유 제안(shadow 트랙)**: 자유 제안은 섀도로만 기록(실거래 영향 0).
- 루나 = 제약형 후보 선택자(자유 BUY/SELL 아님). 두 트랙 병행 → 자유 제안의 적중을 섀도로 측정.

## 15. 토론 (C5)
- **적응 종료**: 수렴/반복 탐지(2R 기본 · max 3). 합의/교착 시 조기 종료.
- **이종 모델 2~3종**: 불=Claude / 베어=OpenAI(§아래 결정③). 서로 다른 모델로 편향 분산.
- 심판(Luna)이 가장 강한 불/베어 논거를 통합.

## 16. 소스 검증 실측 계약 [코덱스 착수 전 필독]
- **노드**: 형태 `{id,type,label,run}` · ID 대문자 · 호출 `await node.run({ sessionId, market, symbol })`. 레지스트리 `nodes/index.ts`: `getInvestmentNode(ID)`/`INVESTMENT_NODE_MAP`/`INVESTMENT_NODES`. 등록: L01·L02·L03(sentinel)·L04(market-flow)·L05·L06·L10·L11(bull)·L11b(quant)·L12(bear)·L12b(risk)·L13(final-decision)·L14(portfolio)·L21(llm-risk)·L30·L31(order-execute)·L32·L33(rag-store)·L34. **L20 없음**(l03-news-analysis/l04-sentiment 파일 존재하나 미등록).
- **의사결정**(`team/luna.ts`): `getSymbolDecision`·`getPortfolioDecision`·`getExitDecisions`·`orchestrate`·`getDebateLimit`·`shouldDebateForSymbol`·`fuseSignals`·`buildAnalystWeights`. 기본 exchange='binance' → 국내는 market 인자 필요.
- **이종 모델**: `resolveAgentLLMRoute`(shared/agent-llm-routing.ts) + agent yaml `llm_routing`. ⚠️ 현재 zeus.yaml·athena.yaml **둘 다 `openai-oauth/gpt-5.4-mini`**(결정③로 zeus→claude). (`dual-model-report`=N일 리포트, 토론 라우팅 아님.)
- **사이징/리스크**: `computeDynamicPositionSizing`(shared/dynamic-position-sizer.ts) + `execution-risk-and-capital.ts` facade 재노출: `buildExecutionRiskApprovalGuard`(risk-approval-execution-guard.ts) + capital-manager `preTradeCheck`·`calculatePositionSize`·`checkCircuitBreaker`·`getOpenPositions`·`getDailyPnL`·`getAvailableBalance`·`getCapitalConfig`.
- **졸업**: `buildKoreaDataPromotionGate`+`DEFAULT_KOREA_DATA_PROMOTION_THRESHOLDS`+`normalizeKoreaDataPromotionThresholds`(shared/korea-data-promotion-gate.ts) + chronos·shadow-mode-runner·run-graduation-analysis.
- **거래일**: `isKisHoliday`(DB `ska.environment_factors`, async, secrets.ts:498)/`isKisMarketOpen`(secrets.ts:527). `evaluateKisMarketHours({market,now})`→reasonCode `holiday|kis_market_open|kis_market_closed`(kis-market-hours-guard.ts; 국내 KST 09:00–15:30). ⚠️ `KR_HOLIDAYS_2026`/`isKrHoliday` 미export → `isKrTradingDay` 헬퍼는 primary `isKisHoliday()`, fallback `evaluateKisMarketHours().reasonCode==='holiday'`.
- **kis-client.ts** 존재(+ kis-symbol-policy·kis-top-volume-universe·kis-ws-client.js).
- **Hub**: 라우트 `bots/hub/lib/routes/*` → `bots/hub/src/route-registry.ts` 등록, `bots/hub/src/server.ts` listen, **`bots/hub/src/hub-proxy.ts` 존재**. 포트 7788. 대시보드 7787. migration `YYYYMMDDHHMMSS_luna_meeting_room.sql`. DB=PostgreSQL17+pgvector.

## 17. 3대 구현 결정 [마스터 확정]
1. **paper 주문 = 별도 paper 원장(DB)**. LIVE(마스터 다이얼) 시에만 `l31`+kis-client. (l31엔 paper 플래그 없음.)
2. **[v0.8 보정] 회의실 = 자체 HTTP 서버(node http, port 7791, 127.0.0.1 바인딩)** — 실측: `hub-proxy.ts`=Blue-Green 라우터(7780, 범용 프록시 아님)·:7787=Elixir(beam.smp) 서빙 → Hub 경유 폐기, 독립 서버 확정(원안의 loopback 방향 유지). 1차 통신=REST+3초 폴링(WS=후속). 웹=React UMD+htm **빌드리스**(레포에 빌드 체인 부재 실측 — vite 도입 회피, 기존 dashboard-html 정적 패턴과 정합). :7787 상호 링크 유지.
3. **이종 모델 = 불(zeus)=Claude / 베어(athena)=OpenAI(현행)**. zeus.yaml `llm_routing.primary`를 claude로 변경.

## 18. 리스크 · 미해결
- 미해결: CPCV 신규 구현 · 폴백 plist 시간대(KST) 정확성 · paper 원장 스키마 · hub-proxy 경로.
- 검증 후 시장 확장(해외·crypto) 게이트.

## 19. v0.3 보강 통합 (영상 20개 → 코드 대조 → 적용)
> 입력: `LUNA_VIDEO_REINFORCEMENT`(B-01~20) · `LUNA_BOOST_DESIGN`(설계) · `LUNA_BOOST_APPLY_REVIEW`(코드 대조). **핵심: 보강 다수가 기존 자산 활성화/확장, 진짜 신규는 소수.**

### 19.1 가드 — advisory vs 경계 (확정)
| 항목 | 분류 | 근거 |
|---|---|---|
| 일/주/연속손실 회로 | advisory(완화 가능) | 기존 checkCircuitBreaker+softening |
| **peak-drawdown halt**(B-13) | **경계**(하드·비완화) | HWM −10%→kill-switch, 마스터 수동 재개 |
| correlation(B-13) | advisory(감산) | Nemesis 노출 |
| 검증 게이트(B-18 DSR/PBO/RST) | advisory(승급 차단) | env 활성화 |
| point-in-time(B-12 forward) | 경계(계측) | 누수 차단 |
| 자율 다이얼(C1) | advisory | 마스터 다이얼 |

### 19.2 활성화(env/flag) — shadow→active 경로 (마스터 게이팅)
- **검증(B-18)**: `LUNA_CANDIDATE_BACKTEST_ENTRY_GATE_MODE`(shadow→enforce)·`LUNA_DSR_GATE_ENABLED`·`LUNA_DSR_MIN`(0.90)·신규 `LUNA_PBO_GATE_ENABLED`.
- **레짐(B-10/12)**: 신규 `LUNA_HMM_REGIME_ENABLED`·기존 `LUNA_ADAPTIVE_WEIGHT_ENABLED`.
- **수급(B-19)**: OpenDART 키(secrets-doctor)·`LUNA_DISCOVERY_DART`.
- **트레일링(B-20)**: `shouldApplyDynamicTrail()`.

### 19.3 신규(net-new) — 소수
HWM 영속 · correlation · RST · PBO 게이트 배선 · 경험적 전이행렬 · HMM 정밀화(상태수/forward/안정성) · 캘리브레이션(Brier) · conviction 입력(P(bull)−P(bear)) · 단일변수 실험원장 · ADR 메타로그 · 래더 엔트리 · 외국인/기관 수급 어댑터 · 글로사리/grill skill · meeting-room UI.

### 19.4 확장 — 기존 자산
회로차단기(+peak/correlation) · sizer(+conviction) · scorer(+목표대비) · skill-extractor(+reflexion 갱신) · 예산가드(+회의/사이클) · coordination(+UI).

### 19.5 기술 매핑 (Skills·Hooks·A2A·MCP·Codex)
- **Hooks**: B-13 회로차단=PreToolUse veto · B-05/18=PostToolUse 스코어/로그 · advisory=prompt 핸들러.
- **Skills**: B-02/03/17=`skills/luna/*.skill.md`(agentskills.io 포터블 Claude↔Codex).
- **A2A**: B-09=Task 라이프사이클(input-required=마스터 승인) · 6레인=Agent Card.
- **Codex**: Traces=회의록·ADR(B-01)·관측성.

### 19.6 기존 자산 인벤토리 (재사용 확정 — 코드 대조 결과)
- **리스크**: `capital-manager`(checkCircuitBreaker)·kill-switch(`luna-kill-switch-consistency`)·`risk-approval-chain`.
- **레짐**: `hmm-regime-detector`(shadow)·`regime-weight-learner`·`regime-strategy-policy`·A2A `market-regime-analysis`.
- **검증**: `candidate-backtest-gate`(DSR/PBO/walk-forward)·`quant/monte-carlo`·`quant/stress-test`·`korea-data-promotion-gate`.
- **자기개선**: 3층 Reflexion(Elixir l1/l2/l3)·`reflexion-engine`·`luna-self-rewarding-engine`·`posttrade-skill-extractor`·darwin apply.
- **수급**: `opendart_client.py`·`dart-disclosure-collector`·A2A `disclosure-event-driven`.
- **출구/사이징**: `dynamic-trail-engine`·`dynamic-position-sizer`·`luna-exit-policy`·protective/partial-exit.
- **스킬**: `skills/luna/*.skill.md` 다수 · A2A skills 18개.
→ 워크스트림 매핑: TRACKER v0.3 WS-I~ 참조.

## 20. v0.4 성장 통합 — 알파팩터 → 회의실 (순서·범위)
> 입력: `LUNA_GROWTH_REINFORCEMENT`(LG-01~07) · `SELF_IMPROVEMENT_RSI_*`(SI-01~08). 방침(마스터): **전문인력 아님 → 성장 속도 무리하지 않음.** 순서 = **알파팩터(LG-01) → 회의실 Phase 1.**

### 20.1 SI 안전레일 — 별도 구축 제외 (기존 가드로 충분)
- 자기개선 안전 인프라는 **이미 존재**(코드 대조 결과): kill-switch(`luna-kill-switch-consistency`) · **24h 자동롤백+kill-switch**(darwin `rollback_scheduler.ex`) · 검증게이트(`candidate-backtest-gate` DSR/PBO) · shadow→active · 실거래 마스터 승인.
- → **SI 트랙을 신규 별도 구축하지 않음.** 기존 가드는 **불변 유지**(§3 경계). 성장 산출물은 이 기존 게이트를 경유.
- SI-01~08 = 점진 정렬 과제로 **보류**(가속 안 함, SELF_IMPROVEMENT_RSI_APPLY_REVIEW 참조).

### 20.2 알파팩터 생성 (LG-01) — 회의실 선행 [신규·핵심]
- 목적: 루나 **로직 성장**의 빈 곳 — 새 알파팩터(예측 신호) **발견**. 기존=변이(finrl-x)·가중치(regime-weight-learner)·프롬프트(ESPL) 진화 / 신규=**팩터 발견**.
- 파이프라인: 후보 팩터 생성 → **IC/RankIC 평가** → `candidate-backtest-gate`(DSR/PBO/OOS) 검증 → shadow 기록 → **마스터 게이팅** → 통과분 `signal`/`skill` 승격.
- 팩터 = **실행가능·감사가능 코드**(FactorEngine식). 생성기 = LLM(Chain-of-Alpha 이중체인) 또는 RL(AlphaGen식) — **local 우선**, 소규모 예산.
- 안전 = 기존 게이트 경유(20.1) — **검증 없는 팩터 승격 금지**. 무중단(shadow→승격).
- 회의실 연결: 승격된 팩터 → Research 레인(§10) 입력 → 회의 후보.

### 20.3 순서·산출
1. **알파팩터 생성**(WS-R) — CODEX 1번. 검증게이트 위에 세움.
2. **회의실 Phase 1**(WS-A~E·G) — CODEX 2번. 알파팩터를 후보로 활용.
3. (보류) SI 정렬 · v0.3 보강 WS-I~Q — 성장·검증 누적 후 선택.

## 21. 재설계 정합 개정 [v0.5 — LUNA_OPTIMAL_REDESIGN v0.2 기준 + 외부 서칭]
> 외부 근거: Anthropic 공식 에이전트 패턴(claude-cookbooks/patterns/agents — Chaining·Routing·병렬화·Orchestrator-Workers·Evaluator-Optimizer) · TradingAgents(TauricResearch — analysts/researchers/**managers 판정자 분리**/risk_mgmt 3관점/trader) · E-3(계산된 지표 주입).

1. **Decision 레인 재정의** (§10·§14 개정 — 가장 큰 변화): 기존 "루나=제약형 후보 선택자" → **후보 산출=G0~G7 결정론 스택**. 회의 Decision 레인 = ①스택 산출물 검토(G6 리뷰 결과 포함) ②**C15 승격 제안 결정** ③파라미터·리밋 조정 결정. §14 듀얼 모드 재해석: 제약형 트랙=결정론 스택(주 트랙) / **자유 제안 shadow 트랙=유지**(LLM 직감 성과 측정 — C15 등록 실험, "LLM이 더 잘하는 영역" 발견 장치).
2. **회의 입력 표준화**: morning-note 헤더 = `G0 게이트 점수(시장별) · C2 레짐 확률 · G2 활성 전략군 · C15 결정 대기 N건 · 간밤 C16 포지션 액션 요약`. 발언자 프롬프트=계산된 지표 주입(raw 덤프 금지, E-3). 안건 8단계 FSM=Anthropic Prompt Chaining 정합(유지).
3. **회의 출력 = 영향 변수 4종 주입**(재설계 0-b): 결정(머신리더블 ADR) → 파라미터 스토어·워치리스트·거래 리밋·레짐 오버라이드. 회의 자체가 루프의 한 단계(결정→이행→결과 추적→재상정).
4. **트리거 3종화** (§7 개정): 버튼(ad-hoc) + 정기 폴백(일/주) + **이벤트 수시회의**(C11: G0 halt·레짐 전환 경보·회로차단·대형 공시·손실 임계). 수시회의=경량 포맷(안건 1개·참석 최소·~10분).
5. **토론 구조 보강** (TradingAgents 차용): (a) 불/베어 이종 모델 유지(zeus=Claude/athena=OpenAI) (b) **리스크 안건=3관점 토론**(공격/보수/중립 — Nemesis 페르소나 3분기, C13 페르소나 활용) (c) **판정자 분리**: 토론 요약(Research Manager 역)→G6 리뷰 입력·회의 기록 — LLM 판정이 곧 매매 결정이 되지 않게.
6. **Lane 병렬화** (Anthropic async multi-agent 패턴): Research 레인 에이전트 병렬 호출 → 일일 회의 30–45분 → **15–20분 목표**.
7. **Validation 레인 = C7 직결** (§12 개정): CPCV + **permutation 2종(IS·WF)** + point-in-time 유니버스 + OOS 보존 — 회의 리더보드에 p값 표시.
8. **알파팩터(§20) = C12 예측엔진 합류** 명시(TRACKER 매핑 — WS-R 합류, 회의 Research 레인 입력은 유지).

## 22. 사용 시뮬레이션 보강 [v0.5 — 마스터 1인 사용 워크스루 결과]
> 시나리오: 평일 아침 합류 / 3일 부재 / 새벽 crypto 경보 / 과거 결정 추적 / 장중 질의. 도출 갭 9건 → 보강.
- **U1 따라잡기 브리프**: 마스터가 진행 중/종료 회의에 합류 시 첫 화면 = **3줄 캐치업**(지금까지 결정·대기 중 결정·내 액션 필요 항목). 폴백 시작 회의는 자율 진행하되 마스터 합류 즉시 의장 전환.
- **U2 텔레그램 원클릭 결정**: C15 제안·회의 결정은 **텔레그램 인라인 버튼**(승인/보류/거부)으로도 처리 — 웹 강제 금지(모바일 우선). 웹=상세, 텔레그램=결정.
- **U3 부재 정책(기한부 결정)**: 결정 대기 항목에 **기한+만료 디폴트**(보수적: 승격=보류 유지·halt=유지·리밋=현행). 우선순위 큐: 경계급(자본보존)만 즉시 푸시, 일반은 일일 1회 묶음, 누적분은 주간 일괄.
- **U4 수시회의 자율 모드**: 마스터 부재 시 수시회의는 자율 진행 → 결정은 **advisory 적용+익일 아침 보고**. 단 경계급(자본보존 halt·회로차단)은 즉시 알림+보수적 디폴트 즉시 적용.
- **U5 알림 위생**: 수시회의 쿨다운(동일 트리거 4h)·일일 상한(기본 3회)·등급(경계=즉시 / 정보=다음 회의 묶음). 모든 임계=파라미터 스토어.
- **U6 결정 추적 UI**: ADR 검색(언제·왜·결과) + 결정→성과 추적 뷰(0-b 회의 루프) — "그때 왜 그랬지" 1분 내 답.
- **U7 질의 자동 컨텍스트**: 화면② @멘션 질의에 시스템 상태(레짐·게이트·해당 종목 포지션·전략군 신호) 자동 첨부.
- **U8 한국어 고정**(기존 전제 재확인) · **U9 5분 포맷**: 일일 회의 기본 뷰=「5분 브리프+결정 N건」, 토론 전문=접기/링크. 마스터 가용 시간 5–10분/일 현실 반영.

## 23. 3시장 회의 체계 개정 [v0.6 — 장전+장후 평가 + 3시장 확대, §7 대체]
> 마스터 지시: ①장전 회의에 **장 종료 후 평가 회의** 추가(장전↔장후 비교·피드백) ②3시장(국내·해외·crypto) 확대에 맞춘 시간·주제·방법 재검토.
> 핵심 통찰: 05:00 KST = **미국장 마감 직후 + 국내 개장 전** → 아침 회의는 "미국 장후 평가+국내 장전 계획+crypto 점검" 3-in-1 자리. crypto는 장 개념 없음 → 일일 사이클 흡수(자동 루프 C16/C8이 상시 담당).

### 23.1 회의 체계 표 (개정 — 일 2~3회 + 주간 + 수시)
| 회의 | 시간(KST) | 범위 | 성격 | 토론 | 마스터 |
|---|---|---|---|---|---|
| **아침 통합(장전)** | 05:00–06:00 (폴백 06:00) | 미국 **장후 평가** + 국내 **장전 계획** + crypto 24h 점검 | 평가+계획 | 1R(필요 시) | 참석 권장(U9 5분 브리프) |
| **국내 장후 평가** [신설] | 16:00 (15:30 마감 후, 국내 거래일) | 국내 plan vs actual | **debrief** | **0R**(사실 대조) | 옵션(자율 진행+보고 푸시) |
| **미국 장전 점검** [신설·경량] | 22:00 (개장 전, 미 거래일) | 미국 계획 확정·아침 plan 보정 | 계획 | 0R | 옵션(자율, U4) |
| 주간 전략 | 일 06:00–07:00 | 3시장 통합 | 전략 | 2R | 참석 |
| 수시(이벤트) | 트리거 시 | 해당 시장 | 대응 | 1R | U4/U5 |

### 23.2 장전↔장후 비교·피드백 메커니즘 (0-b 회의 루프의 일일 구현)
- **plan-note**(장전 산출, morning-note 확장·머신리더블): 시장별 `레짐 전제 · 활성 전략군 · 워치리스트 후보 · 예상 액션 · 리밋/사이징 계획`.
- **plan vs actual 대조표**(장후 입력, 자동 생성): 계획 항목별 결과 — `진입 여부 · 미진입 사유(게이트 어디서 차단) · 계획 외 거래 · 당일 실현 E/R:R · C16 액션 이력`.
- **debrief-note**(장후 산출): 편차(deviation) 분석(계획≠실행의 왜) → ①C8 피드백 루프 입력 ②익일 plan 보정 ③**반복 편차(3회+)는 주간 회의 안건 자동 승격**.
- 효과: "계획 따로 실행 따로" 차단 — 레짐 전제가 틀렸는지, 게이트가 과도한지, 전략군 룰이 미작동인지를 **매일** 식별.

### 23.3 시장별 휴장 처리 (기존 "국내 거래일만" 폐기)
- 회의는 **세그먼트 단위 스킵**: 국내 휴장=국내 세그먼트만 스킵(미국·crypto 진행) · 미 휴장=미국 세그먼트 스킵 · crypto=무휴. 아침 통합 회의는 365일 성립(최소 crypto 세그먼트).
- 거래일 판정: 국내=`isKrTradingDay`(기존) · 미국=NYSE 캘린더 헬퍼 신설 `isUsTradingDay`(서머타임 자동 반영).

### 23.4 운영·구현
- 폴백 plist 2개 추가(비-PROTECTED): `ai.luna.meeting-room-domestic-debrief`(16:00 국내 거래일) · `ai.luna.meeting-room-us-premarket`(22:00 미 거래일). 장후·미장전은 **자율 모드가 기본**(폴백=정상 경로, 버튼=옵션).
- 회의 방법 차등: debrief=토론 없음(대조표+편차+ADR, ~10분 자율) → 비용·시간 절감. 토론은 장전 1R·주간 2R만.
- 재설계 §6 타임라인 갱신 연동: `04:50 게이트 산출 → 05:00 아침 통합 → 09:00 국내 → 16:00 국내 debrief → 22:00 미 점검 → 23:30 미국장 → 상시 crypto`.
- TRACKER 반영: WS-G에 G6(debrief plist+plan/actual 대조 생성기)·G7(us-premarket plist+isUsTradingDay) 추가.

### 23.5 루나 주관 자율 회의 + grill 프로토콜 [v0.6 — 마스터 지시]
> 원칙: 마스터는 최대한 참여하되, **불참 시 루나=의장으로 자율 진행**. 단 자율 회의가 거수기·자기합리화로 전락하지 않도록 **grill-me / grill-with-docs**(B-03)를 의무 적용 — 마스터의 "비판적 심문" 역할을 스킬이 대체.

**1) grill-me (자기심문 — 결정 직전 FSM 단계 의무 삽입)**:
- 모든 결정 후보에 루나가 자기심문 라운드 수행: ①이 결정의 **가장 강한 반대 논거**는? ②어떤 데이터가 나오면 이 결정이 **무효**인가? ③**마스터라면 무엇을 물을까**? ④지금 결정하지 않으면 잃는 것은?(긴급성 검증) ⑤과거 같은 유형 결정의 결과는?
- 심문에 **만족스러운 답을 못 내면 결정 보류** → 마스터 안건 큐로 이관(U3 기한부).

**2) grill-with-docs (근거 강제 — 발언·심문의 데이터 규율)**:
- 심문·발언 시 근거 문서를 RAG로 회수해 **대조 의무**: plan-note·debrief 대조표·C15 제안서(표본·p값)·과거 ADR(동유형 결정→결과)·전략군 룰 명세·레짐 스냅샷.
- **근거 없는 주장 발언 금지** — 모든 주장에 데이터 참조 태그(문서/수치) 요구, 참조 불가 주장은 회의록에 '추측'으로 명시 분류.

**3) 자율 결정 3등급** (U3/U4와 통합):
- (a) **룰 내**(파라미터 스토어 범위·advisory) = grill 통과 시 자율 확정 + 회의록 기록.
- (b) **경계 근접** = grill 통과 시 잠정 적용 + 마스터 사후 보고(익일 아침 캐치업 U1에 포함).
- (c) **경계급**(자본보존·실거래·구조 변경) = 자율 확정 금지 — 보수적 디폴트 + 즉시 알림(기존 U3/U4).

**4) 감사 가능성**: grill Q&A 전문을 회의록에 기록 — 마스터가 사후에 "루나가 제대로 따졌는가"를 검토 가능(0-b 회의 루프의 품질 계측). grill 통과율·보류율·사후 결정 적중을 C15 지표로 추적(자율 회의 품질 자체가 승격 대상 — 적중 누적 시 (b)등급 범위 확대 제안).
**5) 구현**: `skills/luna/grill-me.skill.md`·`grill-with-docs.skill.md`(WS-M — **Phase 1 승격**, 자율 회의 전제 조건) + FSM 결정 단계 훅. 모든 회의 유형(아침·debrief·미 장전 22:00·수시) 공통 적용 — debrief(0R)에도 편차 분석 결론에 grill 1회.

## 24. 재설계 v1.2~v1.3 정합 + 시뮬레이션 2차 [v0.7]
> 입력: 설계 v1.1(서킷·WB·시퀀스)·v1.2(제약 분리·워치독)·v1.3(T8~T10·break-glass). 회의실 사용 워크스루 2차 결과.

1. **수시회의 트리거 확장**(§21-4 갱신): 기존 5종(G0 halt·레짐 전환·회로차단·대형 공시·손실 임계) + **⑥손실빈도 서킷 발동(C4)** + **⑦expected-fire 경보(silent miss)**. ⑥의 안건 표준=재설계 T10(원인 3분류→분류별 후속, grill 적용). ⑦은 단건=알림만, 반복(일 2+)=수시회의.
2. **경보 책임 경계**: 클로드팀=인프라 에러(프로세스 다운·예외) / **루나 워치독=전략 silent miss**(조건 충족인데 미실행 — 프로세스는 정상인데 발화 누락). 중복 알림 방지: 워치독 경보에 인프라 원인 태그 시 클로드팀 채널로 라우팅.
3. **회의 ADR → 파라미터 스토어 경로 구체화**(§21-3 갱신): tier=approve 변경은 **회의 ADR ID가 evidence 필드** — 회의록과 파라미터 이력이 상호 참조(감사 추적 완결). tier=auto는 검증 ID(백테스트·permutation), 회의 불요.
4. **debrief 대조표에 미발화 행 추가**(§23.2 갱신): plan vs actual에 `expected-fire 미발화 N건(원인)` 행 — T9 레코드 자동 연동.
5. **break-glass 회의 규칙**: 마스터가 break-glass 사용 시(서킷 해제·제약 오버라이드) → **자동 사후 안건 등재**(다음 회의에서 사용 사유·결과 검토, ADR화) — 오버라이드도 루프 안에(0-b).
6. [시뮬 2차 — 신규 갭] **회의 산출물의 워치독 자기적용**: 회의가 결정한 액션(파라미터 변경·제안 처리)도 expected-fire 대상 — "회의에서 결정했는데 이행 안 됨"을 워치독이 감지(결정 ADR에 기한 필드, 미이행 시 재상정 자동화 — 0-b 회의 루프의 집행 보증).
