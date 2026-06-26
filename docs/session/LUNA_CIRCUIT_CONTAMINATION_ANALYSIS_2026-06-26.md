# 서킷 잠금 ⋈ 손익버그 오염 연관분석 (Phase 0)

- 작성일: 2026-06-26
- 작성: 메티 (read-only 분석)
- 목적: C7-10 서킷 잠금 18개가 C7-9 손익버그 오염 거래와 겹치는지 → 데이터 보정 효과 예측
- 결론: **오염은 서킷 잠금의 주원인이 아님. 진짜 원인은 서킷 과민(min_sample 부재) 자체.**

## 데이터

**서킷 잠금 17개 (cooldown 1개 제외, 전부 crypto)**:
MEGA, SOL, BICO, ALLO, JTO, SYN, RE, BABY, AVAX, ENA, XLM, XPL, SENT, SUI, NIGHT, HMSTR, NEAR
- 16개가 sample 1~2개의 작은 손실(-0.01~-0.08 R)로 잠김 (MEGA만 sample 4, -0.17)

**손익버그 오염 거래 11종 (binance, entry_value<5 & exit_value>50)**:
ZBT, ENSO, MEGA, NOM, PUMP, PENGU, LUNC, AVNT, HYPER, ORCA, API3
- entry_value≈0(부분체결 delta 기록)인데 exit_value 큼 → 가짜 pnl (PUMP +243, PENGU +248 등)

## 교집합 분석 결과

| 구분 | 개수 | 심볼 |
|---|---|---|
| **교집합 (오염 ∩ 잠금)** | **1** | MEGA |
| 잠금만 (오염 무관 잠김) | 16 | ALLO·AVAX·BABY·BICO·ENA·HMSTR·JTO·NEAR·NIGHT·RE·SENT·SOL·SUI·SYN·XLM·XPL |
| 오염만 (오염됐으나 안 잠김) | 10 | API3·AVNT·ENSO·HYPER·LUNC·NOM·ORCA·PENGU·PUMP·ZBT |

## 핵심 발견 (진단 수정)

1. **오염은 서킷 잠금의 주원인 아님**: 잠금 17개 중 16개(94%)가 오염과 무관하게 잠김. **데이터 보정만으로는 마비가 안 풀림(MEGA 1개=6%만 해당)**.

2. **진짜 원인 = 서킷 과민 그 자체**: 16개가 오염 없이 sample 1~2개의 정상적 작은 손실로 잠김. min_sample 부재가 핵심. → **Phase 1(서킷 재설계)이 마비 해소의 주 레버**.

3. **오염은 오히려 일부를 "안 잠기게" 만듦**: 오염 거래 10개(PUMP/PENGU 등)는 가짜 수익으로 cumR 양수→잠기지 않음. 즉 오염은 거짓 안전 신호도 생성.

## 로드맵 영향 (우선순위 수정)

- 기존: Phase 0(데이터 보정) → Phase 1(서킷 재설계). 데이터 보정이 선결로 가정.
- **수정**: **Phase 1(서킷 재설계, min_sample)이 국내/crypto 마비 해소의 주 레버** — 16개 잠금을 푸는 핵심. Phase 0(데이터 보정)은 여전히 필요(expectancy/PSR 정확성 + MEGA + 가짜수익 제거)하나, 마비 해소 임팩트는 Phase 1이 큼.
- **권장 조정**: Phase 0와 Phase 1을 병행하되, **서킷 재설계(min_sample)에 더 높은 우선순위**. 데이터 보정은 학습/검증 정확성을 위해 병행.

## 다음 단계
1. Phase 1 서킷 재설계 명세 (메티): min_sample 도입(예 ≥5), 평활화, drawdown veto 유지. 16개 잠금이 풀리는지 시뮬.
2. Phase 0 데이터 보정 (코덱스/마스터): 오염 11종 보정 → expectancy/PSR 정확성 + MEGA 잠금 해제.
3. 두 Phase 후 market-gate 재실행 → circuitLocks 감소 + 신호 생성 재개 확인.
