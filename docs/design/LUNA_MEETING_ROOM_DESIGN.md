# 루나 투자회의 + 펀더멘털 리서치 — 설계 (SSOT)

> 버전 v0.2 (2026-06-08) · 작성: 메티 · 상태: 실험판(마스터 승인 — 구현 착수)
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
- **경계(되돌릴 수 없는 손실)** = 유지 → 실거래·자금이동·운영 중단.
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
- 케이던스 = **일일 전술 + 주간 전략**(§7).

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
2. **Hub 연결 = meeting-room 독립 loopback 서버(index.ts) + Hub `hub-proxy` 프록시**(route-registry 마운트 아님). 웹+WS 분리.
3. **이종 모델 = 불(zeus)=Claude / 베어(athena)=OpenAI(현행)**. zeus.yaml `llm_routing.primary`를 claude로 변경.

## 18. 리스크 · 미해결
- 미해결: CPCV 신규 구현 · 폴백 plist 시간대(KST) 정확성 · paper 원장 스키마 · hub-proxy 경로.
- 검증 후 시장 확장(해외·crypto) 게이트.
