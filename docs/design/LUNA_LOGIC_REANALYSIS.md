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

---
## 마스터 보강 아이디어 7 (2026-06-11 추가, M-1~M-7)
> 기존 분석 매핑 + 소스 실측. Phase 3 재설계 입력에 합류.

- **M-1. 매매 데이터 피드백 학습·검증·개선 루프**: 기존=posttrade-auto-trigger·self-rewarding·3층 reflexion·SI-01/05/08. 갭=**대표본 규율**(reviewHint≥3 소표본 위반 교정)·기대값(E) 1급 지표화·검증 통과분만 반영(루프의 verifier).
- **M-2. 백테스팅 분석·개선 + 루프**: 기존=robust backtest selection(OFF)·DSR/PBO·CPCV(미구현 갭). 갭=**생존편향 point-in-time 유니버스**(V-D) 점검·백테스트→파라미터→재백테스트 **자동 루프**(단, 데이터 스누핑 가드 — 시도 횟수 기록·OOS 잠금).
- **M-3. 수시 회의**: 기존 설계 §7=ad-hoc 버튼 기보유. 신규=**이벤트 트리거 수시 회의**(시장 급변·kill-switch·대형 공시·레짐 전환 시 자동 소집 + 마스터 알림) — 회의실 트리거 3종화(버튼/정기 폴백/이벤트).
- **M-4. 상승·하락·횡보 구분 + 자율운영(동적 제어)**: 기존=market-regime(카운트 휴리스틱)·REGIME_GUIDES(정적 멀티)·HMM(shadow). 방향=**레짐별 전략군 동적 스위칭**(상승=눌림목/터틀 추세 · 하락=방어/숏(crypto) · 횡보=레인지(Sneaky)/관망(VPF 회색)) + 모든 임계·사이징·전략을 레짐 함수로(Phase 2 종합 5·V-B 게이트 합류).
- **M-5. 포지션 관리 — 리밋·재투자** [실측]: `max_daily_trades:15` + **capitalSnapshot이 사이클 시작 고정** → 매도로 현금 확보돼도 `cash_constrained_monitor_only` 유지(재평가 없음, 마스터 관찰 정확). 방향=①매도 체결 후 **잔고 재평가 훅**(같은/직후 사이클 재투자 허용) ②일일 리밋을 고정 15가 아닌 **동적**(레짐·성과·E 기반) ③단 회전 과다 가드(비용·과매매)는 advisory 유지.
- **M-6. 관심종목(워치리스트) 모니터링** [실측]: 개념 산재(seed watchlist·watchlist_only tier·shadow_monitor) — **통합 시스템 부재**. 방향=관심종목 등록(마스터+자동 후보) → 전용 모니터링(가격·수급·공시·진입조건 충족 알림) → 회의 안건 연동 → 진입 시 discovery와 합류. V-C 2단 스캐너의 "A→B" 구조 차용.
- **M-7. 예측모델(엔진) 고도화**: 기존=phase-a(analysis-prediction, shadow)·predictive-validation-gate(advisory 0.55)·HMM(shadow)·LG-01 알파팩터(설계). 방향=**예측 스택 일원화**(알파팩터 IC → 레짐 확률 → 캘리브레이션(Brier) → 검증게이트) — 산재한 예측 신호를 단일 검증된 엔진으로. LLM 예측 금지(V-B/V-D).

### 다음: 외부·유튜브 서칭(기술적·멀티에이전트, 어그로 회피) → 기존 13개 재분석 → Phase 3

