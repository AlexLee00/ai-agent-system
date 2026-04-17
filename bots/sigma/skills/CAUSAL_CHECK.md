# causal_check

**Elixir 모듈**: `Sigma.V2.Skill.CausalCheck`
**MCP 이름**: `causal_check`
**버전**: v2 (Phase 5)

---

## Before You Start

- 상관관계만으로 인과관계를 주장하는 피드백을 적용 전에 반드시 통과시킬 것.
- `correlation > 0.7`이고 `controls`가 비어있으면 자동으로 high risk 판정.
- `sample_size < 30`이면 통계적 신뢰도 부족 flag 추가.
- 이 스킬은 피드백 *적용 전* 검증용. 피드백이 이미 적용된 후에는 의미 없음.
- `claim`을 빈 문자열로 보내면 모든 체크를 우회하지 않음 — 기타 파라미터로 독립 평가.

---

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "claim": {
      "type": "string",
      "default": "",
      "description": "검증할 인과 주장 (예: '블로그 발행량 증가 → 매출 상승')"
    },
    "correlation": {
      "type": "number",
      "default": 0.0,
      "description": "관측된 Pearson 상관계수 (-1.0 ~ 1.0)"
    },
    "controls": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "통제된 변수 목록 (적을수록 위험)"
    },
    "confounders": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "알려진 혼재변수 (있으면 위험도 상승)"
    },
    "sample_size": {
      "type": "integer",
      "default": 0,
      "description": "분석에 사용된 샘플 수"
    }
  }
}
```

---

## Process

1. **상관 강도 + 통제 체크**: `|correlation| > 0.7` AND `controls` 비어있으면 `strong_correlation_no_controls` flag.
2. **소표본 체크**: `sample_size > 0` AND `sample_size < 30` 이면 `insufficient_sample_size` flag.
3. **혼재변수 체크**: `confounders` 비어있지 않으면 `known_confounders_present` flag.
4. **위험도 점수 산출**: flag 수 × 2. 6 이상 → `high`, 3~5 → `medium`, 0~2 → `low`.
5. **권고사항 생성**: 각 flag에 대응하는 구체적 개선 권고 목록 반환.
6. **결과 반환**: `causal_risk`, `flags`, `recommendations`, `risk_score`.

---

## Defaults

| 파라미터 | 기본값 | 조정 기준 |
|----------|--------|-----------|
| `correlation` | `0.0` | 실제 통계값 사용. 추정치도 가능 |
| `controls` | `[]` | 분석 시 통제한 변수 모두 나열 |
| `sample_size` | `0` | 0이면 소표본 체크 스킵 |

---

## Integration

시그마 내 호출 지점:
- `Sigma.V2.Commander` — Directive 생성 전 인과성 검증 단계에서 호출
- `Sigma.V2.Skill.ExperimentDesign` — 실험 설계 전 선행 인과 가정 검증 시 연계
- MCP 엔드포인트: `POST /mcp/sigma/tools/causal_check/call`

---

## Examples

**Good — 잘 통제된 분석**:
```json
{
  "claim": "블로그 SEO 개선 → 오가닉 트래픽 증가",
  "correlation": 0.82,
  "controls": ["계절성", "광고비", "경쟁사 액티비티"],
  "confounders": [],
  "sample_size": 180
}
// 결과: { causal_risk: "low", flags: [], risk_score: 0 }
```

**Bad — 통제 없는 강한 상관**:
```json
{
  "claim": "투자 수익률 → 팀원 사기 향상",
  "correlation": 0.91,
  "controls": [],
  "confounders": ["시장 상황", "팀 이벤트"],
  "sample_size": 12
}
// 결과: { causal_risk: "high", flags: ["strong_correlation_no_controls", "insufficient_sample_size", "known_confounders_present"], risk_score: 6 }
```

**Edge — 파라미터 최소화**:
```json
{ "correlation": 0.5 }
// 결과: { causal_risk: "low", flags: [], risk_score: 0 }
// (상관 0.5 < 0.7 임계값, controls 체크 미발동)
```

---

## Failure Modes

| 패턴 | 원인 | 대처 |
|------|------|------|
| 항상 low risk 반환 | `correlation` 0.7 미만 + controls 없음 | 상관계수 재확인. 실제 correlation 값 전달 |
| `high` risk인데 적용 강행 | Commander의 Principle.Loader 우선 체크 건너뜀 | self_critique → causal_check 순서 보장 확인 |
| flag 없는데 실제 문제 | confounders 목록 누락 | 도메인 전문가 리뷰 후 confounders 명시 |
