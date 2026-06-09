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