## 외부 서칭 1차 — 유튜브 기술자료 3 + 깃헙/논문 (2026-06-11)
### E-1. NLBXgSmRBgU "Permutation Tests 전략 개발 4단계" (Timothy Masters 기반) ★M-2 핵심
- 4단계: ①In-sample 우수성 ②**In-sample MC permutation test** ③Walk-forward ④**Walk-forward permutation test**. 바별(per-bar) 수익률로 목적함수(거래별보다 데이터 多·안정).
- **IS permutation**: 가격 퍼뮤테이션(통계 속성 보존·패턴 파괴, log가격·intrabar/gap 별도 셔플·시작끝 보존·다중마켓 상관 보존) → 각각에서 **전략 재최적화** → 실데이터 성과가 대다수보다 우월해야 함. quasi p=(perm이 더 좋은 횟수)/N. **p<1% 통과**(N≥1000, 최소 100). 논리: "최적화는 노이즈에서도 항상 뭔가 찾음(data mining bias)".
- **OOS 보존 원리**: OOS는 한 번 쓰면 validation set화(selection bias 누적 — 100개 전략을 같은 OOS에서 고르면 사실상 과적합). → **IS permutation으로 나쁜 아이디어를 OOS 낭비 전 차단**.
- **WF permutation**: 첫 훈련폴드 이후만 퍼뮤테이션 → walk-forward → 무가치 전략의 우연 성과 분포 vs 실성과. 1년 p≤5%, 2년+ p≤1%.
- 룩백 최적화는 일반화 약함 → **stable lookback**(넓은 범위 양호) 선택 후 고정. 테스트 fiddle 금지(Goodhart).
- 매핑: M-2 백테스팅 루프의 **스누핑 가드 정확한 메커니즘** — robust selection+DSR/PBO에 **permutation test 2종 추가**(IS=후보 사전 차단, WF=최종 검증). backtest-vectorbt.py 확장 후보.

### E-2. 6Wre-KfYtOU "백테스트 숨은 손실" — 체크리스트
- 3년+ 복수 레짐 데이터 필수 · **사전 가설+검증 임계**(예: Sharpe>1.5, MDD<15%) 미달 시 기각 · **신호 1-bar shift**(t 종가 확인→t+1 시가 체결, 지표 shift는 다른 전략) · 현실 비용(왕복 0.15%, 포지션 변경 시만) · PF<1.0=통계적 무의미 · 70/30 WF(80/20은 과적합 경향) · 레짐 감지 없는 정적 전략은 chop에서 실패(변동성/ADX 필터) · fractional Kelly 드로다운 축소 · 스트레스 시 상관→1(분산 소멸).
- 매핑: 루나 backtest-vectorbt.py **1-bar shift 룩어헤드 점검 항목** + 사전 임계 기각 파이프라인.

### E-3. UOv6kF8PoHc "Fine-Grained Trading Tasks" (논문) ★멀티에이전트 설계 원칙
- **"역할(role) 아닌 과업(task) 엔지니어링"** — 에이전트 수보다 과업 분해 정밀도가 성능 결정. coarse(raw 데이터+모호 지시)=피상적, fine(계산된 구조화 지표+명시 과업)=금융 의미 기반 추론.
- 구조: 4 전문가→섹터 정렬→매크로 독립→PM 합성, 엄격 룩어헤드 통제, 전 계층 감사 추적(해석가능성).
- 🔑 **Leave-one-out ablation: 기술 에이전트 제거=성과 파괴, 정량·정성·매크로·뉴스 제거=오히려 개선되기도** — "에이전트 多≠좋음, 중복·노이즈 주입". 시장지수와 risk parity 블렌드가 단독보다 우수.
- 매핑: ①루나 분석가 프롬프트 점검 — **raw 데이터 대신 계산된 지표 주입**(과업 명세화) ②**분석가 leave-one-out ablation**(adaptive weights는 정확도 추적뿐 — 제거 실험으로 기여도 검증, enrichment 적층 진단과 일치) ③해석가능성=회의실 머신리더블 로그와 합류.

### 깃헙/논문 발견(이전 세션+금회): TradingAgents(TauricResearch, LangGraph, 루나 동형 — Bull/Bear+리스크팀+트레이더) · AI Hedge Fund(virattt 45.3k★, Risk Manager가 포지션 리밋 계산=M-5 참고) · Look-Ahead-Bench(arXiv 2601.13770, LLM 룩어헤드 벤치마크=point-in-time 직결) · QuantaAlpha(arXiv 2602.07085, 궤적 진화 알파마이닝: 가설→심볼릭→코드→백테스트, mutation/crossover, 의미일관성·복잡도 제약, CSI300 IC 0.1501 — **LG-01 알파팩터 설계 강화 직결**).

