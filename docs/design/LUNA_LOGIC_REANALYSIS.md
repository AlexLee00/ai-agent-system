# 루나 전체 로직 재분석 + 최적 재설계 (작업 문서)

> 작성: 메티 · 2026-06-08 · 상태: **Phase 1 진행 중**(소스 재분석) · 다단계·다세션
> 마스터 지시: 전체 로직 재검토·**최적화**(3시장·전 과정·범위 확장·**비용 무시·최적 성능**) + YouTube 12개 분석 + 수정된 소스 반영. 회의실도 필요 시 수정.

## 0. 작업 계획 (4 Phase)
- **Phase 1**: 현재 소스 딥 재분석 — *진행 중*
- **Phase 2**: YouTube 12개 분석 → 기법 추출
- **Phase 3**: 로직 비교·**최적 재설계**(현 로직 vs 설계+영상)
- **Phase 4**: DESIGN/TRACKER 갱신(회의실 포함)

## 1. 현재 아키텍처 (실측)
- **공유 파이프라인**(시장 파라미터화): `markets/{crypto,domestic,overseas}.ts` → `buildDiscoveryUniverse` → `runMarketCollectPipeline`(L01~L06 분석) → `runDecisionExecutionPipeline`(L10~L14 결정·L21 리스크·L30~L34 실행/저장).
- `team/luna.ts`(**1388줄**) = 오케스트레이션 셸. **실제 로직은 `shared/luna-*-policy.ts`로 분산**(decision/orchestration/fallback/prompt/portfolio-decision-guards…).
- 노드 19개(L01~L34). `nodes/index.ts` **@ts-nocheck**.
- 시장 차이 = 유니버스 필터·사이클 타이밍·거래일(`filterDomesticTradableSymbols`·`filterOverseasTradableSymbols`·`resolveDomesticCycleLastRunAt`).

## 2. 의사결정 척추 (현 로직 흐름)
- **getSymbolDecision**: 신호 융합 → **약신호 게이트**(HOLD) → **fast-path**(룰) → LLM(shadow 래핑) → reviewHint 보정 → strategy-route bias.
  - fast-path = 룰 기반 LLM 우회. 임계 **0.68/0.62**, 금액 **180/120** 하드코딩.
  - 약신호 게이트 = 시장별 하드코딩(binance 0.22/0.03, kis 0.32/0.08).
  - KIS working state = "손실 패턴·decision_rule" **자연어 휴리스틱 주입**(장시작/마감·1일초과·-2% 등, 하드코딩).
- **orchestrate**: 자본 게이트(ACTIVE_DISCOVERY 아니면 EXIT만) → 심볼별 [분석조회 → 토론 2R(제우스/아테나) → MTF/sentiment/wyckoff/vsa → `fuseDiscoveryScore` → getSymbolDecision → enrich(TP/SL/setup)] → 포트폴리오 결정 → 대표패스 → throttle → predictive validation.
- **다수 enrichment가 `intelligentFlags.phases.*` 뒤에 조건부**(discovery/news/sentiment/mtf/wyckoff/vsa/scoreFusion/decisionMutation).

## 3. 초기 관찰 — 잠재 문제 (재설계 후보 가설)
- **임의 가중 블렌딩(매직넘버)**: `blendedConf = conf×0.7 + discovery×0.3` · `predictive = discovery×0.55 + mtfAlign×0.45`. 근거 불명·비검증.
- **하드코딩 임계·금액 산재**: fast-path·약신호 게이트·confidence cap(0.74/0.80 등).
- **KIS 결정룰 = 자연어 휴리스틱**(비체계적·비학습·과적합 위험).
- **enrichment 레이어 다수 조건부** — 상호 일관성·기여도 검증 불명(노이즈 가능).
- **결정이 LLM 판단에 크게 의존** + 다단 폴백(vote/emergency) — 재현성·검증성 약화.
- **shadow 래핑**(packages/core shadow)이 실제 개선을 구동하는지 불명(로그만?).
→ **가설**: 산발적 휴리스틱 + 매직넘버 + LLM 의존이 *일관된·검증된* 결정 로직을 약화. **알파팩터/RL/레짐 기반 체계화 + 검증게이트 일원화**가 최적화 방향 후보.

