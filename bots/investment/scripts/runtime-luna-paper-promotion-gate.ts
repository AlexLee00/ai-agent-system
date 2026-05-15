#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaPaperPromotionGateReport,
  ensureLunaPaperPromotionGateSchema,
  insertLunaPaperPromotionGateShadow,
  loadLunaPaperPromotionRows,
} from '../shared/luna-paper-promotion-gate.ts';
import { normalizeLunaPhase2Market } from '../shared/luna-weight-vector.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function fixtureRows() {
  const base = Date.now();
  const observedAt = (minutesAgo) => new Date(base - minutesAgo * 60_000).toISOString();
  const buyEvidence = {
    bottleneckAvoidance: { present: false, hardHold: false, preventedOrder: false },
    weightVector: { noLookaheadOk: true },
  };
  const hardHoldEvidence = {
    bottleneckAvoidance: {
      present: true,
      action: 'quarantine_candidate_shadow',
      hardHold: true,
      preventedOrder: false,
    },
    weightVector: { noLookaheadOk: true },
  };
  return [
    { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 20, confidence: 0.75, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(1) },
    { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 18, confidence: 0.72, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(31) },
    { symbol: 'PASS/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 16, confidence: 0.70, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(61) },
    { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'HOLD', paper_notional_usdt: 0, confidence: 0.52, status: 'no_action', shadow_only: true, evidence: hardHoldEvidence, observed_at: observedAt(2) },
    { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 12, confidence: 0.66, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(32) },
    { symbol: 'RISK/USDT', market: 'crypto', exchange: 'binance', paper_side: 'BUY', paper_notional_usdt: 11, confidence: 0.64, status: 'planned', shadow_only: true, evidence: buyEvidence, observed_at: observedAt(62) },
  ];
}

export async function runLunaPaperPromotionGateShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  const fixture = options.fixture === true;
  const json = options.json === true;
  const hours = Math.max(1, Number(options.hours || 24));
  const limit = Math.max(1, Number(options.limit || 500));
  const requestedMarket = String(options.market || '').trim().toLowerCase();
  const market = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;

  if (apply && confirm !== 'luna-paper-promotion-gate-shadow') {
    throw new Error('runtime:luna-paper-promotion-gate apply requires --confirm=luna-paper-promotion-gate-shadow');
  }
  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-paper-promotion-gate cannot combine --apply with --dry-run');
  }

  const rows = fixture
    ? fixtureRows()
    : deps.loadRows
      ? await deps.loadRows({ hours, limit, market })
      : await loadLunaPaperPromotionRows({ hours, limit, market });
  const report = buildLunaPaperPromotionGateReport(rows, {
    minCycles: options.minCycles,
    minConsecutivePasses: options.minConsecutivePasses,
    minAvgConfidence: options.minAvgConfidence,
    maxOrderUsdt: options.maxOrderUsdt,
    maxPromotionSharpe: options.maxPromotionSharpe,
  });

  if (apply && !dryRun && report.items.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPaperPromotionGateSchema();
    }
    for (const row of report.items) {
      if (deps.insertGate) await deps.insertGate(row);
      else await insertLunaPaperPromotionGateShadow(row);
    }
  }

  const payload = {
    ...report,
    status: apply ? 'luna_paper_promotion_gate_shadow_written' : report.status,
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'promotion-gate-shadow-apply' : 'plan-only',
    market: market || 'all',
    hours,
    limit,
    liveMutation: false,
  };

  if (!json) {
    console.log(`[luna-paper-promotion-gate] ${payload.status} total=${payload.summary.totalSymbols} candidates=${payload.summary.promotionCandidates}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaPaperPromotionGateShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      hours: Number(argValue('hours', 24)),
      limit: Number(argValue('limit', 500)),
      market: argValue('market', null),
      confirm: argValue('confirm', ''),
      minCycles: Number(argValue('min-cycles', process.env.LUNA_PAPER_PROMOTION_MIN_CYCLES || 3)),
      minConsecutivePasses: Number(argValue('min-consecutive-passes', process.env.LUNA_PAPER_PROMOTION_MIN_CONSECUTIVE_PASSES || 3)),
      minAvgConfidence: Number(argValue('min-avg-confidence', process.env.LUNA_PAPER_PROMOTION_MIN_AVG_CONFIDENCE || 0.62)),
      maxOrderUsdt: Number(argValue('max-order-usdt', process.env.LUNA_MAX_TRADE_USDT || 50)),
      maxPromotionSharpe: Number(argValue('max-promotion-sharpe', process.env.LUNA_PAPER_PROMOTION_MAX_SHARPE || 8)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-paper-promotion-gate error:',
  });
}