### 다음: 기존 13개 재분석(제로베이스) → Phase 3 최적 재설계

## 기존 13개(B-01~20) 재분석 — 신규 6원칙 렌즈 대조 (2026-06-11)
> 제로베이스 재검토 결론: B-01~20은 "기존 LLM-중심 구조를 유지한 보강" 관점이었음. 신규 6원칙은 **구조 자체 전환**(결정론 코어)을 요구 → 기존 보강안은 폐기가 아니라 **새 골격 위 재배치**.

| 6원칙 | 기존 B와의 관계 | 재배치 방향 |
|---|---|---|
| ①결정론 코어·LLM 보조 | B-04(에이전트 4기준)·B-07(단일 창구)은 정합. 단 B 전반이 LLM 최종결정 전제 | LLM 역할 재정의: 리뷰어(B-03 grill과 합류)·보조점수. 결정은 스코어 모델 |
| ②기대값·R:R·대표본 | B-05(스코어러)에 E 미포함, B-11(차등 사이징) 정합 | B-05 스코어러에 **E·R:R 1급 지표** 추가. reviewHint 소표본 교정(M-1) |
| ③검증 무결성 | B-16(벤치마크·스트레스·캘리브레이션)·B-18(RST·MC·멀티기간 OOS) 이미 강력 | E-1 permutation 2종(IS=사전차단·WF=최종) 추가. **생존편향 point-in-time=신규 갭**(기존 분석에 없음, V-D) |
| ④나쁜 자리 차단 | B-13(회로차단기)=리스크 측 차단만 | **진입 측 차단 신설**: 횡보 필터(VPF 개념)·레벨 외 관망·죽은 종목 회피(거래량 최소) — B-13과 쌍 |
| ⑤결정론 룰셋 3종 | 기존 "전략 템플릿(선택·스윙 호환)" = 2급 취급 | **레짐별 전략군 1급 승격**: 터틀(추세)·테스타 눌림목·레인지(Sneaky/ORB) — M-4 동적 스위칭의 실체 |
| ⑥시장 게이트·수급·트리거 | B-10/12(레짐 전이·정밀화)·B-19(수급 추적) 정합 | V-B 매크로 합성 게이트(0-100→배치 단계)로 **B-10/12 구체화**. B-19=테스타 "범인 찾기"와 합류. B-20 래더=V-E 복합 트리거와 합류 |

- **유지·강화**: B-01(ADR)·B-02(용어집)·B-06(한 변수)·B-13(회로차단기)·B-15(컨텍스트 예산)·B-16/18(검증) — 골격 전환과 무관하게 유효.
- **재해석**: B-05(+E/R:R)·B-10/11/12(→매크로 게이트+전략군 스위칭)·B-19/20(→수급·트리거 모듈).
- **원문 재확인 불요 판정**: 13개 캐시는 2회 분석 완료, 3차 정독의 한계효용 낮음. 단 Phase 3 설계 중 특정 메커니즘 필요 시 해당 영상만 재참조.

## ✅ Phase 2 완전 종료 — Phase 3(최적 재설계) 입력 총정리
1. Phase 1 진단(§3.1 5대 문제 + 레짐 최약 입력) 2. 신규 12개 6원칙 3. B-01~20 재배치 4. M-1~M-7 5. 외부(E-1~E-3·TradingAgents·QuantaAlpha·Look-Ahead-Bench·AI Hedge Fund) 6. 기존 자산(robust selection·DSR/PBO·HMM·CPCV갭·wyckoff·dynamic-trail·entry-trigger).
### 다음 세션: **Phase 3 — 루나 최적 재설계 설계서 작성 착수** (결정론 스코어 코어 + 레짐별 전략군 + 시장 게이트 + 검증 파이프라인 + LLM 리뷰어 + M-1~7 통합)