## 4. 딥리드 잔여 (Phase 1 계속 필요)
- `team/luna.ts` 1001~1388줄(predictive validation·상관 기록·persistence·실행 연결·CLI).
- 정책 모듈 본체: `luna-decision-policy`(fuseSignals 실제)·`luna-orchestration-policy`·`luna-fallback-policy`·`strategy-router`·`entry-trigger-engine`·`predictive-validation-gate`·`luna-signal-persistence-policy`.
- 3시장 파일 각 차이(crypto/domestic/overseas 539/559/554줄).
- 레짐(`market-regime`·`hmm-regime-detector`)·팩터(`korean-factor-model`)·사이징(`dynamic-position-sizer`)·검증게이트(`candidate-backtest-gate`)·**신규 `feat: robust backtest selection`(2da4aa794)** 분석.
- 파이프라인 러너(`pipeline-market-runner`·`pipeline-decision-runner`).

## 5. 다음 단계
- Phase 1 잔여 딥리드 계속 → 또는 Phase 2(영상) 병행. **마스터 결정.**
- 영상 12개 = 자막 추출(yt-dlp, 429 가능) 또는 1차 출처 서칭.

---
## 2.1 의사결정 정책 본체 — 실측 (Phase 1 심화, 2026-06-10)
**융합** `luna-decision-policy.ts`(184줄): `fuseSignals = Σ(direction×confidence×weight)/Σweight`. 추천 임계 **LONG>0.2 / SHORT<−0.2 / (conflict & |score|<0.3)→HOLD**. sentinel 가중 멀티 0.9/0.7/0.92.
**가중치** `luna-analyst-weight-policy.ts`: BASE = TA_MTF 0.35·ONCHAIN 0.25·SENTINEL 0.35·SENTIMENT 0.20·NEWS 0.15(합 1.30, 융합서 정규화). 레짐 bias = `1+(clamp(avg,0.7,1.35)−1)×0.35`. 주식은 MARKET_FLOW 추가. 적응 가중=accuracy report.
**전략 라우팅** `strategy-router.ts`(502줄): 전략군(momentum_rotation/mean_reversion/defensive_rotation/equity_swing) **가산 bias 스코어링** — TA/onchain/flow 신뢰도 + 외부근거(risk-off) + Phase A(shadow 0.25/active 0.5) + 성과 insight(승/패 군 ±0.12~0.14). 매직넘버 0.4·0.08·0.10·0.06·±0.16 산재 → 선택 군이 결정 bias.
**예측 검증** `predictive-validation-gate.ts`(130줄): advisory(기본). predictiveScore ≥ threshold(0.55) 통과 / ≥0.40 관찰레인 / 미만 차단. 매직 0.55/0.40.
**의사결정 스택(요약)**: 분석가신호 → fuseSignals(0.2/0.3) → 가중치(base+regime+adaptive) → strategy-router(가산 bias) → fuseDiscoveryScore(discovery/sentiment/mtf/wyckoff/vsa) → getSymbolDecision(약신호게이트→fast-path 룰→LLM→reviewHint delta→route bias) → conf 블렌딩(0.7/0.3) → predictive gate(0.55) → 포트폴리오 LLM → 대표패스/throttle → capital/reflexion/budget.

