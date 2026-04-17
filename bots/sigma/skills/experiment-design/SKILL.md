---
name: experiment-design
description: |
  TRIGGER when: sigma proposes a Tier 2 feedback change that needs A/B experiment
  validation; designing statistical tests for team configuration changes.
  SKIP: Tier 0/1 runs, pure observation, data quality checks, causal analysis.
version: "0.2.0"
license: MIT
---

# experiment_design

**Elixir 모듈**: `Sigma.V2.Skill.ExperimentDesign`
**MCP 이름**: `experiment_design`
**버전**: v2 (Phase 5)

---

## Before You Start

- `hypothesis`는 측정 가능한 형태여야 함. "개선될 것이다" → "클릭률이 5% 이상 증가할 것이다"로 구체화.
- `primary_metric` + `baseline`이 없으면 샘플 사이즈 계산이 불가능 — 권고사항만 반환.
- `variants`에 control(대조군)이 포함되어야 함 (예: `["control", "variant_a"]`). 없으면 설계 점수 감점.
- 최소 탐지 효과(`min_detectable_effect`)는 baseline 대비 상대적 변화율로 전달 (0.05 = 5% 향상).
- 이 스킬은 설계 점수와 권고만 반환. 실제 실험 실행은 별도 프로세스.

---

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "hypothesis": {
      "type": "string",
      "description": "검증 가설 (측정 가능한 형태)"
    },
    "primary_metric": {
      "type": "string",
      "description": "1차 성과 지표명 (예: 'click_through_rate')"
    },
    "baseline": {
      "type": "number",
      "description": "현재 primary_metric 기준값"
    },
    "variants": {
      "type": "array",
      "items": { "type": "string" },
      "description": "실험 변종 목록 (control 포함 권장)"
    },
    "min_detectable_effect": {
      "type": "number",
      "description": "감지할 최소 효과 크기 (baseline 대비 상대값, 예: 0.05)"
    },
    "guardrails": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "실험 중단 조건 지표 목록 (예: 'error_rate', 'revenue')"
    }
  }
}
```

---

## Process

1. **가설 명확성 체크**: `hypothesis`에 측정 기준어("증가", "감소", "%", "이상", "이하")가 없으면 명확성 flag.
2. **control 포함 여부 체크**: `variants`에 "control"이 없으면 경고 추가.
3. **샘플 사이즈 추정**: `baseline`과 `min_detectable_effect`가 있으면 통계 공식으로 그룹당 최소 샘플 수 계산 (α=0.05, β=0.2).
4. **guardrail 체크**: `guardrails`가 비어있으면 guardrail 부재 경고.
5. **설계 점수 산출**: 명확한 가설(+3), control 포함(+2), 샘플 계산 가능(+2), guardrail 존재(+3) → 10점 만점.
6. **권고사항 생성**: 각 부족한 항목에 대한 구체적 개선 권고 반환.

---

## Defaults

| 파라미터 | 기본값 | 조정 기준 |
|----------|--------|-----------|
| `guardrails` | `[]` | 최소 1개 (error_rate 권장) |
| `min_detectable_effect` | 없음 | 비즈니스적 의미있는 최소 변화율 설정 |
| `variants` | 없음 | control + 1~2개 variant가 일반적 |

---

## Integration

시그마 내 호출 지점:
- `Sigma.V2.Commander` — Tier 2 변경 적용 전 실험 설계 검증
- `causal_check`와 연계: 가설 인과성 검증 → 실험 설계 순서
- MCP 엔드포인트: `POST /mcp/sigma/tools/experiment_design/call`

---

## Examples

**Good — 완전한 실험 설계**:
```json
{
  "hypothesis": "블로그 제목 A/B 테스트 시 클릭률이 10% 이상 증가할 것이다",
  "primary_metric": "click_through_rate",
  "baseline": 0.035,
  "variants": ["control", "title_variant_a", "title_variant_b"],
  "min_detectable_effect": 0.10,
  "guardrails": ["bounce_rate", "session_duration"]
}
// 결과: { design_score: 10, recommended_sample_per_group: 1847, issues: [] }
```

**Bad — 측정 불가능한 가설**:
```json
{
  "hypothesis": "더 나은 결과가 나올 것이다",
  "variants": ["variant_a"]
}
// 결과: { design_score: 0, issues: ["vague_hypothesis", "missing_control", "no_guardrails"] }
```

**Edge — baseline 없는 설계**:
```json
{
  "hypothesis": "신규 기능 도입 시 DAU가 5% 이상 증가할 것이다",
  "primary_metric": "dau",
  "variants": ["control", "new_feature"],
  "guardrails": ["error_rate"]
}
// 결과: { design_score: 8, recommended_sample_per_group: null, warnings: ["baseline_missing_for_sample_calc"] }
```

---

## Failure Modes

| 패턴 | 원인 | 대처 |
|------|------|------|
| `design_score: 0` | 모든 필드 누락 | 최소 hypothesis + variants 제공 |
| 샘플 수 null | baseline 또는 min_detectable_effect 미제공 | 두 파라미터 모두 제공 |
| control 경고 반복 | variants에 "control" 문자열 미포함 | variants 배열에 "control" 추가 |
