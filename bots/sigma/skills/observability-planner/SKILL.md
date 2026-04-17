---
name: observability-planner
description: |
  TRIGGER when: planning OTel spans for a new sigma directive type; defining
  metric collection points for sigma v2 agents; setting up alert thresholds
  for commander or pod operations.
  SKIP: non-sigma observability, infrastructure monitoring, Dexter/Archer scope.
version: "0.1.0"
license: MIT
---

# Observability Planner

Plans OpenTelemetry spans, metrics, and alert thresholds for sigma directives.
Phase 0 skeleton — production implementation in Phase 1.

## Before You Start

- Do NOT configure OTLP exporter in Phase 0 (file exporter only until Phase 2)
- Do NOT add spans that emit PII in attributes
- Span names must follow `sigma.v2.<component>.<operation>` convention

## Input Schema

```typescript
{
  directive_type: string;   // e.g. "tier2_auto_apply", "reflexion_store", "principle_check"
  team: string;
  components: string[];     // which sigma components are involved
  slo?: {                   // optional SLO targets
    latency_p99_ms: number;
    success_rate: number;
  };
}
```

## Process

1. Map directive type to component call chain
2. Define root span + child spans per component
3. Specify span attributes (no PII)
4. Define counter/histogram metrics per operation
5. Calculate alert thresholds from SLO targets
6. Return `{spans, metrics, alerts}` spec

## Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| exporter | `file` | Phase 0/1: file only. OTLP from Phase 2 |
| latency_p99_ms | `5000` | 5s default for LLM-involved spans |
| success_rate | `0.95` | 95% SLO default |
| sampling_rate | `1.0` | 100% in dev, 0.1 in prod (Phase 2) |

## Integration

Called by `Sigma.V2.Telemetry.setup/0` during application start.
Elixir module: `Sigma.V2.Skill.ObservabilityPlanner`