## 3.1 핵심 문제 종합 (Phase 1 결론 — 의사결정 로직)
1. **매직넘버 편재**: 임계(0.2·0.3·0.55·0.40)·가중치(0.35·0.25…)·멀티(0.7·0.9·0.92·0.35·±0.16…) — **학습·검증 없이 수작업 튜닝**.
2. **편향 적층(bias stacking)**: regime bias × strategy-route bias × discovery 블렌딩 × reviewHint delta 가 곱·합으로 누적 → **창발 동작 추론·검증 곤란**. 기여도 불명.
3. **LLM 과의존**: 최종 결정이 LLM + 다단 폴백. 스코어는 "컨텍스트"로만. 재현·검증 약함.
4. **조건부 enrichment**: intelligentFlags로 기능 on/off → **로직 표면이 가변**(일관성 불명).
5. **검증게이트 비차단**: predictive/DSR 등 advisory → 나쁜 신호도 통과 가능(실험 우선 정책의 부작용).
→ **종합 진단**: 현 로직은 *시간이 쌓인 휴리스틱 + 매직넘버 + 편향 적층 + LLM 의존*의 누적물. **일관·검증된 결정 프레임워크 부재.** 마스터 직감 = 타당.
→ **최적 재설계 방향(가설, Phase 3에서 구체화)**: (a) 매직넘버 → **데이터/검증 기반 파라미터**(알파팩터 IC·레짐 전이·캘리브레이션) (b) 편향 적층 → **단일 일관 스코어 모델**(검증가능 보상) (c) LLM = 보조(서사·리스크 점검), 결정 코어는 **검증된 수치 모델** (d) advisory→핵심은 **enforce 게이트**(검증 통과분만).

## 0-b. Phase 1 진행 상태 (2026-06-10)
- ✅ 의사결정 척추·정책 본체 심화 완료(위 2.1/3.1).
- ⏳ 잔여: 3시장 차이(crypto/domestic/overseas)·레짐 내부(market-regime/hmm)·팩터(korean-factor-model)·`robust backtest selection`(2da4aa794)·luna.ts 1001~1388(실행 배선).
- ➡️ 결정 로직 그림 확보 → **Phase 2(영상 12개)** 또는 잔여 Phase 1. 마스터 결정.

---
## 2.2 Phase 1 잔여 실측 (2026-06-10 — Phase 1 완결)
**3시장**(`markets/*.ts`): 구조 **대칭**(state·shouldRunCycle·filter·merge·run{Cycle,ResearchCycle} → 공통 러너 위임). 고유 차이만: crypto=topVolume 유니버스·BTC가격 / domestic=mock-untradable 필터·KST 거래일 / overseas=capital-discovery-hold 알림. → **시장 계층은 건전. 문제는 결정 코어에 집중.**
**레짐**(`market-regime.ts` 327줄): **운영 레짐 = 단순 휴리스틱** — 상승:하락 종목 카운트 + 평균 |일변동| ·VIX 임계 → 4레짐(bull/bear/ranging/volatile). `REGIME_GUIDES` = 레짐별 agentWeights(0.8~0.95)·tp/sl/positionSize 멀티(0.3~0.8) **매직넘버**. HMM(`hmm-regime-detector`)은 shadow only — 운영 미반영.
**robust backtest selection**(2da4aa794, `backtest-vectorbt.py` +165줄): `select_consensus_params`(크로스-폴드 합의: median(robust_score) − penalty×std, 커버리지 최소) + `_select_robust_from_grid`(IS top-K **median** 후보 — 단일 행운피크 회피). env `LUNA_BT_ROBUST_SELECTION_ENABLED`(기본 OFF). → **과적합 방지 올바른 방향, 재설계 (a)와 정합. 활성화 후보.**
**실행 배선**(luna.ts 1001~1388): predictive gate(advisory) → entry trigger(flag) → 결정별 [minConf 필터 → 신호 빌드 → **nemesis evaluateSignal**(리스크) → `buildLunaSignalPersistencePlan` → `insertSignalIfFresh`(중복 방지) → blockUpdate → discovery attribution → notify+RAG]. 주문 자체(L31)는 pipeline-decision-runner 소관. → 영속/리스크/알림 체계는 정연. 단 **minConf·펀딩레이트 경고(0.05/−0.01) 등 매직넘버 여기도 존재**.
**팩터**(`korean-factor-model.ts`, 기실측): 고정 스타일 팩터(value/quality/growth/momentum/size) 횡단 percentile. **신규 팩터 발견 없음**(LG-01 알파팩터의 빈 곳 재확인).

