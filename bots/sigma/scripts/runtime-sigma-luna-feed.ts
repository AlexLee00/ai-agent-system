#!/usr/bin/env tsx
// @ts-nocheck

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const defaultQueryReadonly = (schema, sql, params) => pgPool.queryReadonly(schema, sql, params);
const defaultRun = (schema, sql, params) => pgPool.run(schema, sql, params);

async function fetchLunaRows({ limit = 50, queryReadonly = defaultQueryReadonly } = {}) {
  const [failures, signals] = await Promise.all([
    queryReadonly('investment', `
      SELECT lfr.id, lfr.trade_id, lfr.hindsight, lfr.avoid_pattern, lfr.stage_attribution, lfr.created_at,
             tj.symbol, tj.market, tj.exchange, tj.pnl_percent, tj.strategy_family, tj.market_regime
        FROM investment.luna_failure_reflexions lfr
        LEFT JOIN investment.trade_journal tj ON tj.trade_id = lfr.trade_id::text
       WHERE lfr.created_at >= NOW() - INTERVAL '14 days'
       ORDER BY lfr.created_at DESC
       LIMIT $1
    `, [limit]).catch(() => []),
    queryReadonly('investment', `
      SELECT id, exchange, symbol, trade_mode, source, event_type, confidence, evidence_snapshot, created_at
        FROM investment.position_signal_history
       WHERE created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT $1
    `, [limit]).catch(() => []),
  ]);
  return { failures, signals };
}

function factFromFailure(row) {
  const symbol = String(row.symbol || row.avoid_pattern?.symbol || `trade:${row.trade_id}`);
  const market = String(row.market || row.avoid_pattern?.market || 'crypto');
  const fact = [
    `Luna failure reflexion for ${symbol}`,
    `market=${market}`,
    row.pnl_percent != null ? `pnl=${Number(row.pnl_percent).toFixed(2)}%` : null,
    row.strategy_family ? `strategy=${row.strategy_family}` : null,
    row.market_regime ? `regime=${row.market_regime}` : null,
    row.hindsight ? `hindsight=${String(row.hindsight).slice(0, 240)}` : null,
  ].filter(Boolean).join(' | ');
  return {
    team: 'luna',
    agentName: 'luna_rl_feedback',
    entity: symbol,
    entityType: 'trade_symbol',
    fact,
    confidence: 0.74,
    sourceEventId: row.id,
  };
}

function factFromSignal(row) {
  const symbol = String(row.symbol || 'unknown');
  return {
    team: 'luna',
    agentName: 'luna_signal_runtime',
    entity: `${row.exchange || 'unknown'}:${symbol}`,
    entityType: 'runtime_signal',
    fact: `Luna signal ${row.event_type || 'event'} for ${symbol} source=${row.source || 'unknown'} confidence=${Number(row.confidence || 0).toFixed(3)} event_id=${row.id || 'unknown'}`,
    confidence: Math.max(0.4, Math.min(0.9, Number(row.confidence || 0.5))),
    sourceEventId: null,
  };
}

async function persistFact(fact, run = defaultRun) {
  await run('sigma', `
    INSERT INTO sigma.entity_facts
      (team, agent_name, entity, entity_type, fact, confidence, source_event_id, valid_until, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '30 days',NOW())
    ON CONFLICT (team, agent_name, entity, entity_type) DO UPDATE SET
      fact = EXCLUDED.fact,
      confidence = GREATEST(sigma.entity_facts.confidence, EXCLUDED.confidence),
      source_event_id = EXCLUDED.source_event_id,
      valid_until = EXCLUDED.valid_until,
      updated_at = NOW()
  `, [fact.team, fact.agentName, fact.entity, fact.entityType, fact.fact, fact.confidence, fact.sourceEventId]);
}

export async function runSigmaLunaFeed({ limit = 50, dryRun = true, write = false, deps = {} } = {}) {
  const effectiveDryRun = dryRun !== false || write !== true;
  const queryReadonly = deps.queryReadonly || defaultQueryReadonly;
  const run = deps.run || defaultRun;
  const rows = await fetchLunaRows({ limit, queryReadonly });
  const facts = [
    ...rows.failures.map(factFromFailure),
    ...rows.signals.map(factFromSignal),
  ];
  if (!effectiveDryRun) {
    for (const fact of facts) await persistFact(fact, run);
  }
  return {
    ok: true,
    dryRun: effectiveDryRun,
    failures: rows.failures.length,
    signals: rows.signals.length,
    facts: facts.length,
    sample: facts.slice(0, 5),
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const json = process.argv.includes('--json');
  const write = process.argv.includes('--write');
  const noDryRun = process.argv.includes('--no-dry-run');
  const result = await runSigmaLunaFeed({
    limit: Math.max(1, Number(argValue('limit', '50')) || 50),
    dryRun: !noDryRun,
    write,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-luna-feed] facts=${result.facts} dryRun=${result.dryRun}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
