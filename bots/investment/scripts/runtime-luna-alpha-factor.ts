#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import { evaluateCandidateBacktestStatus } from '../shared/candidate-backtest-gate.ts';
import {
  buildFactorModelShadow,
  rankFactorModelShadows,
} from '../shared/factor-model-shadow.ts';
import { generateAlphaFactorCandidates } from '../shared/luna-alpha-factor-generator.ts';
import {
  alphaMetricsPass,
  buildCandidateBacktestRowFromAlpha,
  evaluateAlphaFactorIc,
} from '../shared/luna-alpha-factor-ic.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260619000002_luna_alpha_factors.sql');

export const LUNA_ALPHA_FACTOR_CONFIRM = 'luna-alpha-factor-shadow';

function hasFlag(argv: string[], name: string) {
  return argv.includes(`--${name}`);
}

function argValue(argv: string[], name: string, fallback: any = null) {
  const prefix = `--${name}=`;
  const found = argv.find((item) => item.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
}

export function parseAlphaFactorArgs(argv = process.argv.slice(2)) {
  return {
    apply: hasFlag(argv, 'apply'),
    json: hasFlag(argv, 'json'),
    llm: hasFlag(argv, 'llm'),
    fixture: hasFlag(argv, 'fixture') || !hasFlag(argv, 'db-source'),
    confirm: argValue(argv, 'confirm', ''),
    market: argValue(argv, 'market', 'domestic'),
    limit: Number(argValue(argv, 'limit', 2)),
    horizonDays: Number(argValue(argv, 'horizon-days', 5)),
    permutationIterations: Number(argValue(argv, 'permutation-iterations', 64)),
  };
}

function round(value: any, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

export function buildSyntheticAlphaRows(options: any = {}) {
  const symbols = options.symbols || ['AAA', 'BBB', 'CCC', 'DDD'];
  const days = Number(options.days ?? 90);
  const start = new Date(options.start || '2026-01-01T00:00:00Z');
  const rows = [];
  for (let d = 0; d < days; d += 1) {
    const asOf = new Date(start.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    for (let s = 0; s < symbols.length; s += 1) {
      const symbolEdge = (symbols.length - s) * 0.0008;
      const wave = Math.sin((d + s) / 7) * 0.004;
      const drift = 0.001 + symbolEdge + wave;
      const close = 100 * Math.exp(drift * d) * (1 + s * 0.05);
      rows.push({
        symbol: symbols[s],
        asOfDate: asOf,
        universeAsOf: asOf,
        close,
        open: close * 0.995,
        high: close * 1.01,
        low: close * 0.99,
        volume: 1_000_000 + d * 10_000 + s * 50_000,
        return_5d: drift * 5,
        return_20d: drift * 20,
        return_60d: drift * 60,
        volatility_20d: 0.02 + s * 0.002,
        pbr: 0.8 + s * 0.4,
        roe: 0.05 + (symbols.length - s) * 0.025,
        marketCap: 1_000_000_000 + s * 250_000_000,
        momentum: drift * 20,
        revenueGrowth: 0.03 + s * 0.01,
      });
    }
  }
  return rows;
}

async function ensureAlphaSchema(runFn: any) {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const statements = sql
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await runFn(`${statement};`);
  }
}

function asRows(result: any) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.rows)) return result.rows;
  return [];
}

async function insertFactor(result: any, runFn: any) {
  const row = await runFn(
    `INSERT INTO luna_alpha_factors
       (factor_name, expression, hypothesis, market, universe, status, complexity,
        metrics, gate, evidence, universe_asof, shadow_only, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, true, $12)
     ON CONFLICT (factor_name, expression, market) DO UPDATE SET
       status = EXCLUDED.status,
       complexity = EXCLUDED.complexity,
       metrics = EXCLUDED.metrics,
       gate = EXCLUDED.gate,
       evidence = EXCLUDED.evidence,
       universe_asof = EXCLUDED.universe_asof,
       updated_at = NOW()
     RETURNING id`,
    [
      result.candidate.name,
      result.candidate.expression,
      result.candidate.hypothesis,
      result.market,
      result.candidate.universe,
      result.status,
      result.candidate.complexity,
      JSON.stringify(result.metrics),
      JSON.stringify(result.gate),
      JSON.stringify(result.evidence),
      result.metrics.universeAsOf,
      result.candidate.generatedBy,
    ]
  );
  return asRows(row)[0]?.id || null;
}