## ✅ Phase 1 종결 — 최종 진단
1. **시장/실행 계층 = 건전**(대칭 구조·영속/리스크 체계 정연).
2. **결정 코어 = 문제 집중**(§3.1): 매직넘버 편재 · 편향 적층 · LLM 과의존 · 조건부 enrichment · advisory 일변.
3. **레짐 = 가장 약한 입력**: 운영은 카운트 휴리스틱, HMM은 shadow 방치. 그런데 레짐이 가중치·TP/SL·사이즈 멀티를 곱함 → **약한 입력이 큰 영향**.
4. **검증 자산은 이미 좋아지는 중**: robust backtest selection(OFF)·DSR/PBO 게이트(shadow)·HMM(shadow) — **만들 것보다 켜고 일원화할 것이 많음.**
→ Phase 3 재설계 핵심 질문: "**약한 휴리스틱 입력×매직넘버 적층을, 검증된 소수 입력(알파팩터 IC·레짐 확률·캘리브레이션)의 단일 스코어 모델로 교체**"

## 다음: Phase 2 — YouTube 12개 분석 (외부 기법 입력) → Phase 3 재설계

---
## 0-c. 마스터 확장 지시 (2026-06-10) — 전면 개선·총동원
1. 수정 소스 딥 분석 반영(Phase 1 완료분+증분) 2. **신규 영상 12개** 분석 3. 비용 무시·최적 성능 재설계 4. **지난 세션 히스토리 + 기존 영상 13개 재분석**(제로베이스) 5. **외부 서칭**: 스킬/훅/MCP/A2A → 깃헙·커뮤니티·공식문서·**Anthropic 공개 깃헙** 6. 전 과정 7. 회의실 수정 가능 8. 3시장 전부 9. 설계 범위 확장. 다세션 심층 진행.

## Phase 2 — 신규 영상 12개 (제목 확보 2026-06-10)
| ID | 제목 | 클러스터 |
|---|---|---|
| b3sJIWOO4Z4 | 1천억 단타 천재의 이동평균선 매매법 | 기술 |
| 5avgkEHjBeY | 퀀트 우승자가 말한 '돈 버는 AI 투자'의 조건 | AI/퀀트 |
| q50rIFz6GWc | 거래량+볼린저+RSI+MACD+이평 → VWAP 매매전략 | 기술 |
| IqvnryFzZD4 | I Built an AI Trading System With Claude + TradingView | AI/Claude |
| B5gENmYJrDs | 터틀 트레이딩 | 기술 |
| BAfRVpKIxZ4 | The Math of Winning in Trading | 수학 |
| duzSHbgsYWE | 1$ vs 1000$ Trading Charts (7:23) | 도구 |
| OtImPEfcpvc | Automated System for Catching Every Crypto Dip (16:04) | 자동화 |
| CPkrCoIbBIA | Everything I've Learned Trading With Claude (17:48) | AI/Claude |
| zspMXJVbfAY | Trading Like an Idiot $10k/Month (26:13) | 자동화/단순화 |
| G1qjT0snIZg | 이 단타 매매법을 알면 인생이 바뀝니다 (12:46) | 기술 |
| nBOLIrNX_PU | The 5 Minute Scalping Strategy (14:21) | 기술 |
- 기존 13개 캐시(/tmp/ytdistill/clean/) 생존 — **재분석 대상**. 신규 12개와 중복 없음.

