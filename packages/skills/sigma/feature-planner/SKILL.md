---
name: feature-planner
description: |
  TRIGGER when: sigma needs to identify which team metrics are most analytically
  valuable; planning feature engineering for a new team onboarding to sigma;
  detecting feature drift in existing team analytics.
  SKIP: raw data validation, causal analysis, experiment design.
version: "0.1.0"
license: MIT
---

# Feature Planner

Plans feature engineering and prioritization for sigma team analytics.
Phase 0 skeleton — production implementation in Phase 1.

## Before You Start

- Do NOT create features that require PII fields (names, phone numbers)
- Do NOT plan features requiring real-time data if team is batch-only
- Max 20 features per team to avoid curse of dimensionality

## Input Schema

```typescript
{
  team: string;
  available_metrics: string[];   // list of metric names available in DB
  analysis_goal?: string;        // e.g. "predict weekly revenue drop"
  exclude_pii?: boolean;         // default: true
}
```

## Process

1. Filter out PII and unstable metrics
2. Score each metric by: variance, completeness, predictive proxy likelihood
3. Detect feature correlations (drop if r > 0.9 with higher-ranked feature)
4. Rank by importance score
5. Define drift detection thresholds per feature
6. Return ranked feature list with drift specs

## Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| `exclude_pii` | `true` | Always filter PII fields |
| max_features | `20` | Hard cap |
| min_completeness | `0.8` | Drop metrics with > 20% missing |
| correlation_drop_threshold | `0.9` | Remove redundant features |

## Integration

Called by `Sigma.V2.Pod.Growth` (librarian analyst) during onboarding.
Elixir module: `Sigma.V2.Skill.FeaturePlanner`
