---
name: data-quality-guard
description: |
  TRIGGER when: analyzing team data before sigma feedback application; validating
  data completeness, type correctness, or outlier detection for any sigma team.
  SKIP: non-sigma teams, raw data ingestion pipelines, schema migration tasks.
version: "0.1.0"
license: MIT
---

# Data Quality Guard

Validates team data against Zoi schema before sigma analysis proceeds.
Phase 0 skeleton — production implementation in Phase 1.

## Before You Start

- Do NOT use this skill for production data writes or schema changes
- Do NOT bypass quality checks even if confidence is high
- Minimum quality score of 0.6 required before analysis proceeds

## Input Schema

```typescript
{
  team: string;          // target team name (luna, ska, blo, worker, etc.)
  data: Record<string, unknown>;  // team metrics snapshot
  strict?: boolean;      // default: false — if true, any warning blocks analysis
}
```

## Process

1. Load Zoi schema for the specified team from `config/sigma_principles.yaml`
2. Check required fields presence
3. Validate types and value ranges
4. Detect outliers (> 3σ from 30-day baseline)
5. Calculate quality score (0.0–1.0)
6. Return `{quality_score, issues, approved}`

## Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| `strict` | `false` | Soft mode: warnings don't block |
| min_quality | `0.6` | Below this, analysis is blocked |
| outlier_sigma | `3.0` | Standard deviations for outlier detection |

## Integration

Called by `Sigma.V2.Commander` before dispatching to any Pod.
Elixir module: `Sigma.V2.Skill.DataQualityGuard`
