#!/usr/bin/env node
// @ts-nocheck
/**
 * One-off Luna feedback-loop gap backfill.
 *
 * Scope: learning-only tables. No order, position, launchd, or trading writes.
 * Default is dry-run; writes require --write --confirm=luna-feedback-gap-backfill.
 */

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query, run, close } from '../shared/db/core.ts';
import { learningPnlValidSql } from '../shared/trade-journal-learning-guard.ts';
import { createHash } from 'node:crypto';

const REQUIRED_CONFIRM = 'luna-feedback-gap-backfill';
const MAPPER_ID = 'luna_feedback_gap_backfill_20260609';
const DEFAULT_FROM = '2026-05-28';
const DEFAULT_TO = '2026-06-09';

function parseArgs(argv = process.argv.slice(2)) {
  const getValue = (name, fallback = null) => {
    const prefix = `${name}=`;
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
    return fallback;
  };
  return {
    json: argv.includes('--json'),
    write: argv.includes('--write'),
    confirm: getValue('--confirm'),
    from: getValue('--from', DEFAULT_FROM),
    to: getValue('--to', DEFAULT_TO),
    market: getValue('--market', 'all'),
    limit: Math.max(1, Number(getValue('--limit', process.env.LUNA_FEEDBACK_GAP_BACKFILL_LIMIT || '1000')) || 1000),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pnlPercentOf(row) {
  const explicit = Number(row.pnl_percent);
  if (Number.isFinite(explicit)) return explicit;
  const amount = safeNumber(row.pnl_net ?? row.pnl_amount, 0);
  const entryValue = Math.abs(safeNumber(row.entry_value, 0));
  if (entryValue > 0) return (amount / entryValue) * 100;
  return amount === 0 ? 0 : amount > 0 ? 1 : -1;
}

function buildLearningTradeId(row) {
  const raw = String(row.trade_id || '');
  if (/^\d+$/.test(raw)) return { tradeId: raw, synthetic: false, originalTradeId: raw };
  const source = `trade_journal:${raw}:${row.market || ''}:${row.exchange || ''}:${row.symbol || ''}`;
  const hex = createHash('sha256').update(source).digest('hex').slice(0, 15);
  const value = (BigInt(`0x${hex}`) % 8_000_000_000_000n) + 3_000_000_000n;
  return { tradeId: `-${value.toString()}`, synthetic: true, originalTradeId: raw };
}

function classifyTrade(row) {
  const pnlPct = pnlPercentOf(row);
  const pnlNet = safeNumber(row.pnl_net ?? row.pnl_amount, 0);
  const loss = pnlPct < 0 || pnlNet < 0;
  const parameterName = loss ? 'luna.entry.min_confidence_delta' : 'luna.entry.confidence_relax_shadow';
  const actionType = loss ? 'entry_threshold_tighten' : 'entry_threshold_relax_shadow';
  const magnitude = clamp(Math.abs(pnlPct) * 0.0025, 0.005, 0.15);
  return {
    pnlPct,
    pnlNet,
    loss,
    parameterName,
    actionType,
    contribution: clamp(pnlPct / 10, -1, 1),
    decisionScore: clamp(loss ? 0.5 - Math.abs(pnlPct) / 50 : 0.5 + Math.abs(pnlPct) / 50, 0.05, 0.95),
    newValue: loss
      ? { direction: 'increase', delta: Number(magnitude.toFixed(4)), ttlDays: 21, source: 'gap_backfill' }
      : { direction: 'decrease', delta: Number((magnitude / 2).toFixed(4)), ttlDays: 14, source: 'gap_backfill' },
  };
}

async function fetchEligibleTrades({ from, to, market, limit }) {
  const params = [from, to, limit];
  let marketClause = '';
  if (market && market !== 'all') {
    params.push(market);
    marketClause = `AND tj.market = $${params.length}`;
  }
  return query(
    `SELECT
       tj.trade_id,
       tj.market,
       tj.exchange,
       tj.symbol,
       tj.direction,
       tj.trade_mode,
       tj.entry_value,
       tj.pnl_percent,
       tj.pnl_amount,
       tj.pnl_net,
       tj.exit_reason,
       tj.market_regime,
       tj.strategy_family,
       tj.hold_duration,
       to_timestamp(tj.exit_time / 1000.0) AS exited_at
     FROM investment.trade_journal tj
     WHERE tj.exit_time IS NOT NULL
       AND COALESCE(tj.is_paper, false) = false
       AND COALESCE(tj.exclude_from_learning, false) = false
       AND COALESCE(tj.quality_flag, 'trusted') <> 'excluded'
       AND to_timestamp(tj.exit_time / 1000.0) >= $1::date
       AND to_timestamp(tj.exit_time / 1000.0) < ($2::date + INTERVAL '1 day')
       AND ${learningPnlValidSql('tj')}
       ${marketClause}
     ORDER BY tj.exit_time ASC
     LIMIT $3::int`,
    params,
  );
}

async function persistAttribution(row, classification, context) {
  const key = buildLearningTradeId(row);
  const evidence = {
    mapper: MAPPER_ID,
    source: 'feedback_loop_gap_backfill',
    learningTradeId: key.tradeId,
    originalTradeId: key.originalTradeId,
    syntheticTradeId: key.synthetic,
    from: context.from,
    to: context.to,
    symbol: row.symbol,
    market: row.market,
    exchange: row.exchange,
    pnlPct: Number(classification.pnlPct.toFixed(4)),
    pnlNet: Number(classification.pnlNet.toFixed(4)),
    exitReason: row.exit_reason || null,
    exitedAt: row.exited_at || null,
    shadowOnly: true,
  };
  return run(
    `INSERT INTO investment.trade_decision_attribution
       (trade_id, stage_id, decision_type, decision_score, contribution_to_outcome, evidence, created_at)
     VALUES ($1::bigint, 'feedback_gap_backfill', 'posttrade_learning_gap_backfill', $2, $3, $4::jsonb, NOW())
     ON CONFLICT (trade_id, stage_id) DO NOTHING`,
    [
      key.tradeId,
      Number(classification.decisionScore.toFixed(3)),
      Number(classification.contribution.toFixed(4)),
      JSON.stringify(evidence),
    ],
  );
}

async function persistFailureReflexion(row, classification, context) {
  if (!classification.loss) return { rowCount: 0, skipped: true };
  const key = buildLearningTradeId(row);
  const fiveWhy = [
    { q: 'Why did this trade enter backfill?', a: 'Daily Luna feedback loop was orphaned during the gap window.' },
    { q: 'Why is it learnable?', a: `Closed non-paper trade with pnlPct=${classification.pnlPct.toFixed(4)}.` },
    { q: 'Which context matters?', a: `${row.market}/${row.exchange}/${row.symbol} regime=${row.market_regime || 'unknown'}.` },
    { q: 'What should change?', a: 'Treat as shadow feedback until the normal feedback loop confirms repeated evidence.' },
    { q: 'What is protected?', a: 'Backfill writes learning rows only and never changes live trading state.' },
  ];
  const stageAttribution = {
    mapper: MAPPER_ID,
    source: 'feedback_loop_gap_backfill',
    learningTradeId: key.tradeId,
    originalTradeId: key.originalTradeId,
    syntheticTradeId: key.synthetic,
    from: context.from,
    to: context.to,
    pnlPct: Number(classification.pnlPct.toFixed(4)),
    pnlNet: Number(classification.pnlNet.toFixed(4)),
    exitReason: row.exit_reason || null,
    strategyFamily: row.strategy_family || null,
  };
  const avoidPattern = {
    symbol: row.symbol,
    market: row.market,
    exchange: row.exchange,
    regime: row.market_regime || null,
    strategyFamily: row.strategy_family || null,
    avoid_action: 'shadow_review_before_repeat_entry',
    reason: 'feedback_loop_gap_backfill_loss',
    evidence: {
      pnlPct: Number(classification.pnlPct.toFixed(4)),
      pnlNet: Number(classification.pnlNet.toFixed(4)),
    },
  };
  return run(
    `INSERT INTO investment.luna_failure_reflexions
       (trade_id, five_why, stage_attribution, hindsight, avoid_pattern, created_at)
     VALUES ($1::bigint, $2::jsonb, $3::jsonb, $4, $5::jsonb, NOW())
     ON CONFLICT (trade_id) DO NOTHING`,
    [
      key.tradeId,
      JSON.stringify(fiveWhy),
      JSON.stringify(stageAttribution),
      `${row.symbol} gap backfill loss: pnlPct=${classification.pnlPct.toFixed(4)}. Normal Luna feedback jobs should re-evaluate before repeated entry.`,
      JSON.stringify(avoidPattern),
    ],
  );
}

async function persistFeedbackAction(row, classification, context) {
  const key = buildLearningTradeId(row);
  const metadata = {
    mapper: MAPPER_ID,
    source: 'feedback_loop_gap_backfill',
    learningTradeId: key.tradeId,
    originalTradeId: key.originalTradeId,
    syntheticTradeId: key.synthetic,
    from: context.from,
    to: context.to,
    symbol: row.symbol,
    market: row.market,
    exchange: row.exchange,
    tradeMode: row.trade_mode || null,
    pnlPct: Number(classification.pnlPct.toFixed(4)),
    pnlNet: Number(classification.pnlNet.toFixed(4)),
    actionType: classification.actionType,
    regime: row.market_regime || null,
    strategyFamily: row.strategy_family || null,
    shadowOnly: true,
  };
  return run(
    `INSERT INTO investment.feedback_to_action_map
       (source_trade_id, parameter_name, old_value, new_value, reason, suggestion_log_id, metadata, applied_at)
     SELECT $1::bigint, $2, 'null'::jsonb, $3::jsonb, $4, $5, $6::jsonb, NOW()
     WHERE NOT EXISTS (
       SELECT 1
         FROM investment.feedback_to_action_map fam
        WHERE fam.source_trade_id = $1::bigint
          AND fam.metadata->>'mapper' = $7
     )`,
    [
      key.tradeId,
      classification.parameterName,
      JSON.stringify(classification.newValue),
      `${row.symbol} ${classification.loss ? 'loss' : 'win'} gap backfill shadow feedback (pnlPct=${classification.pnlPct.toFixed(4)})`,
      `${MAPPER_ID}:${key.originalTradeId}`,
      JSON.stringify(metadata),
      MAPPER_ID,
    ],
  );
}

export async function runFeedbackLoopGapBackfill(options = {}) {
  const opts = {
    from: options.from || DEFAULT_FROM,
    to: options.to || DEFAULT_TO,
    market: options.market || 'all',
    limit: Math.max(1, Number(options.limit || 1000)),
    write: options.write === true,
    confirm: options.confirm || null,
  };
  const dryRun = opts.write !== true;
  if (opts.write && opts.confirm !== REQUIRED_CONFIRM) {
    return {
      ok: false,
      dryRun: false,
      applied: false,
      code: 'confirmation_required',
      requiredConfirm: REQUIRED_CONFIRM,
      options: opts,
    };
  }

  const rows = await fetchEligibleTrades(opts);
  const summary = {
    ok: true,
    dryRun,
    applied: opts.write,
    code: null,
    mapper: MAPPER_ID,
    from: opts.from,
    to: opts.to,
    market: opts.market,
    limit: opts.limit,
    eligibleTrades: rows.length,
    losses: 0,
    winsOrFlat: 0,
    inserted: {
      tradeDecisionAttribution: 0,
      lunaFailureReflexions: 0,
      feedbackToActionMap: 0,
    },
    samples: [],
  };

  for (const row of rows) {
    const classification = classifyTrade(row);
    const key = buildLearningTradeId(row);
    if (classification.loss) summary.losses += 1;
    else summary.winsOrFlat += 1;
    if (summary.samples.length < 5) {
      summary.samples.push({
        tradeId: row.trade_id,
        learningTradeId: key.tradeId,
        syntheticTradeId: key.synthetic,
        market: row.market,
        symbol: row.symbol,
        pnlPct: Number(classification.pnlPct.toFixed(4)),
        loss: classification.loss,
        parameterName: classification.parameterName,
      });
    }
    if (dryRun) continue;

    const context = { from: opts.from, to: opts.to };
    const attribution = await persistAttribution(row, classification, context);
    const reflexion = await persistFailureReflexion(row, classification, context);
    const action = await persistFeedbackAction(row, classification, context);
    summary.inserted.tradeDecisionAttribution += Number(attribution?.rowCount || 0);
    summary.inserted.lunaFailureReflexions += Number(reflexion?.rowCount || 0);
    summary.inserted.feedbackToActionMap += Number(action?.rowCount || 0);
  }

  return summary;
}

async function main() {
  const args = parseArgs();
  const result = await runFeedbackLoopGapBackfill(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) {
    console.log(
      `runtime-luna-feedback-loop-gap-backfill ${result.dryRun ? 'dry-run' : 'applied'} ` +
      `eligible=${result.eligibleTrades} losses=${result.losses} ` +
      `tda=${result.inserted.tradeDecisionAttribution} lfr=${result.inserted.lunaFailureReflexions} fam=${result.inserted.feedbackToActionMap}`,
    );
  } else {
    console.log(`runtime-luna-feedback-loop-gap-backfill blocked code=${result.code || 'unknown'}`);
    process.exitCode = 1;
  }
  try { await close(); } catch {}
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-feedback-loop-gap-backfill 실패:' });
}