## Phase 2 분석 — 1차 3개 (2026-06-10, 자막 확보분)
### V-A. BAfRVpKIxZ4 "The Math of Winning" — 수학 기반
- **기대값 E = winRate×avgWin − lossRate×avgLoss** = 유일 핵심 지표(비용 차감 후). 8R@15% ≈ 1R@70%: **승률 아닌 조합**이 엣지.
- **R-승률 트레이드오프**: 타깃↑→승률↓는 시장 본질. sweet spot=중간(40~50%@3~4R). breakeven 승률=1/(1+R).
- **분산**: 동일 시스템도 경로 상이 → **대표본만 진실**(100+ 거래). 갬블러 오류(각 거래 독립). **소표본 판단 금지**.
- **리스크**: 고정 달러/% 리스크(0.25~2%), 스톱 크기로 포지션 역산. 리스크% vs 파산확률 비선형(1%=18%, 5%=65% @50%DD). 손실 비대칭(−50%→+100%).
- 🔴 **루나 위반 발견**: `loadReviewConfidenceHint` = closedTrades**≥3**이면 ±0.05~0.08 confidence delta → **소표본(3거래=노이즈) 반응**. 갬블러 오류 구조 내장. 재설계 표적.
- 매핑: E를 scorer/검증게이트 1급 지표로 · R-승률 sweet spot을 전략군 설계 기준으로 · MinTRL/DSR(대표본)과 정합 · 고정% 리스크=sizer 베이스 확인.

### V-B. CPkrCoIbBIA "Trading With Claude 18min" — 결정론/비결정론 ★재설계 외부 검증
- **제1원칙: 결정론(고정룰=백테스트 가능) vs 비결정론(LLM=백테스트 불가) 분리.**
- **비결정론을 코어 전략에 금지** — LLM은 ①리뷰어(자기 thesis에 구멍: 베어케이스·누락 리스크) ②연구(공시/실적 대량 인제스트) ③보조 점수(퀀트와 60/40 블렌드, 가중 조절). 금지: 가격예측·차트 이미지 분석.
- **3층 아키텍처**: ①결정론 매크로 deployment gate(VIX 레벨·기간구조·breadth(200SMA 위 %)·credit spread·put-call·factor crowding → 각 0-100 → 합성 → **>70 full / 40-70 감축(60%) / <40 중단**) ②결정론 스캐너(5팩터) ③LLM 애널리스트(재무 4분기→0-10, 보조).
- 🔴 **루나 핵심 진단 일치**: 루나는 **LLM이 최종 결정자**(symbol/portfolio/exit) = 백테스트 불가 코어 + 비재현. 처방 = **결정 코어를 결정론 스코어 모델로, LLM은 리뷰어/보조 점수로 강등**. §3.1 재설계 방향 (c) 외부 검증 확보.
- 매핑: 매크로 deployment gate(합성→사이징 단계) = 레짐 휴리스틱+capitalGate 대체 후보 · 60/40 블렌드 = 0.7/0.3 위치 교정(결정론 필터 後 보조).

### V-C. IqvnryFzZD4 "Claude + TradingView" — 파이프라인 실전
- **전문지식 우선**("AI는 전문지식 없으면 slop") — 전략은 트레이더가, AI는 도구.
- **2단 스캐너**: A=프리마켓 갭(>5%·$3+·50K+·뉴스 catalyst) → B=**전략별 결정론 entry 5규칙**(10am 후·어제고가 위·어제종가>200SMA·프리마켓고가 위·당일고가 위 = trend-join). A 결과만 B 대상. 스케줄 자동화(30분 주기)+Telegram 포맷.
- **백테스트 단계화**: Pine(1티커)→Mag7→**Python(32티커×30일)** — 도구 한계마다 확장.
- 매핑: **전략군별 명시 entry 룰**(검증가능) ↔ KIS 자연어 휴리스틱 — 결정론 룰화 처방 · 2단 좁히기=discovery→전략필터 구조화 · TradingView MCP(GitHub 2.9k)=도구 참고(기존 입장: 데이터형만).

### Phase 2 잔여
- 자막 확보: 5avgkEHjBeY(429 재시도) + 8개(b3sJIWOO4Z4·q50rIFz6GWc·B5gENmYJrDs·duzSHbgsYWE·OtImPEfcpvc·zspMXJVbfAY·G1qjT0snIZg·nBOLIrNX_PU).
- 기존 13개(/tmp/ytdistill/clean/) **재분석**(제로베이스, 마스터 지시 4).
- **외부 서칭**(지시 5): 스킬/훅/MCP/A2A — 깃헙(TradingView MCP 등)·커뮤니티·공식문서·**Anthropic 공개 깃헙**(anthropics/skills·claude-code 등).