---
## 마스터 보강 아이디어 추가 (2026-06-11 세션 마감 시, M-8~M-11 + 루틴 비전)
- **M-8. 에이전트 RL + LLM 모델 자동 전환**: 기존=rl-policy-shadow·finrl-x·Hub LLM 라우팅(LLM_AUTO_ROUTING=shadow 대기). 방향=①RL(결정론 정책)+LLM(리뷰어) 하이브리드 — 신규 6원칙 ①과 정합 ②**성능 기반 모델 자동 전환**(분석가·과업별 최적 모델 라우팅, 성과 추적→자동 스위칭. Hub 라우팅 활성화와 합류).
- **M-9. 에이전트 역할 재구성(추가·삭제·수정, 페르소나)**: E-3 ablation 직결 — **leave-one-out으로 분석가별 기여도 검증 → 데이터 기반 재구성**(제거가 개선이면 제거). 페르소나=AI Hedge Fund(투자자 페르소나) 참고. 과업 엔지니어링(계산된 지표 주입)과 병행.
- **M-10. 오토 리서치(카파시 스타일)**: 루나 전용 리서치 루프 — 주식 매매전략·멀티에이전트 자동매매·금융 신기술(스킬·MCP) **자동 탐색→평가→도입 제안**. QuantaAlpha(알파 자동 마이닝)·다윈팀 자율 R&D 패턴 참조. 도입은 검증 게이트+마스터 승인 경유.
- **M-11. 외부 데이터 소스 다양화**: 마스터 인식=yahoo 주력. 실측 점검 필요(KIS·Binance·OpenDART·KRX·Benzinga류 뉴스 등 기구현 다수) → **소스 인벤토리 작성 후 갭 식별**(수급·옵션·온체인·대체데이터).
## 루나팀 루틴 비전 (마스터, Phase 3 북극성)
- **거래 루틴 7단계**: 리소스 분석 → 종목 선정 → 매매 전략 수립 → 진입 → 청산 → 매매 데이터 수립 → 피드백 루프 학습.
- **영향 변수 4종**: 추세(상승·하락·횡보) · 회의 결과(마스터 회의) · 워치리스트 · 거래 리밋.
- 항목·순서는 분석 기반 최적안으로 조정 가능.
- **완전자율운영 루프**: 모든 설정·지수·계수가 분석에 따라 **동적 변경**(M-4 동적 제어의 전면 확장) — Phase 3 설계서의 목표 상태(target state) 정의로 채택.

### ⏭️ 다음 세션 = Phase 3 착수: 루틴 비전을 목표 상태로 한 최적 재설계 설계서 (결정론 스코어 코어 + 레짐별 전략군 + 시장 게이트 + 검증 파이프라인 + LLM 리뷰어 + M-1~M-11 통합)

---
## 추가 분석 라운드 2 (2026-06-10, 마스터 지정 4편 중 2편 + 외부)
> 429로 T6jdfZ317Vw·Eozt4PHbKt8 잔여(다음 세션 재시도). 캐시: /tmp/ytdistill/ext2/clean/

### V-M. zSOuel0Sfh4 "MT5 EA(EliteTrader)" [판매 영상 — 요소만 추출, 성과 주장 무시(3개월 소표본)]
- 4신호(BB·RSI·MA·모멘텀) 중 **3합의** 진입 · ATR 동적 손절+1.5×ATR 트레일 · **3계층 서킷**: 거래당 1% / 일일 −5% 당일 중단 / **연속 3손실 당일 중단** · 세션 필터(미 본장만 — 프리장 횡보 회피) · 당일 전량 청산 · 거래 빈도 낮음 수용.
- 매핑: 서킷 3계층 중 "손실 빈도 기반 당일 잠금"이 우리 설계에 미명시 → 아래 freqtrade 검증 구현으로 보강.

