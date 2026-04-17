---
name: causal-check
description: |
  TRIGGER when: a sigma analyst proposes a feedback change and causal validity
  needs verification before Tier 2 auto-application; distinguishing correlation
  from causation in team metric changes.
  SKIP: Tier 0/1 observation-only runs, data ingestion, non-sigma contexts.
version: "0.1.0"
license: MIT
---

# Causal Check

Verifies causal validity of proposed feedback before sigma auto-applies it.
Phase 0 skeleton — production implementation in Phase 1.

## Before You Start

- Do NOT approve feedback with causal score < 0.4 for Tier 2 application
- Do NOT skip this check even when analyst confidence is high
- External confounds (market conditions, holidays) must be documented

## Input Schema

```typescript
{
  team: string;
  hypothesis: string;           // e.g. "Increasing post frequency → more reservations"
  supporting_data: {
    before_period: DateRange;
    after_period: DateRange;
    metrics: Record<string, number[]>;
  };
  known_confounds?: string[];   // optional list of known external factors
}
```

## Process

1. Parse hypothesis into (cause, effect) pair
2. Check temporal precedence (cause before effect)
3. Check covariation (corr > 0.5 threshold)
4. Evaluate plausible confounds from `known_confounds` + calendar events
5. Calculate causal score (0.0–1.0)
6. Return `{causal_score, confounds_found, recommendation}`

## Defaults

| Parameter | Default | Notes |
|-----------|---------|-------|
| min_causal_score_tier2 | `0.4` | Below this, demote to Tier 1 |
| correlation_threshold | `0.5` | Minimum Pearson r |
| lookback_days | `30` | Baseline window |

## Integration

Called by `Sigma.V2.Commander` after DataQualityGuard passes.
Elixir module: `Sigma.V2.Skill.CausalCheck`