async function insertEvaluation(result: any, factorId: any, runFn: any) {
  await runFn(
    `INSERT INTO luna_alpha_factor_evaluations
       (factor_id, factor_name, market, horizon_days, ic, rank_ic, rank_ir,
        permutation_p, sample_count, oos_metadata, universe_asof, shadow_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, true)`,
    [
      factorId,
      result.candidate.name,
      result.market,
      result.metrics.horizonDays,
      result.metrics.ic,
      result.metrics.rankIc,
      result.metrics.rankIr,
      result.metrics.permutationP,
      result.metrics.sampleCount,
      JSON.stringify({
        dateCount: result.metrics.dateCount,
        gate: result.gate,
        shadowRank: result.evidence?.factorModelShadow?.rank,
      }),
      result.metrics.universeAsOf,
    ]
  );
}

async function loadRows(options: any, deps: any) {
  if (deps.loadRows) return deps.loadRows(options);
  if (options.fixture !== false) return buildSyntheticAlphaRows();
  const queryFn = deps.queryFn || db.query;
  const rows = await queryFn(
    `SELECT stock_code AS symbol,
            calculation_date AS as_of_date,
            MAX(CASE WHEN factor_name = 'momentum' THEN factor_value END)::double precision AS return_20d,
            MAX(CASE WHEN factor_name = 'value' THEN factor_value END)::double precision AS value,
            MAX(CASE WHEN factor_name = 'quality' THEN factor_value END)::double precision AS quality,
            MAX(CASE WHEN factor_name = 'growth' THEN factor_value END)::double precision AS growth,
            AVG(factor_value)::double precision AS factor_proxy,
            MAX((metadata->>'composite')::double precision) AS composite
       FROM korean_factor_log
      WHERE factor_value IS NOT NULL
      GROUP BY stock_code, calculation_date
      ORDER BY stock_code, calculation_date
      LIMIT 5000`
  );
  return asRows(rows).map((row) => ({
    symbol: row.symbol,
    asOfDate: row.as_of_date || row.asOfDate,
    universeAsOf: row.as_of_date || row.asOfDate,
    close: Number(row.composite ?? row.factor_proxy ?? 1),
    volume: 1,
    pbr: row.value == null || Number(row.value) === 0 ? 1 : 1 / Math.max(0.01, Number(row.value)),
    roe: Number(row.quality ?? 0),
    return_5d: Number(row.return_20d ?? 0) / 4,
    return_20d: Number(row.return_20d ?? 0),
    revenueGrowth: Number(row.growth ?? 0),
  }));
}

function buildShadowEvidence(candidate: any, metrics: any, market: string) {
  const shadow = buildFactorModelShadow({
    symbol: `ALPHA:${candidate.name}`,
    exchange: market === 'crypto' ? 'binance' : 'kis',
    market,
    confidence: Math.min(1, Math.abs(Number(metrics.rankIc ?? 0))),
    predictiveScore: Math.max(0, Math.min(1, 0.5 + Number(metrics.rankIc ?? 0))),
    fundamentals: {
      roe: 0.08,
      pbr: 1.2,
    },
  }, { source: 'alpha_factor_discovery', market });
  const ranked = rankFactorModelShadows([shadow])[0];
  return {
    source: 'factor-model-shadow',
    compositeScore: ranked.compositeScore,
    rank: ranked.rank,
    dataHealth: ranked.dataHealth,
    missingFactors: ranked.missingFactors,
  };
}