## Phase 2 분석 — 2차 3개 (2026-06-10)
### V-D. 5avgkEHjBeY "퀀트 우승자(WorldQuant 8만명)" ★검증 방법론
- **퀀트=종목 아닌 로직**: 로직이 매일 자동으로 포지션 결정. **전략 다각화**(단일 전략 금지 — 상충·보완 페어 동시 운용, "종목 분산 아닌 전략 분산").
- 🔴 **생존 편향**: "SNS 퀀트 10중 9 미고려. 현재 S&P500 구성으로 백테스트=뭘 해도 좋게 나옴" → **시점별(point-in-time) 유니버스 재구성 필수**(매달 구성종목 갱신). M7 백테스트=생존편향 대표격. **데이터 스누핑**(반복 백테스트로 우연 발견=데이터 고문)·지속 보정 필요(전략 부패).
- **우승 비결 = 단순·명확 + 거시 고려** → OOS(25상반기 관세)에서 타 참가자 전멸 속 홀로 생존. 롱숏 시장중립(하락장 강함, 약점=전례없는 이상현상).
- **LLM 직접 예측 회의**("GPT는 못 맞춤" — 핵심 데이터 비공개·알파는 노출 즉시 소멸). **AI=리서처 페르소나 에이전트 보조**. 도메인 지식>코딩(구현은 AI).
- 매핑: **루나 백테스트 유니버스 생존편향 점검 필수**(discovery universe가 현재 시점 기준이면 편향!) · 전략 페어 다각화=finrl-x 보강 · V-B와 LLM 역할 **이중 확인**.

### V-E. OtImPEfcpvc "Crypto Dip 자동화" — 트리거 설계
- **BTC=시장 신호 자산**(BTC 방향→알트 동방향 증폭). 포트폴리오는 알트, 트리거는 BTC 추적.
- **4종 복합 트리거**(완만한 축적 + 플래시 크래시 **두 시나리오 통합**): ①인트라데이 사다리(−4.7/−7/−9.5/−12/−15/−18% 각각 발화) ②일봉 종가 −3.3% ③연속 음봉 3일(단건 미달이어도) ④가격 레벨 크로스(사다리). 15회 분할+잔여 예산 인지(thinking 시스템).
- 자동화 본질=감정·주의력 의존 제거(부재 중 크래시 포착).
- 매핑: `entry-trigger-engine` 보강 — 사다리·연속음봉·레벨 복합 트리거 · crypto.ts `fetchBtcPrice` 기보유 → BTC 신호화 · 래더 엔트리(B-20)와 합류.

### V-F. B5gENmYJrDs "터틀 트레이딩" — 결정론 추세추종 완전 룰셋
- 철학: 기계적 원칙+감정 배제(터틀 실험=기술은 가르칠 수 있음). 4원칙: ①거래당 ≤2% ②손절 단호(=운영비) ③수익 길게 ④예측 금지·추세 대응. 산수: 9×(−2%)+1×(+50%)=+25%.
- **구체 룰(돈치안)**: 진입=**20캔들 최고가 돌파 종가 마감** / 청산=**10캔들 최저가 이탈 종가 마감** / 손절=**진입가−2×ATR(20)** / 트레일=하단선(10저가)이 손절 위로 오면 유동 전환(손익비 ~1:5) / **200일선 레짐 필터**(위=롱만, 아래=숏만) / 종가 마감 기준(개미털기 회피).
- 매핑: **완전한 결정론 룰셋 확보** — `dynamic-trail-engine`(chandelier/ATR 기보유)과 정합 · trend-following.skill.md(기존 선택 항목)에 구체 파라미터(20/10·2×ATR·200MA) 공급 · KIS 자연어 휴리스틱 대체 룰 후보 · V-C entry 5규칙과 같은 패턴(결정론 entry 명세).

### Phase 2 잔여(2): b3sJIWOO4Z4·q50rIFz6GWc·G1qjT0snIZg·zspMXJVbfAY·duzSHbgsYWE·nBOLIrNX_PU (6) + 기존 13 재분석 + 외부 서칭(TradingView MCP·Anthropic 깃헙)