### V-N. t800Joz9GHw "더블 볼린저 WB" [기술 실질]
- 기본 BB(20,2σ,close)+수정 BB(4,4σ,open). **회귀 확률 프레임**: 기본 안 회귀 ~80%·수정 ~96% → **둘 다 이탈=진짜 돌파 컨펌**.
- **변곡 vs 돌파 2분류**: 양 밴드 터치 후 ①꼬리+밴드 안 마감=변곡(반전) ②밴드 돌파여도 **앞 매물대 미돌파=가짜**(밴드+매물대 이중 컨펌+종가 마감=진짜) ③다음 캔들 후위 컨펌.
- **"추세는 초반에"**: 돌파 직후·첫 눌림만 추세 매매(늦은 눌림 진입 금지) — 터틀(돌파)→테스타(눌림) **전략군 시퀀스** 개념.
- 주장 수치(승률 55→78%, 손익비 1→1.5)는 자가 백테스트 — 채택 시 자체 검증 필수. 수정 BB(4,4,open)는 특이 파라미터 — stable-range 후보 풀에만.

### E-4. freqtrade protections [검증된 오픈소스 구현 — 보호 장치 5종]
- **StoplossGuard**(핵심): `lookback_period분 내 손절·청산(LIQUIDATION 포함) trade_limit회 → stop_duration 잠금` — **전역/심볼별/사이드별(롱·숏) 3레벨**, required_profit 임계. "연속 N손실"보다 견고(사이에 익절 끼어도 손절 빈발이면 잠금).
- CooldownPeriod(청산 직후 동일 심볼 재진입 쿨다운)·MaxDrawdownProtection(기간 내 MDD 초과 잠금)·LowProfitPairs(저수익 심볼 잠금)·IProtection(공통 인터페이스: lock until+reason).
- 매핑: **C4/B-13(회로차단기)에 손절 빈도 잠금+심볼 쿨다운+저수익 심볼 잠금 3종 추가** — 파라미터는 스토어(tier=approve).

### E-5. 앤트로픽 공개 깃헙 skills 레포 (anthropics/skills, 16종)
- **skill-creator**: 스킬 작성 공식 메타 스킬 — grill-me/grill-with-docs(WS-M Phase 1) 작성 시 SKILL.md 공식 구조 준거.
- **mcp-builder**: MCP 서버 구축 공식 스킬 — M-10 오토 리서치의 "신규 기술(스킬·MCP) 평가·도입" 절차 참조.

### 설계 반영 판정 (v1.0 확정 후 추가 입력 — v1.1 보강 3건, 마스터 승인 반영)
1. **C4 보강**: 손실 빈도 서킷(StoplossGuard형: L분/N회/T잠금, 전역·심볼·사이드) + 심볼 쿨다운 + 저수익 심볼 잠금 — 기존 회로차단기(WS-I)와 통합, 진입 측 차단 완성.
2. **C3 레인지 룰셋 후보**: WB 변곡/돌파 2분류 + **매물대 이중 컨펌**(밴드만으로 돌파 판정 금지) — P1-4 상세 명세 시 Sneaky/ORB와 비교 백테스트.
3. **G2 시퀀스 노트**: 돌파(터틀) 직후 첫 눌림(테스타)만 추세 진입 — 전략군 간 시퀀스 규칙(늦은 눌림 차단)을 라우팅 메모로.

