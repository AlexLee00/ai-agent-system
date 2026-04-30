# Health Engine Plan

## Goal

Consolidate team health reporting into a reusable core layer so that:

- team scripts share one report format
- launchd / HTTP / file / DB checks are implemented once
- Jay can route team health and unified ops health consistently
- new teams can attach health reporting without copying large scripts

## Current Shared Layers

### Report Formatting

- [health-core.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-core.js)
- [health_core.py](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health_core.py)

Shared concerns:

- report header/body/footer layout
- decision badge rendering
- count/sample section rendering
- warning aggregation into a single decision object

### Runtime / Provider Helpers

- [health-provider.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-provider.js)

Shared providers:

- `getLaunchctlStatus()`
- `buildServiceRows()`
- `buildHttpChecks()`
- `buildFileActivityHealth()`

### Health Memory Helpers

- [health-memory.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-memory.ts)
- [agent-memory.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/agent-memory.ts)

Shared concerns:

- health issue/recovery memory query building
- recent similar issue summary hints
- consolidated semantic pattern hints
- health issue/recovery episodic persistence
- episodic to semantic consolidation for recurring health signals

### DB Metric Helpers

- [health-db.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-db.js)

Shared DB adapters:

- `getPromotionPendingHealth()`
- `getPendingCommandHealth()`

### CLI Execution

- [health-runner.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health-runner.js)

Shared concerns:

- `--json` parsing
- text/json output split
- common exception handling

## Team Scripts Using The Shared Layer

- [bots/investment/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
- [bots/claude/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js)
- [dist/ts-runtime/bots/reservation/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js)
- [bots/blog/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-report.js)
- [bots/ska/src/forecast_health.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/forecast_health.py)

Health memory-enabled consumers:

- [bots/blog/scripts/health-check.ts](/Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-check.ts)
- [bots/reservation/scripts/health-check.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-check.ts)
- [bots/investment/scripts/health-check.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-check.ts)
- [bots/claude/scripts/health-check.ts](/Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-check.ts)
- [bots/hub/lib/routes/health.ts](/Users/alexlee/projects/ai-agent-system/bots/hub/lib/routes/health.ts)

## Boundary Split

### Shared Core Owns

1. Health report text structure
2. Decision severity calculation
3. Reusable count/sample sections
4. launchd service inspection
5. HTTP/JSON endpoint checks
6. file staleness checks
7. reusable DB backlog checks
8. CLI execution pattern
9. health issue/recovery memory hinting
10. health signal consolidation for recurring incidents

### Team Adapters Own

1. Which services matter
2. Which endpoints/logs matter
3. Team-specific business metrics
4. Team wording for warnings
5. Team-specific thresholds beyond shared defaults

Examples of team-specific metrics that should remain adapters:

- Luna `trade_review` integrity
- Ska forecast accuracy / tuning state
- Luna risk snapshot from local state files
- Blog daily-run freshness thresholds

## Recommended Adapter Pattern

Each team health script should aim to be structured like:

```js
async function buildTeamMetricA() { ...shared provider usage... }
async function buildTeamMetricB() { ...shared provider usage... }

function buildDecision(...) {
  return buildHealthDecision({
    warnings: [...],
    okReason: '...'
  });
}

async function buildReport() {
  return {
    metricA,
    metricB,
    decision,
  };
}
```

This keeps the script as a thin adapter instead of a second health framework.

## Jay Integration

Jay now consumes team health through direct routes:

- `/luna-health`
- `/claude-health`
- `/ska-health`
- `/blog-health`
- `/ops-health`

Unified ops health should continue to treat team scripts as JSON providers and avoid re-implementing team checks inline.

## Next Extraction Candidates

### 1. Business Metric Adapters

Potential future shared adapters:

- generic backlog metric helper
- generic recency/staleness risk helper
- generic threshold-to-recommendation helper

### 2. Unified Aggregator Helpers

Potential future extraction from Jay:

- team row prioritization
- briefing action mapping
- alert-only / summary / briefing view assembly

### 3. Python Alignment

Python health reports should keep using:

- [health_core.py](/Users/alexlee/projects/ai-agent-system/packages/core/lib/health_core.py)

and follow the same section/decision semantics as the JS side.

## Migration Rule For New Teams

When attaching a new team:

1. Create one team `health-report` script
2. Reuse shared launchd / HTTP / file / DB helpers first
3. Keep only business metrics local
4. Expose `--json`
5. Add a Jay direct route
6. Add the team to unified ops health

## Desired End State

The end state is:

- shared health engine in `packages/core`
- thin per-team adapters
- Jay as consumer/orchestrator
- one consistent health vocabulary across all teams