## Phase 2 분석 — 3차 3개 (2026-06-10)
### V-G. duzSHbgsYWE "차트 계층" [도구·개념만, 마케팅]
- 캔들(소매, 동일 정보=무엣지) → **볼륨 프로파일**(가격대별 거래대금, HVN/LVN=기관 활동) → **풋프린트**(주문 흐름 — **흡수(absorption)**: 대량 매도 흡수→상승) → **유동성 히트맵**(오더북 대량 패시브 주문=자석/거부 레벨).
- 매핑: 루나 crypto는 binance 오더북 접근 가능 — MARKET_FLOW(L04)에 볼륨프로파일·흡수·유동성 레벨 개념 보강 후보(개념만, 구체 룰 없음).

### V-H. G1qjT0snIZg "단타 3단계(수요존)" — 결정론 룰
- ①추세: HH/HL 구조, **유효 저점=이전 고점 확실 돌파 후 형성된 저점**(구조 판정) ②수요존=강한 상승 직전 횡보 매집 구간 → 가격 복귀+반등 양봉 종가=매수 / 손절=존 하단 직하 / 목표=직전 고점 ③**손익비 ≥1:2 사전 필터** — 1·2 충족해도 R:R 미달이면 진입 금지. 역추세 금지.
- 매핑: 수요존≈Wyckoff accumulation(**루나 `wyckoff-phase-detector` 기보유** — 활용처 명확화) · **R:R 사전 게이트**=루나에 없는 명시 진입 필터(신규 후보) · 유효 저점=구조적 추세 판정 룰.

### V-I. nBOLIrNX_PU "ORB 5분(9:35)" — 리테스트 핵심
- Opening Range Breakout: 첫 5분봉 고저 마킹 → 범위 밖 **종가 마감** 돌파 → **리테스트 대기**(레벨 재터치하되 범위 안 종가 마감 X = 유효) → 진입 / 손절=범위 중간값(50%) / 목표=고정 2:1.
- 자체 백테스트(1개월 20거래): **리테스트 대기 70% vs 미대기 33% 승률** — fakeout 필터가 본질.
- 매핑: ORB → 국내장 09:00~09:05 변형 가능 · **리테스트 확인=entry-trigger fakeout 필터 패턴**(`entry-trigger-engine` 보강) · 스캘핑 자체는 기존 기각 유지(비용), 패턴만 차용.

## Phase 2 분석 — 4차 3개 (2026-06-10) — 신규 12개 완료
### V-J. b3sJIWOO4Z4 "테스타(1천억) 이평선" — 결정론 눌림목 룰셋 + 철학
- 철학: ①가치투자/트레이딩 **명확 구분**(진입 근거=차트면 탈출도 차트 — "물리면 가치투자자 변신" 금지) ②**거래량·변동성 있는 종목만**(죽은 종목=기회비용 최대 손실) ③**"범인 찾기"**=시장 유동성 빨아가는 주도주·섹터 추적 ④**기대값 매매**(자리마다 점수=남는 장사인가, V-A 일치) ⑤틀리면 즉시 손절.
- **구체 룰**: **5/25/75 EMA**(5=타점·25=중기필터·75=장기추세, 100일은 늦음). 정배열+기울기 강추세→추세 방향만, 횡보장 금지. **눌림목**: 5일선 하향 눌림→**5일선 재돌파 캔들 종가 매수**(75일선 붕괴 시 무효). 손절=직전 저점 직하. 익절=3:1 고정(승률↑) or **분할**(이전 저항 절반) or **추적손절**(고점 갱신마다 상향, 승률↓수익↑) — 트레이드오프 명시.
- 이평 심리: 개미 손절선(이평 직하) 세력 사냥 → 이탈 후 회복=진짜 타점. 검증: 승률·배수·최대연패 숫자화, 백테스트 vs 실매매 1개월+ 비교. **매수 전 3줄**(이유/이유 소멸 시 매도점/최대손실%).
- 매핑: 터틀(V-F)과 보완되는 **눌림목형 결정론 룰셋** · 범인 찾기=주도 섹터·수급(B-19·MARKET_FLOW) · 유니버스 최소 거래량·변동성 필터 · 추적손절=dynamic-trail 기보유.

