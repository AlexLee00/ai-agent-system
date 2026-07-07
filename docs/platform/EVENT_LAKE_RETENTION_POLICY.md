# Event Lake Retention Policy

## Current Finding

`agent.event_lake` is dominated by high-frequency TradingView candle events:
`luna.tv.bar.<symbol>.<timeframe>`. These rows are operational evidence, but they
are also time-series market data and should not live indefinitely in the general
event audit table.

Default retention policy implemented in `scripts/runtime-event-lake-retention.ts`:

- `luna.tv.bar.%`: 30 days
- all other event types: 90 days
- deletion requires both `--apply` and `EVENT_LAKE_RETENTION_ENABLED=true`
- archive is external gzip CSV under `/Volumes/DATA/migrated/archives/event_lake`

## Query Window Audit

| Consumer | Current Window | Evidence |
|---|---|---|
| Luna scout | No event_lake read window; writes `scout_error` only on non-dry failure | `bots/investment/team/scout.ts:316-322`, `bots/investment/team/scout.ts:383-400` |
| Luna bottleneck operator | Default 6h report window, with delegated reports spanning 6h/24h/7d | `bots/investment/scripts/runtime-luna-bottleneck-autonomy-operator.ts:17`, `bots/investment/scripts/runtime-luna-bottleneck-autonomy-operator.ts:494-515` |
| Luna health report | 6h over `port_agent_*` investment runtime events | `bots/investment/scripts/health-report.ts:300-319` |
| KIS overseas funnel trace | Default 168h over Luna/investment/kis_overseas event rows | `bots/investment/scripts/runtime-kis-overseas-funnel-trace.ts:8`, `bots/investment/scripts/runtime-kis-overseas-funnel-trace.ts:171-186` |
| Claude commander | No event_lake read window in commander; writes legacy approval/rejection audit events | `bots/claude/src/claude-commander.ts:771-800` |

The longest identified hot operational read window is 168h. The 30-day bar
retention floor gives a large safety margin for Luna health, bottleneck, and
funnel diagnostics while stopping unbounded candle growth.

## Follow-Up Recommendation: Split `tv.bar`

Move `luna.tv.bar.%` out of the general event lake into a dedicated time-series
store. Two reasonable follow-up designs:

- PostgreSQL partitioned table keyed by `symbol`, `timeframe`, and day/month.
- External compressed columnar/file archive for candle replay, with only summary
  pointers kept in `event_lake`.

Do not implement this split inside the retention job. The current job only
reports, archives, and optionally deletes already-aged rows under a master gate.