export async function runLunaAlphaFactor(options: any = {}, deps: any = {}) {
  const market = options.market || 'domestic';
  const maxComplexity = Number(options.maxComplexity ?? 12);
  const thresholds = {
    minIc: Number(options.minIc ?? 0.03),
    minRankIr: Number(options.minRankIr ?? 0.5),
    minSampleDays: Number(options.minSampleDays ?? 60),
    permutationPMax: Number(options.permutationPMax ?? 0.01),
  };
  const canWrite = options.apply === true && options.confirm === LUNA_ALPHA_FACTOR_CONFIRM;
  const candidateResult = options.candidates
    ? { ok: true, source: 'injected', candidates: options.candidates, error: null }
    : await generateAlphaFactorCandidates({
      llm: options.llm === true,
      limit: options.limit ?? 2,
      market,
      maxComplexity,
    }, deps);
  const rows = await loadRows(options, deps);
  const results = [];

  for (const candidate of candidateResult.candidates) {
    const metrics = evaluateAlphaFactorIc(candidate, rows, {
      horizonDays: options.horizonDays ?? 5,
      permutationIterations: options.permutationIterations ?? 64,
      seed: options.seed ?? 1337,
      maxComplexity,
    });
    const normalizedCandidate = metrics.candidate;
    const gateRow = buildCandidateBacktestRowFromAlpha(metrics, { market, ...thresholds });
    const gate = evaluateCandidateBacktestStatus(gateRow, options.env || process.env);
    const metricsPass = alphaMetricsPass(metrics, thresholds);
    const status = metricsPass && gate.wouldBlock !== true ? 'promotion_candidate' : 'shadow';
    const evidence = {
      shadowOnly: true,
      generatedBy: normalizedCandidate.generatedBy,
      generatorSource: candidateResult.source,
      wouldPromote: status === 'promotion_candidate',
      autoPromotion: false,
      candidateGateRow: gateRow,
      factorModelShadow: buildShadowEvidence(normalizedCandidate, metrics, market),
      r6MeetingRoomDeferred: true,
    };
    results.push({
      candidate: normalizedCandidate,
      market,
      status,
      metrics: {
        horizonDays: metrics.horizonDays,
        sampleCount: metrics.sampleCount,
        dateCount: metrics.dateCount,
        ic: round(metrics.ic),
        rankIc: round(metrics.rankIc),
        rankIr: round(metrics.rankIr),
        permutationP: round(metrics.permutationP),
        universeAsOf: metrics.universeAsOf,
      },
      gate: {
        ok: gate.ok,
        mode: gate.mode,
        status: gate.status,
        wouldBlock: gate.wouldBlock === true,
        reasons: gate.reasons || gate.blockReasons || [],
      },
      evidence,
    });
  }

  let written = 0;
  if (canWrite) {
    const runFn = deps.runFn || db.run;
    if (deps.ensureSchema) await deps.ensureSchema();
    else await ensureAlphaSchema(runFn);
    for (const result of results) {
      const factorId = await insertFactor(result, runFn);
      await insertEvaluation(result, factorId, runFn);
      written += 1;
    }
  }

  const promotionCandidates = results.filter((result) => result.status === 'promotion_candidate').length;
  return {
    ok: true,
    shadowOnly: true,
    liveMutation: false,
    apply: options.apply === true,
    canWrite,
    confirmRequired: options.apply === true && !canWrite,
    written,
    generator: { source: candidateResult.source, error: candidateResult.error || null },
    summary: {
      evaluated: results.length,
      promotionCandidates,
      autoPromotion: false,
      rows: rows.length,
      market,
    },
    results,
  };
}

if (isDirectExecution(import.meta.url)) {
  const options = parseAlphaFactorArgs();
  await runCliMain({
    run: async () => runLunaAlphaFactor(options),
    onSuccess: async (result) => {
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`alpha-factor evaluated=${result.summary.evaluated} promotion_candidates=${result.summary.promotionCandidates} written=${result.written}`);
      }
    },
    errorPrefix: '❌ luna-alpha-factor 실패:',
  });
}