### V-K. q50rIFz6GWc "VWAP+VPF(압력 필터)" — 나쁜 자리 차단
- 거래량 막대 색 함정(양봉 거래량≠매수 압력 — 분산/흡수). **VWAP**=거래량 가중 평균가 → 돌파/이탈+**리테스트**(V-I와 동일 패턴, 이중 확인). 유명해져 fakeout 역이용 → **VPF**: VWAP 주변 압력 3상태(회색=대기·초록=매수·흰=매도).
- 🔑 **핵심 철학: "손실 대부분은 틀린 자리가 아니라 애매한 자리·횡보장" → 나쁜 자리 차단 > 좋은 자리 발견**. 회색(횡보) 진입 금지 필터.
- 평균 회귀(VWAP 이격 회귀)·매물대(대량 체결가=지지/저항).
- 매핑: **횡보 감지·진입 금지 필터**(신규 개념 — 약신호 게이트의 거래량 압력 버전) · VWAP 리테스트=entry-trigger 패턴.

### V-L. zspMXJVbfAY "Sneaky Pivot(26년차)" — 단순화 철학
- **"똑똑해질수록 망함 — 단순해져라"**(V-D 단순·명확과 일치). 15분 1타임프레임 + **4라인**(range=전일 고저, swing=그 바깥 직전 고저).
- **라인에서만 매매**(상단 2=매도·하단 2=매수, 그 외 절대 관망). 3캔들: 오프닝→sneaky(확인)→돌파 진입. 손절=빅바이어 직하("수호천사"). 목표=반대편 라인(레인지 왕복). 기술적 분석=literal 아닌 range(존).
- 매핑: 전일 고저 레벨 매매=ORB(V-I) 계열 · "레벨 외 관망"=V-K 나쁜자리 차단과 동일 철학.

## ✅ Phase 2 신규 12개 종합 — 수렴하는 원칙들
1. **결정론 코어, LLM은 보조/리뷰어** (V-B+V-D 이중 확인) — 루나 LLM-최종결정 구조의 정반대.
2. **기대값·R:R이 유일 지표** (V-A+V-J+V-H): E=wR−l, sweet spot 40~50%@3~4R, **R:R 사전 게이트**, 대표본(소표본 금지 — reviewHint≥3 위반).
3. **검증 무결성** (V-D): 생존편향(point-in-time 유니버스)·데이터 스누핑·전략 다각화(상충 페어)·단순+거시.
4. **나쁜 자리 차단 > 좋은 자리 발견** (V-K+V-L+V-J): 횡보 필터·레벨 외 관망·죽은 종목 회피 — "진입 안 함"이 1급 결정.
5. **결정론 룰셋 3종 확보**: 터틀(20/10 돈치안+2ATR+200MA, 추세돌파) · 테스타(5/25/75 눌림목 재돌파) · ORB/Sneaky(레인지 레벨+리테스트) — 전략군(family) 후보. 모두 **종가 마감 확인·리테스트(fakeout 필터)·구조 손절·트레일링** 공통.
6. **시장 게이트** (V-B 매크로 0-100 합성→배치 단계) + **주도 수급 추적**(V-J 범인 찾기) + **복합 트리거**(V-E 사다리+연속음봉+레벨).
→ **Phase 3 재설계 골격 예고**: 결정론 스코어 코어(검증된 입력) + 전략군 룰셋(터틀/눌림목/레인지=레짐별) + 시장 게이트(합성) + R:R·E 사전 게이트 + 횡보 차단 + LLM=리뷰어/보조점수 + point-in-time 검증.

### 다음: 기존 13개 재분석(제로베이스) + 외부 서칭(TradingView MCP·Anthropic 깃헙) → Phase 3
