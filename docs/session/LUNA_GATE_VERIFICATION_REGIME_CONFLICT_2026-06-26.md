# 게이트 재설계 검증 + 레짐 엔진 충돌 발견

> 작성: 메티 · 2026-06-26 · 상태: 검증 (read-only)
> 대상: 코덱스 구현 게이트 재설계(regime_direction) 독립 검증
> 명세: docs/codex/SPEC_MARKET_GATE_REGIME_2026-06-26.md / 진단: C7-16

## 게이트 구현 검증 ✅ (정확)

luna-market-deployment-gate.ts 정독:
- `regimeDirectionScore`(L79): bull+momentum>0→clamp(50+m×200,50,90), bear+momentum<0→clamp(...,10,50), else 50. **명세 공식 100% 일치**.
- HMM 우선 fallback 3단(L322-335): regimeDirectionSignalFromState(HMM/luna-regime-engine) → regimeDirectionSignalFromFallback(market-regime) → getMarketRegime.
- weight=1.5 파라미터화(g0.market_gate.regime_direction_weight).
- 3개 시장 collector 모두 적용. normalizeRegimeDominant로 복합문자열 정규화.
- runtime-luna-market-gate.ts(L107-140): computeRegimes(HMM) → regimeByMarket Map → 게이트 전달. **HMM regime 정상 주입 확인**.

검증: node --check·tsc·smoke 전부 통과(코덱스). 메티 코드 리뷰 통과.

## ★ 새 발견 — 두 레짐 엔진이 정반대 판정

게이트 실데이터 검증 중, 같은 국내 시장을 두 레짐 소스가 충돌 판정:

| 소스 | 국내(domestic) | momentum | confidence |
|---|---|---|---|
| **luna-regime-engine (HMM)** | **bull** | +16.8% | 0.54 |
| **market-regime (fallback)** | **volatile/bearish** | -8.6% | 0.85 |

- runtime은 HMM을 쓰므로(bull) → regime_direction 83.6 → 게이트 **reduced(풀림)**.
- 단 메티 단독 검증(options에 regimes 미전달)은 fallback(bearish) → regime_direction 50 → **halt**.
- 코드는 정확(HMM 우선이 의도). 단 **HMM과 market-regime이 정반대**라는 게 새 문제.

## 함의 — 게이트 재설계가 HMM 신뢰에 의존

- 게이트 재설계는 "HMM이 bull로 본다"는 전제에서 국내를 푼다.
- 그러나 market-regime은 같은 시장을 bearish(-8.6%)로 판정, 오히려 confidence 더 높음(0.85 vs 0.54).
- **어느 레짐 엔진이 맞는가가 미해결**. HMM이 틀렸다면(국내가 실제 약세면) 게이트를 풀어 거래 = 위험.
- 시장 자체도 변동 중: 12:29 분석때 HMM=bull, 이후 시점 market-regime=bearish. 시점별 차이 가능.

## 진단 — 게이트 재설계는 옳으나, 레짐 신뢰성이 선결 과제로 부상

게이트가 레짐 방향을 결합하는 설계(C7-16)는 올바름. 단 그 입력인 레짐 판정 자체가 두 엔진에서 갈리므로, **레짐 엔진 신뢰성 검증이 게이트 효과의 전제**가 됨. "쓰레기 입력 → 쓰레기 출력" 회피.

## 다음 단계
1. **레짐 엔진 신뢰성 검증** (메티 read-only): luna-regime-engine(HMM) vs market-regime를 과거 데이터로 비교 — 어느 게 실제 시장 방향을 더 잘 맞췄나(적중률). 국내 실제 추세 확인.
2. HMM이 신뢰되면 → 게이트 재설계 그대로 진행(국내 풀림 정당).
3. market-regime이 신뢰되면 → 게이트가 HMM 대신 market-regime 쓰거나, 두 엔진 합의(confluence) 필요.
4. 두 엔진 충돌 자체 해소 — 어느 것을 SSOT로 할지 또는 앙상블.

## 주의
- 게이트는 PROTECTED launchd·shadowOnly. 무중단.
- 게이트 재설계 코드는 정확 — 롤백 불필요. 단 launch(실거래 반영) 전 레짐 신뢰성 검증 필요.
- 실제 시장이 약세일 가능성 — 영상 V4-C(약세/고변동성 회피) 고려. 무리한 가동 금지.