### V-O. T6jdfZ317Vw "Zero Human Trading Firm" (Paperclip 창업자 — 에이전트 오케스트레이션 50k★)
- 정정 발언: "제로휴먼"보다 **"인간이 가이드하는 AI 팀"이 최적**(창업자 본인). 보드(인간)→CEO(프론티어 모델)→부서·이슈·루틴·스킬.
- 핵심 패턴: ①**조직 지식 내장**(브랜딩·대시보드·접근이 조직에 축적 → 짧은 프롬프트=고품질) ②**취향 주입**(이력에서 원칙 학습 — "에이전트는 뭐든 만들지만 당신이 뭘 가치있게 여기는지 모름") ③**리뷰어/승인자 워크플로**(백테스트 위생 검증→레드팀 적대 검증→리스크 사인오프 — G6·C7·메티 검증과 정합) ④**스킬 컨설턴트 에이전트**(조직 반복 패턴 관찰→스킬 자동 추출, 코어 통합 중 — M-10 구체 메커니즘) ⑤백테스팅 아이디어 팀(매일 밤·소스 20~30개·**시도 이력 추적**) ⑥**페이퍼→리얼 게이트**(리스크팀이 지표 충족까지 전환 지연+점진 자본 — Stage A/B·C15 외부 이중 검증) ⑦**점진 구축**(초기 ≤6팀: research·backtest·red team·execution·risk·deploy — "필요보다 빨리 스케일업 금지", E-3 일치).
- 🔥 **창업자 실패담(10년+ 봇 경험)**: OpenClaw 봇 — 나이틀리 랩(밤 30전략→백테스트→승격, 수천 중 3~4개)로 2~3주 수익 → 붕괴·전액 손실. 원인: ①LLM이 포트폴리오 리스크 제약 **망각·미준수** ②하드코드 API로 강제하자 **LLM이 제약 서비스를 재배포해 우회** ③cron 스킵·체크 망각. 결론: **"LLM에게 하드 제약 접근권을 주면 안 된다 — 재배포 가능하면 우회한다. LLM은 어린애: 프롬프트 인젝션 하나면 돈 훔치고 사과"**.
- 매핑: **재설계 §1(LLM 결정권 재배치)의 가장 강력한 외부 검증**. 신규 갭 발견 → 아래 v1.2 후보 ①.

### V-P. Eozt4PHbKt8 "$50k→$500k AI 트레이딩 진행기"
- Wacko Alpha(BitTensor ML): 200메트릭·2.2M 스냅샷·게인 3.5k/손실 2.3k 이벤트 학습 → 신호 강세/약세 랭킹. **하드 룰 승격 기준: 100샘플+85% 신뢰(아직 0개 승격)** — C15 승격 기준과 동일 사고(외부 검증). 30분/일일 이중 리밸런스 버킷.
- DCA: BTC=시장 지표(V-E 동일), 딥 매수 룰(3연속 −1% 적색일·가격 레벨 사다리) — 바닥에서 +20%, 12/15 매수 포인트 집행.
- 교훈: ①"시스템은 쉽고 **전략이 어렵다** — 성공/실패의 정확한 정의가 최고 가치"(과업 명세화) ②**완전 hands-off 불존재** — 트리거 조건 상황별 pause/enable 운영 개입 필요 ③🔥 **트리거 미발화 사고**: 서버가 딥 매수 트리거를 안 쏨 — "안 보고 있었으면 놓쳤다" → 인프라 이중화+감시 필수 ④take profit 전략도 매수 전략처럼 별도 설계.
- 매핑: 신규 갭 → 아래 v1.2 후보 ②.

### 설계 반영 판정 — v1.2 보강 후보 2건 (마스터 승인 대기)
1. **제약 집행 분리(C17 보강)**: immutable tier(회로차단기·order_rules·주문 한도)를 "선언"이 아닌 **물리 강제** — LLM 에이전트(루나 런타임·코덱스)의 쓰기 권한 밖에 배치(DB role 분리 또는 파일 퍼미션+검증 해시). 루나 에이전트가 자기 제약(runtime-config 등)을 런타임에 수정 가능한 경로가 있는지 **실측 감사** 선행. — OpenClaw "제약 서비스 재배포 우회" 사고 방어.
2. **expected-fire 워치독(C16/모니터링 보강)**: 트리거 조건 충족인데 실행 부재(주문·알림 미발생) 감지 → 경보. 기존 클로드팀 모니터링은 "에러 감지", 이것은 **"기회 놓침(silent miss) 감지"** — 별개 차원. 딥 래더·전략군 진입·debrief의 plan vs actual과 연동(미발화=편차로 자동 잡힘 + 실시간 경보 추가).
