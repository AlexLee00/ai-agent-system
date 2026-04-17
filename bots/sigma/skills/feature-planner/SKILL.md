---
name: feature-planner
description: |
  TRIGGER when: sigma needs to identify which team metrics are most analytically
  valuable; planning feature engineering for a new team onboarding to sigma;
  detecting feature drift in existing team analytics.
  SKIP: raw data validation, causal analysis, experiment design.
version: "0.2.0"
license: MIT
---

# feature_planner

**Elixir 모듈**: `Sigma.V2.Skill.FeaturePlanner`
**MCP 이름**: `feature_planner`
**버전**: v2 (Phase 5)

---

## Before You Start

- `features` 배열이 비어있으면 빈 결과 반환. 최소 1개 피처 필요.
- `signal`, `effort`, `leakage_risk` 모두 0~5 범위 숫자. 범위 초과 시 clamp 처리.
- 점수 공식: `signal * 2 - effort - leakage_risk`. 높을수록 우선 구현.
- `leakage_risk >= 4`인 피처는 `high_risk_features`로 별도 분류 — 자동 구현 금지 대상.
- `score >= 3` AND `effort <= 2`인 피처는 `quick_wins`로 분류 (즉시 구현 가능).
- 이 스킬은 우선순위 점수 계산만. 실제 구현 결정은 마스터 승인 필요.

---

## Input Schema

```json
{
  "type": "object",
  "required": ["features"],
  "properties": {
    "features": {
      "type": "array",
      "description": "피처 후보 목록",
      "items": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "description": "피처명" },
          "signal": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "default": 0,
            "description": "예상 비즈니스 신호 강도 (0=무의미, 5=핵심 KPI)"
          },
          "effort": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "default": 3,
            "description": "구현 난이도 (0=trivial, 5=수주 작업)"
          },
          "leakage_risk": {
            "type": "number",
            "minimum": 0,
            "maximum": 5,
            "default": 0,
            "description": "데이터 리크/편향 위험도 (0=없음, 5=즉시 중단 수준)"
          }
        }
      }
    }
  }
}
```

---

## Process

1. **각 피처 점수 산출**: `score = signal * 2 - effort - leakage_risk`.
2. **우선순위 정렬**: 점수 내림차순. 동점 시 leakage_risk 오름차순.
3. **quick_wins 분류**: `score >= 3` AND `effort <= 2`.
4. **high_risk_features 분류**: `leakage_risk >= 4`.
5. **결과 반환**: `ranked_features`(전체 정렬), `quick_wins`, `high_risk_features`.

---

## Defaults

| 파라미터 | 기본값 | 조정 기준 |
|----------|--------|-----------|
| `signal` | `0` | 반드시 팀별 KPI 영향도 기준으로 평가 |
| `effort` | `3` | 중간 난이도 기본. 구현 경험 없으면 4~5 |
| `leakage_risk` | `0` | 학습 데이터 사용 피처는 최소 2 이상 설정 |

---

## Integration

시그마 내 호출 지점:
- `Sigma.V2.Commander.decide_formation/4` — 팀별 피처 우선순위 결정 시 호출
- 다윈팀 연동: `darwin.applied.*` 이벤트 후 다음 피처 사이클에서 재평가
- MCP 엔드포인트: `POST /mcp/sigma/tools/feature_planner/call`

---

## Examples

**Good — 다양한 피처 비교**:
```json
{
  "features": [
    {"name": "자동 블로그 제목 최적화", "signal": 4, "effort": 2, "leakage_risk": 1},
    {"name": "실시간 경쟁사 모니터링", "signal": 3, "effort": 4, "leakage_risk": 0},
    {"name": "과거 데이터 재학습", "signal": 5, "effort": 1, "leakage_risk": 4}
  ]
}
// 결과:
// ranked: [자동 블로그(score=5), 실시간 경쟁사(score=2), 과거 재학습(score=1)]
// quick_wins: [자동 블로그 제목 최적화]
// high_risk: [과거 데이터 재학습]
```

**Bad — leakage_risk 미설정 (실수 방치)**:
```json
{
  "features": [
    {"name": "미래 수익 예측 피처", "signal": 5, "effort": 2}
  ]
}
// 결과: { ranked: [{score: 8}], quick_wins: [미래 수익 예측 피처], high_risk: [] }
// 경고: leakage_risk=0이지만 예측 피처는 실제로 위험할 수 있음 — 수동 검토 필요
```

**Edge — 단일 피처**:
```json
{
  "features": [{"name": "A/B 실험 자동화", "signal": 3, "effort": 3, "leakage_risk": 0}]
}
// 결과: { ranked: [{score: 3}], quick_wins: [], high_risk: [] }
// (effort=3 > 2 조건으로 quick_wins 미포함)
```

---

## Failure Modes

| 패턴 | 원인 | 대처 |
|------|------|------|
| 모든 점수가 음수 | effort + leakage_risk > signal*2 | signal 값 재검토. 비즈니스 가치 재평가 |
| high_risk가 quick_wins에 포함 | leakage_risk >= 4 && score >= 3 && effort <= 2 동시 만족 | high_risk 우선 필터링. 구현 금지 대상 확인 |
| features 빈 배열 | 상위 호출자가 피처 목록 미로드 | 호출 전 team metrics에서 피처 후보 수집 |
