---
name: data-quality-guard
description: |
  TRIGGER when: analyzing team data before sigma feedback application; validating
  data completeness, type correctness, or outlier detection for any sigma team.
  SKIP: non-sigma teams, raw data ingestion pipelines, schema migration tasks.
version: "0.2.0"
license: MIT
---

# data_quality_guard

**Elixir 모듈**: `Sigma.V2.Skill.DataQualityGuard`
**MCP 이름**: `data_quality_guard`
**버전**: v2 (Phase 5)

---

## Before You Start

- 빈 배열(`rows: []`)로 호출하면 즉시 `passed: false, quality_score: 0` 반환. 데이터 없이 호출 금지.
- `required_fields`를 지정하지 않으면 필수 필드 누락 검사가 수행되지 않음.
- `freshness_field`는 ISO 8601 datetime 문자열 또는 Unix ms timestamp 값이어야 함. 다른 포맷은 stale로 간주.
- `numeric_fields` 없이 이상값 감지를 기대하지 말 것.
- 이 스킬은 읽기 전용. 데이터를 수정하지 않고 품질 점수와 이슈 목록만 반환.

---

## Input Schema

```json
{
  "type": "object",
  "required": ["rows"],
  "properties": {
    "rows": {
      "type": "array",
      "description": "검사할 데이터 로우 목록 (JSON 오브젝트 배열)"
    },
    "required_fields": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "반드시 존재해야 하는 필드명 목록"
    },
    "freshness_field": {
      "type": "string",
      "description": "신선도 체크에 사용할 타임스탬프 필드명 (선택)"
    },
    "freshness_threshold_days": {
      "type": "integer",
      "default": 7,
      "description": "N일 이상 오래된 데이터를 stale로 판정"
    },
    "numeric_fields": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "이상값(outlier) 감지를 적용할 수치 필드명 목록"
    }
  }
}
```

---

## Process

1. **중복 검사**: 각 로우를 JSON 직렬화 → 해시 비교. 동일 해시 로우 수를 `duplicate_rows`로 집계.
2. **누락 검사**: `required_fields` 각 항목에 대해 `null | ""` 로우 수 집계. 필드별 개수로 이슈 분리.
3. **신선도 검사**: `freshness_field` 지정 시, 현재 시각 기준 `freshness_threshold_days` 초과 로우를 `stale_rows`로 집계.
4. **이상값 감지**: `numeric_fields` 각 필드에 대해 median 계산 → `|value - median| > max(10, |median| * 5)` 조건으로 outlier 판정.
5. **품질 점수 산출**: `10 - (dup*0.6) - (missing*0.8) - (stale*0.7) - (outlier*0.4)` 공식. 최솟값 0.
6. **결과 반환**: `passed` (issues 없으면 true), `quality_score`, `issues` 목록, `stats` 집계.

---

## Defaults

| 파라미터 | 기본값 | 조정 기준 |
|----------|--------|-----------|
| `required_fields` | `[]` | 비즈니스 로직상 필수 컬럼만 포함 |
| `freshness_threshold_days` | `7` | 일일 업데이트 데이터는 1~2일, 주간은 7~14일 |
| `numeric_fields` | `[]` | 수치형 KPI 컬럼만 포함 (범주형 제외) |

---

## Integration

시그마 내 호출 지점:
- `Sigma.V2.Commander.analyze_formation/2` — 팀 메트릭 데이터 수집 후 품질 검증 시 1순위 호출
- MCP 엔드포인트: `POST /mcp/sigma/tools/data_quality_guard/call` (Bearer 인증 필요)
- Claude Code에서 직접 호출: `data_quality_guard skill로 이 데이터 검증해줘`

---

## Examples

**Good — 정상 데이터셋**:
```json
{
  "rows": [
    {"id": 1, "name": "Alice", "score": 85, "updated_at": "2026-04-17T00:00:00Z"},
    {"id": 2, "name": "Bob", "score": 90, "updated_at": "2026-04-16T00:00:00Z"}
  ],
  "required_fields": ["id", "name"],
  "freshness_field": "updated_at",
  "freshness_threshold_days": 7,
  "numeric_fields": ["score"]
}
// 결과: { passed: true, quality_score: 10.0, issues: [] }
```

**Bad — 중복 + 누락 혼재**:
```json
{
  "rows": [
    {"id": 1, "name": "Alice"},
    {"id": 1, "name": "Alice"},
    {"id": 3, "name": null}
  ],
  "required_fields": ["id", "name"]
}
// 결과: { passed: false, quality_score: 6.4, issues: [{type:"duplicate",...}, {type:"missing_required",...}] }
```

**Edge — 빈 배열**:
```json
{ "rows": [] }
// 결과: { passed: false, quality_score: 0, issues: [{type:"empty_dataset"}] }
```

---

## Failure Modes

| 패턴 | 원인 | 대처 |
|------|------|------|
| 모든 로우가 stale | `freshness_field` 포맷 불일치 (비ISO 8601) | 필드값을 ISO 8601 또는 Unix ms로 변환 후 재호출 |
| `quality_score`가 음수 | 이슈 패널티 합산 초과 (0으로 clamp됨) | 정상 동작. 심각한 품질 문제 의미 |
| `required_fields` 무시됨 | 파라미터 키가 문자열이 아닌 atom으로 전달 | MCP 경유 시 자동 변환. 직접 Elixir 호출 시 atom 키 사용 |
| outlier 감지 안 됨 | `numeric_fields` 미지정 또는 값이 모두 null | 필드명 확인 후 재호출 |
