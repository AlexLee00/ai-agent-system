# 시장 체제 분석 프롬프트 (Phase 1)

> 위치: `Luna.V2.Regime.LLMRegimeAnalyzer` 내부에 인라인 적용됨.
> 이 파일은 프롬프트 설계 문서 겸 검토용 레퍼런스.

## 역할

LLM이 규칙 기반 체제 감지 결과를 보조 검증하고, 거시 컨텍스트를 반영한 체제 판단을 제공한다.
Shadow Mode에서는 규칙 기반과 병렬로 실행되어 일치율을 측정하고 DB에 저장한다.

## 입력 구성

```
[규칙 기반 현재 판단]
체제: trending_bull | trending_bear | ranging | volatile | unknown
신뢰도: 0~100%

[시장 데이터]
- 종목별 일간 변동률 (최근 스냅샷)
- 평균 일간 변동 (avgAbsDayChange)

[체제 분류 기준]
- trending_bull: 강한 상승 추세, 고신뢰 양봉 지속
- trending_bear: 강한 하락 추세, 고신뢰 음봉 지속
- ranging: 방향성 없는 횡보장
- volatile: 급격한 변동성 (극단적 가격 변동)
```

## 출력 형식 (JSON)

```json
{
  "regime": "trending_bull",
  "confidence": 75,
  "rationale": "BTC/ETH 동반 상승 중이며 변동성 안정적",
  "duration_estimate": "단기(1-3일)",
  "key_signals": ["BTC +2.3%", "ETH +1.8%", "VIX 안정"]
}
```

## 체제 → 트레이딩 스타일 매핑

| 체제 | 스타일 | TP 배수 | SL 배수 | 포지션 크기 |
|------|--------|---------|---------|------------|
| trending_bull | aggressive | 1.3× | 1.0× | 1.2× |
| trending_bear | defensive | 0.8× | 0.7× | 0.5× |
| ranging | neutral | 0.7× | 0.7× | 0.8× |
| volatile | defensive | 1.5× | 0.5× | 0.3× |

## Shadow Mode 운영 절차

1. **1주 Shadow 운영**: 규칙 기반과 병렬 실행, `luna_regime_llm_shadow` 테이블에 비교 저장
2. **일치율 목표**: 70% 이상
3. **Promotion Gate 기준**: 일치율 ≥ 70% AND LLM 신뢰도 평균 ≥ 0.65
4. **마스터 명시 후**: `shadow_mode: false`로 전환, LLM 결과 우선 반영

## 일치율 조회 쿼리

```sql
SELECT
  market,
  COUNT(*) AS total,
  SUM(CASE WHEN match THEN 1 ELSE 0 END) AS matched,
  ROUND(AVG(CASE WHEN match THEN 1.0 ELSE 0.0 END) * 100, 1) AS match_rate_pct,
  AVG(llm_confidence) AS avg_llm_confidence
FROM investment.luna_regime_llm_shadow
WHERE captured_at >= NOW() - INTERVAL '7 days'
GROUP BY market
ORDER BY market;
```
