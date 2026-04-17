# observability_planner

**Elixir 모듈**: `Sigma.V2.Skill.ObservabilityPlanner`
**MCP 이름**: `observability_planner`
**버전**: v2 (Phase 5)

---

## Before You Start

- 이 스킬은 OTel(OpenTelemetry) 관찰가능성 계획을 생성. 실제 메트릭 수집 설정은 별도.
- `existing_metrics`가 없으면 기본 3개(latency, error_rate, throughput)를 모두 신규 추가로 권고.
- `alert_channels`가 비어있으면 알람 채널 없음 경고. 최소 1개 설정 강력 권고.
- 반환되는 `recommended_metrics`는 추가 권고 목록 (기존 메트릭과 중복 제거됨).
- 이상 감지 패턴(`anomaly_patterns`)은 팀 특성에 따라 조정 필요 — 기본값은 최소한의 커버리지.

---

## Input Schema

```json
{
  "type": "object",
  "properties": {
    "service": {
      "type": "string",
      "description": "모니터링 대상 서비스/팀명 (예: 'blog', 'luna', 'sigma')"
    },
    "existing_metrics": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "현재 수집 중인 메트릭명 목록"
    },
    "alert_channels": {
      "type": "array",
      "items": { "type": "string" },
      "default": [],
      "description": "알람 수신 채널 목록 (예: ['telegram', 'webhook'])"
    },
    "slo_targets": {
      "type": "object",
      "description": "SLO 목표값 (예: {latency_p99_ms: 500, error_rate_pct: 1.0})"
    }
  }
}
```

---

## Process

1. **기본 메트릭 갭 분석**: `["latency_p99", "error_rate", "throughput_rps"]` 중 `existing_metrics`에 없는 항목 식별.
2. **서비스별 추가 메트릭 권고**: `service` 이름 기반으로 도메인 특화 메트릭 추가 (blog→seo_score, luna→position_accuracy 등).
3. **알람 규칙 생성**: 각 기본 메트릭에 대해 임계값 기반 알람 규칙 생성. `slo_targets`가 있으면 해당 값 사용.
4. **이상 감지 패턴 목록화**: `data_stale`, `cost_spike`, `quality_drop` 3종 기본 패턴 + 서비스 특화 패턴.
5. **커버리지 점수 산출**: 기본 메트릭 커버리지(50%) + 알람 설정(30%) + SLO 정의(20%) 가중 합산.
6. **결과 반환**: `recommended_metrics`, `alert_rules`, `anomaly_patterns`, `coverage_score`.

---

## Defaults

| 파라미터 | 기본값 | 조정 기준 |
|----------|--------|-----------|
| `existing_metrics` | `[]` | 현재 n8n / launchd 수집 항목 파악 후 입력 |
| `alert_channels` | `[]` | 최소 telegram 또는 webhook 1개 |
| `slo_targets` | 없음 | 비즈니스 요구사항 기준으로 정의 |

---

## Integration

시그마 내 호출 지점:
- `Sigma.V2.Commander.analyze_formation/2` — 팀 관찰가능성 갭 분석 단계
- 클로드팀 모니터링 설정 시 연계 (덱스터/아처/닥터 설정 권고)
- MCP 엔드포인트: `POST /mcp/sigma/tools/observability_planner/call`

---

## Examples

**Good — 서비스 + SLO 포함**:
```json
{
  "service": "luna",
  "existing_metrics": ["latency_p99", "error_rate"],
  "alert_channels": ["telegram", "webhook"],
  "slo_targets": {
    "latency_p99_ms": 300,
    "error_rate_pct": 0.5
  }
}
// 결과:
// recommended_metrics: ["throughput_rps", "position_accuracy", "trade_slippage"]
// alert_rules: [{metric: "latency_p99", threshold: 300, channel: "telegram"}, ...]
// coverage_score: 85
```

**Bad — 빈 상태에서 시작**:
```json
{ "service": "blog" }
// 결과:
// recommended_metrics: ["latency_p99", "error_rate", "throughput_rps", "seo_score", "publish_rate"]
// alert_rules: [] (alert_channels 미설정)
// warnings: ["no_alert_channels", "no_slo_targets"]
// coverage_score: 20
```

**Edge — 모든 기본 메트릭 이미 존재**:
```json
{
  "service": "sigma",
  "existing_metrics": ["latency_p99", "error_rate", "throughput_rps"],
  "alert_channels": ["webhook"]
}
// 결과:
// recommended_metrics: ["directive_apply_rate", "reflexion_count", "tier2_rollback_rate"]
// coverage_score: 65 (SLO 미정의로 감점)
```

---

## Failure Modes

| 패턴 | 원인 | 대처 |
|------|------|------|
| `coverage_score` 낮음 | alert_channels + slo_targets 미설정 | 두 파라미터 추가 후 재호출 |
| 서비스 특화 메트릭 없음 | `service` 미제공 또는 알 수 없는 서비스명 | service 파라미터 정확히 전달 (blog/luna/ska/sigma 등) |
| 알람 규칙 비어있음 | alert_channels 빈 배열 | 최소 ["telegram"] 설정 |
