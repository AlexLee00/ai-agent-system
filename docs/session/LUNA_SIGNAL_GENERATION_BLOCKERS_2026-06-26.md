# 루나 신호 생성 0 — 다층 원인 규명 (진단 수정)

> 작성: 메티 · 2026-06-26 · 상태: 분석 (read-only)
> 계기: 서킷 재설계 커밋(f5a8481d4) 후 효과 검증 → 서킷은 풀렸으나 신호 생성 여전히 0 → 진짜 병목 추적
> 진단 수정: C7-10/C7-13의 "서킷이 신호 생성을 막는다"는 부분적으로만 맞음. 실제는 다층.

## 한 줄 요약

서킷 재설계는 성공(low_profit 17→1 실운영 검증)했으나 신호 생성은 여전히 0. 진짜 병목은 **시장 게이트 halt(US/KR 점수<40)** + **게이트-레짐 충돌**. 서킷은 다층 병목 중 하나였을 뿐.

## 서킷 재설계 실운영 검증 ✅

market-gate 12:29 실행(새 로직 f5a8481d4):
- low_profit 잠금 **17 → 1** (MEGA만 유지: sample=4≥minSample=3, cumR=-0.1742)
- 시뮬레이션 예측과 100% 일치. 16개 노이즈성 잠금 실제 해제됨.
- evidence에 minSample=3 기록 확인. 코드 정확 작동.

## 그러나 신호 생성은 여전히 0

```
strategySignals: 0
strategyInserted: 0
entryTriggerShadow: candidates=0, armed=0, fired=0
luna_strategy_signals: crypto 8(6/18)·domestic 1(6/12) — 변화 없음, 오늘 0건
```

서킷이 풀렸는데도 신호 0 → 서킷 위(앞단)에 더 근본적 병목 존재.

## 진짜 병목 — 시장 게이트 halt

market-gate summary: "US halt(38.2)·KR halt(32.55)·crypto reduced(41.58)"

**임계값** (luna-market-deployment-gate.ts): fullThreshold=70, **reducedThreshold=40** (미만이면 halt).

**신호별 점수 (점수를 끌어내린 주범):**
- OVERSEAS 38.2 halt: vix_level 70.04 + **us_benchmark_trend 0** (가용 2/4, 2개 소스 미연결)
- DOMESTIC 32.55 halt: **kospi_realized_vol_proxy 0** + korea_shadow_flow 50 + usdkrw_momentum 50 + us_gate_transition 38.2
- CRYPTO 41.58 reduced: btc_vol 21.26 + btc_onchain 17.62 + btc_funding 97.77 + us_transition 38.2

**0점 신호의 raw (진짜 약세 — 버그 아님):**
- us_benchmark_trend: avgTrendPct **-4.92%** (임계 -4% 초과) → bearish/volatile → 정당한 0
- kospi_realized_vol_proxy: avgAbsDayChangePct **6.24%** (임계 3% 초과 고변동성) → 정당한 0
- marketData error 없음, bars 80~117 충분 → 데이터 정상.

## 핵심 발견 — 게이트 vs 레짐 충돌

같은 domestic 데이터(80 bars)인데 두 모듈이 정반대 판정:
- **레짐 엔진(HMM)**: dominant=**bull**, conf=0.5368 (recentTrend +0.98%, momentum20 +16.8%) → 방향성 기반 상승
- **게이트 kospi_vol_proxy**: avgAbs 6.24% 고변동성 → **0점 halt** → 변동성 기반 위험

즉 **"상승하지만 변동성 큰 시장"**. 레짐은 기회로, 게이트는 위험으로 봄. 게이트가 방향성(상승)을 무시하고 변동성만으로 halt → 상승장인데 신호 0.

## 진단 수정 — 신호 생성 0의 다층 원인

```
[1] 서킷 (해결됨 ✅ 17→1)
[2] 시장 게이트 halt (US -4.92%, KR 6.24% 고변동성 → 점수<40)  ← 진짜 병목
[3] 게이트-레짐 충돌 (레짐 bull vs 게이트 변동성 halt)
[4] us_benchmark_trend·kospi_vol 0점 + 소스 미연결(vix_term/put_call/btc_dominance)
```

서킷은 [1] 하나였고, 신호 생성 0의 주원인은 [2][3]. C7-13 서킷 개선은 옳았으나(검증됨) 그것만으로 신호 생성 복구는 불충분.

## 중요한 트레이드오프 — "상승하는 고변동성 장" 거래 여부

- 게이트 halt는 **데이터 기반 정상 동작** — 실제 약세/고변동성 반영. 영상 V4-C(고변동성/매크로엔 step-out)와 일치하는 보수적 동작.
- 무조건 게이트를 풀어 국내/해외 가동 = 영상 원칙(변동성 클 때 빠지기)과 충돌 위험.
- 진짜 결정: 레짐 bull(상승 기회) vs 게이트 변동성(위험) 트레이드오프를 어떻게 설정할지. 마스터 방향 필요.

## 다음 단계 (후속)

1. **게이트-레짐 충돌 해소 설계** (메티 명세): kospi_vol_proxy가 방향성 무시 문제. 레짐 bull일 때 변동성 페널티 완화 또는 시장별 변동성 임계 조정. 서킷 재설계처럼 데이터 기반.
2. **소스 미연결 보강**: vix_term_structure·put_call_ratio·btc_dominance (가용 신호 늘려 점수 안정화).
3. **게이트 임계 재검토**: reducedThreshold 40 적정성 (단 약세장 거래 허용 트레이드오프).
4. 데이터 보정(Phase 0) 병행.

## 주의
- 게이트/market-gate는 PROTECTED launchd. 무중단.
- 실제 임계 변경·가동은 마스터 전용. 메티는 분석·명세.
- 지금 시장이 실제 약세/고변동성이므로, 가동은 신중히 (영상 V4-C 원칙 고려).
