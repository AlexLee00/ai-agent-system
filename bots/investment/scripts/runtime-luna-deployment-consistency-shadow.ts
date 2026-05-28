#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  auditLunaDeploymentConsistency,
  extractLunaDeploymentSpecHash,
} from '../shared/luna-deployment-spec.ts';
import {
  ensureLunaPhase3Schema,
  insertDeploymentSpecShadow,
} from '../shared/luna-phase3-posttrade-mutation.ts';
import {
  buildLunaPaperTradingPlan,
  buildLunaWeightVector,
  loadLatestLunaWeightVectors,
  normalizeLunaPhase2Market,
} from '../shared/luna-weight-vector.ts';
import { runLunaWeightVectorShadow } from './runtime-luna-weight-vector-shadow.ts';

const CONFIRM = 'luna-deployment-consistency-shadow';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function normalizeMarketFilter(value: any = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'all' || raw === '*' || raw === 'any') return null;
  return normalizeLunaPhase2Market(raw);
}

function fixtureRows() {
  const now = new Date('2026-05-14T00:00:00.000Z').toISOString();
  const weight = buildLunaWeightVector({
    asOf: now,
    candidate: { symbol: 'BTC/USDT', market: 'crypto', score: 0.91, discovered_at: now },
    backtest: { fresh: true, healthy: true, sharpe: 1.25, win_rate: 58, max_drawdown: 9, last_backtest_at: now },
    predictive: { decision: 'pass_prediction', score: 0.82, threshold: 0.55, component_coverage: 0.85, created_at: now },
    community: { avg_score: 0.35, source_count: 3, last_seen_at: now },
  }, { riskBudgetUsdt: 0 });
  const paper = buildLunaPaperTradingPlan(weight, {
    position: { amount: 0, avg_price: 65000 },
    equityUsdt: 1000,
    maxOrderUsdt: 0,
    minNotionalUsdt: 5,
  });
  return [{ weightVector: weight, paperPlan: paper }];
}

async function loadLatestPaperPlans({ hours = 24, market = null, limit = 50 } = {}) {
  const params = [Number(hours), Number(limit)];
  const normalizedMarket = normalizeMarketFilter(market);
  const marketWhere = normalizedMarket ? `AND market = $${params.push(normalizedMarket)}` : '';
  return db.query(`
    SELECT DISTINCT ON (symbol, market)
           symbol, market, exchange, target_weight, current_weight, delta_weight,
           paper_side, paper_notional_usdt, paper_quantity, reference_price,
           confidence, status, shadow_only, evidence, observed_at
      FROM luna_paper_trading_shadow
     WHERE observed_at >= NOW() - ($1::int * INTERVAL '1 hour')
       AND shadow_only = true
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $2
  `, params).catch(() => []);
}

function normalizeWeight(row = {}) {
  return {
    symbol: row.symbol,
    market: row.market,
    exchange: row.exchange,
    targetWeight: Number(row.target_weight ?? row.targetWeight ?? 0),
    confidence: Number(row.confidence ?? 0),
    signal: row.signal,
    shadowOnly: row.shadow_only ?? row.shadowOnly,
    evidence: row.evidence || {},
    observedAt: row.observed_at || row.observedAt,
  };
}

function normalizePaper(row = {}) {
  return {
    symbol: row.symbol,
    market: row.market,
    exchange: row.exchange,
    targetWeight: Number(row.target_weight ?? row.targetWeight ?? 0),
    currentWeight: Number(row.current_weight ?? row.currentWeight ?? 0),
    paperSide: row.paper_side ?? row.paperSide,
    shadowOnly: row.shadow_only ?? row.shadowOnly,
    evidence: row.evidence || {},
    observedAt: row.observed_at || row.observedAt,
  };
}

export async function runLunaDeploymentConsistencyShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_PHASE3_CONSISTENCY_LIMIT || 50));
  const hours = Math.max(1, Number(options.hours || 24));
  const market = normalizeMarketFilter(options.market);

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-deployment-consistency-shadow cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-deployment-consistency-shadow apply requires --confirm=${CONFIRM}`);
  }

  const pairs = fixture
    ? fixtureRows()
    : deps.loadPairs
      ? await deps.loadPairs({ limit, hours, market })
      : await (async () => {
        const weights = (await loadLatestLunaWeightVectors({ limit, hours, market })).map(normalizeWeight);
        const papers = (await loadLatestPaperPlans({ limit, hours, market })).map(normalizePaper);
        if (weights.length === 0 && !apply) {
          const planned = await runLunaWeightVectorShadow({
            json: true,
            dryRun: true,
            apply: false,
            limit,
            market,
          });
          return (planned.rows || []).map((weightVector) => ({
            weightVector,
            paperPlan: buildLunaPaperTradingPlan(weightVector, {
              position: null,
              equityUsdt: Number(process.env.LUNA_PHASE2_PAPER_EQUITY_USDT || 1000),
              maxOrderUsdt: Number(process.env.LUNA_MAX_TRADE_USDT || 0),
              minNotionalUsdt: 5,
              fallbackPrice: 1,
            }),
          }));
        }
        const paperByKey = new Map(papers.map((paper) => [`${paper.symbol}|${paper.market}`, paper]));
        return weights.map((weightVector) => ({
          weightVector,
          paperPlan: paperByKey.get(`${weightVector.symbol}|${weightVector.market}`) || null,
        }));
      })();

  const rows = pairs.map(({ weightVector, paperPlan }) => {
    const audit = auditLunaDeploymentConsistency({ weightVector, paperPlan, expectedMode: 'paper' });
    const decisionSpec = weightVector?.evidence?.decisionSpec || paperPlan?.evidence?.decisionSpec || {};
    return {
      symbol: weightVector?.symbol || paperPlan?.symbol || null,
      market: weightVector?.market || paperPlan?.market || null,
      exchange: weightVector?.exchange || paperPlan?.exchange || null,
      specHash: audit.specHash || audit.paperHash || extractLunaDeploymentSpecHash(weightVector) || 'missing',
      specVersion: audit.specVersion,
      mode: 'paper',
      liveBacktestConsistent: audit.liveBacktestConsistent,
      inconsistencyReasons: audit.reasons,
      decisionSpec,
      audit,
    };
  });

  if (apply && !dryRun && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaPhase3Schema();
    }
    for (const row of rows) {
      if (deps.insertSpec) await deps.insertSpec(row);
      else await insertDeploymentSpecShadow(row);
    }
  }

  const summary = {
    total: rows.length,
    consistent: rows.filter((row) => row.liveBacktestConsistent).length,
    inconsistent: rows.filter((row) => !row.liveBacktestConsistent).length,
    liveMutation: false,
  };
  const payload = {
    ok: true,
    status: apply ? 'luna_deployment_consistency_shadow_written' : 'luna_deployment_consistency_shadow_planned',
    phase: 'luna_phase3_codex_p1',
    task: 'live_backtest_same_spec',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    market: market || 'all',
    hours,
    summary,
    rows,
  };
  if (!json) {
    console.log(`[luna-phase3-consistency] ${payload.status} total=${summary.total} consistent=${summary.consistent} inconsistent=${summary.inconsistent}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaDeploymentConsistencyShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_PHASE3_CONSISTENCY_LIMIT || 50)),
      hours: Number(argValue('hours', 24)),
      market: argValue('market', null),
      confirm: argValue('confirm', ''),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-deployment-consistency-shadow error:',
  });
}
