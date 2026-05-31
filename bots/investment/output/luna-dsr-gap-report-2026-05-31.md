# 루나 DSR↔기존 갭 분석 리포트

> 생성: 2026-05-31 | DSR 임계(잠정, 전환 시 재검토): ≥0.95 | 데이터: 206건

## 1. 판정 뒤집힘 매트릭스

> healthy × dsr≥임계 2×2 교차표. fp=기존 과대통과 의심, fn=놓친 기회.

| | dsr≥0.95 | dsr<0.95 |
|---|---|---|
| **healthy=true (통과)** | 1건 (일치) | **3건 (과대통과 의심)** |
| **healthy=false (차단)** | **11건 (놓친 기회)** | 191건 (일치) |

- 유효 행: 206건 (dsr IS NOT NULL)
- 기존 과대통과 의심(fp): **3건**
- 놓친 기회(fn): **11건**

## 2. 순위 상관

> sharpe_oos_deflated 순위 vs dsr 순위의 Spearman ρ. 동순위 평균 순위 처리.

- Spearman ρ = **0.9436** → 매우 유사
- 유효 쌍: 206건
- ρ 해석: >0.8 매우 유사 / 0.5~0.8 중간 / <0.5 크게 다름

## 3. 단위 sanity

> sr_oos_unann/sr0/dsr 각 통계 + dsr 이상 분포 감지 (전부 0/1 = 단위 버그 신호).

| 지표 | count | min | median | max |
|---|---|---|---|---|
| dsr | 206 | 0.000 | 0.331 | 1.000 |
| psr | 206 | 0.000 | 0.357 | 1.000 |
| sr0 | 206 | 0.000 | 0.000 | 0.127 |
| sr_oos_unann | 206 | -0.113 | -0.011 | 0.097 |

단위 상태: **✅ 정상**

## 4. 차단 사유 변화

> block_reasons에 unrealistic_sharpe/sharpe_out_of_realistic_range 포함 후보의 dsr 분포.
> 기존 cap으로 막힌 후보가 정통 DSR로는 어떻게 평가되는지 확인.

- unrealistic_sharpe 포함: **69건** / 전체 206건
- 해당 후보 dsr 통계: count=69, min=0.000, median=0.032, max=1.000

### 샘플 (최대 5건)

- **domestic/001390**: dsr=0.015, sharpe_deflated=-4.000
  사유: `unrealistic_sharpe(oos=-6.52,cap=5.0); overfit_gap_high(10.30); sharpe_out_of_realistic_range(val=-7`
- **domestic/005870**: dsr=0.000, sharpe_deflated=-4.000
  사유: `unrealistic_sharpe(oos=-10.38,cap=5.0); overfit_gap_high(18.89); sharpe_out_of_realistic_range(val=-`
- **domestic/005940**: dsr=0.038, sharpe_deflated=-4.000
  사유: `overfit_gap_high(11.74); sharpe_out_of_realistic_range(val=-5.58,cap=4.0); sharpe_negative(-4.00); w`
- **domestic/006110**: dsr=0.033, sharpe_deflated=-4.000
  사유: `unrealistic_sharpe(oos=-5.09,cap=5.0); overfit_gap_high(12.56); sharpe_out_of_realistic_range(val=-5`
- **domestic/007460**: dsr=0.046, sharpe_deflated=-4.000
  사유: `overfit_gap_high(9.36); sharpe_out_of_realistic_range(val=-5.57,cap=4.0); sharpe_negative(-4.00); wa`

## 5. market별 갭 요약

| market | n | fp(과대통과) | fn(놓친기회) | Spearman ρ | dsr median |
|---|---|---|---|---|---|
| crypto | 0 | - | - | - | - |
| domestic | 77 | 1 | 4 | 0.939 | 0.334 |
| overseas | 129 | 2 | 7 | 0.951 | 0.328 |

> domestic: healthy=0이었으므로 fn 주목. crypto: LIVE 운영 중이므로 fp 주목.

## 종합 판단 근거

> **자동 GO/보류 판정 아님** — 메티 검증 + 마스터 최종 결정.

### GO 근거 (전환 지지)
- dsr 분포가 [0,1] 내 합리적 범위 → 단위 정상
- sharpe_oos_deflated와 높은 순위 상관(ρ=0.9436) — 방향 일치
- 기존 3건 과대통과 → DSR로 추가 필터링 가능
- 기존 11건 놓친 기회 → DSR로 발굴 가능

### 보류 근거 (전환 유보)
- 없음

---

*임계값 0.95은 잠정값 — 전환(Phase 1b-2) 시 반드시 재검토.*
*다음 단계: GO → Phase 1b-2(promotion gate에 dsr threshold 반영) / 보류 → dsr 산출 보정 후 재분석.*
