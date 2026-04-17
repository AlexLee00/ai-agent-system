---
name: experiment-design
description: |
  TRIGGER when: sigma proposes a Tier 2 feedback change that needs A/B experiment
  validation; designing statistical tests for team configuration changes.
  SKIP: Tier 0/1 runs, pure observation, data quality checks, causal analysis.
version: "0.1.0"
license: MIT
---

# Experiment Design

Designs A/B experiments to validate proposed sigma feedback before full rollout.
Phase 0 skeleton — production implementation in Phase 1.

## Before You Start

- Do NOT design experiments for Tier 3 changes (requires master approval, no auto-experiment)
- Do NOT use this for changes affecting financial transactions (luna team)
- Minimum experiment duration: 7 days unless `fast_mode: true`

## Input Schema

```typescript
{
  team: string;
  change_description: string;    // what configuration change is being tested
  target_metric: string;         // primary success metric
  secondary_metrics?: string[];
  fast_mode?: boolean;           // default: false — reduces min duration to 3 days
  effect_size?: number;          // expected relative improvement (default: 0.1 = 10%)
}
```

## Process

1. Define null/alternative hypothesis
2. Calculate required sample size (power=0.8, α=0.05)
3. Estimate experiment duration based on daily traffic
4. Define success/failure criteria
5. Specify rollback trigger (if metric degrades > threshold)
6. Return experiment spec as structured plan

## Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| `effect_size` | `0.1` | 10% relative improvement |
| `alpha` | `0.05` | Type I error rate |
| `power` | `0.80` | Statistical power |
| min_duration_days | `7` | Reduced to 3 in fast_mode |

## Integration

Called by `Sigma.V2.Commander` when CausalCheck score ≥ 0.4 and tier = 2.
Elixir module: `Sigma.V2.Skill.ExperimentDesign`
