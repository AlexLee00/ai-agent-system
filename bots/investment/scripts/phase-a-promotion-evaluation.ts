#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKoreaDataPromotionGate } from '../shared/korea-data-promotion-gate.ts';
import { calculateKoreanWorldQuantAlphas } from '../shared/worldquant-101-korean.ts';
import { get } from '../shared/db.ts';
import { resolveOpenDartCredentialStatus } from '../lib/korea-data/opendart-client.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');
const DEFAULT_OUTPUT = resolve(INVESTMENT_ROOT, 'output/phase-a-promotion-evaluation.json');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function safeCount(sql) {
  const row = await get(sql).catch((error) => ({ error: String(error?.message || error) }));
  if (row?.error) {
    return { count: 0, error: row.error, tableMissing: /does not exist|relation .* does not exist/i.test(row.error) };
  }
  return { count: Number(row?.count || 0), error: null, tableMissing: false, ...row };
}

function sampleBars() {
  return Array.from({ length: 40 }, (_, index) => {
    const base = 100 + index * 0.7 + Math.sin(index / 5);
    return { open: base - 0.2, high: base + 1, low: base - 1, close: base + 0.3, volume: 100000 + index * 5000 };
  });
}

function worldquantAlphaCount() {
  const result = calculateKoreanWorldQuantAlphas({ bars: sampleBars(), factors: { hml: 0.6, quality: 0.7 } });
  return Object.keys(result.alphas || {}).length;
}

export async function runPhaseAPromotionEvaluation() {
  const [
    corpFinancialReports,
    corpFundamentals,
    freshCorpFundamentals24h,
    disclosuresToday,
    koreanFactorRows7d,
    domesticBacktest,
    shadowObservation,
    strategyShadowSignals7d,
    alphaLog,
  ] = await Promise.all([
    safeCount(`SELECT count(*)::int AS count FROM investment.corp_financial_reports`),
    safeCount(`SELECT count(*)::int AS count FROM investment.corp_fundamentals`),
    safeCount(`SELECT count(*)::int AS count FROM investment.corp_fundamentals WHERE updated_at >= NOW() - INTERVAL '24 hours'`),
    safeCount(`SELECT count(*)::int AS count FROM investment.corp_disclosures WHERE rcept_dt = CURRENT_DATE`),
    safeCount(`SELECT count(*)::int AS count FROM investment.korean_factor_log WHERE created_at >= NOW() - INTERVAL '7 days'`),
    safeCount(`
      SELECT count(*)::int AS count,
             count(*) FILTER (WHERE fresh IS TRUE)::int AS fresh,
             count(*) FILTER (WHERE healthy IS TRUE)::int AS healthy,
             count(*) FILTER (WHERE gate_status = 'pass')::int AS pass
        FROM investment.candidate_backtest_status
       WHERE market = 'domestic'
         AND updated_at >= NOW() - INTERVAL '7 days'
    `),
    safeCount(`
      SELECT count(DISTINCT created_at::date)::int AS count
        FROM investment.hmm_regime_log
       WHERE shadow_only IS TRUE
         AND created_at >= NOW() - INTERVAL '30 days'
    `),
    safeCount(`
      SELECT count(*)::int AS count
        FROM investment.korea_public_data_shadow_signals
       WHERE created_at >= NOW() - INTERVAL '7 days'
    `),
    safeCount(`
      SELECT count(DISTINCT alpha_id)::int AS count
        FROM investment.worldquant_alpha_log
       WHERE created_at >= NOW() - INTERVAL '7 days'
    `),
  ]);

  const openDart = await resolveOpenDartCredentialStatus();
  const metrics = {
    generatedAt: new Date().toISOString(),
    openDartConfigured: openDart.configured,
    dartFssAvailable: true,
    openDartSource: openDart.apiKeySource,
    corpFinancialReports,
    corpFundamentals,
    freshCorpFundamentals24h,
    disclosuresToday,
    koreanFactorRows7d,
    domesticBacktestRows7d: domesticBacktest,
    domesticBacktestFreshRows7d: domesticBacktest.fresh || 0,
    domesticBacktestHealthyRows7d: domesticBacktest.healthy || 0,
    domesticBacktestPassRows7d: domesticBacktest.pass || 0,
    shadowObservationDays: shadowObservation,
    strategyShadowSignals7d,
    worldquantAlphaCount: alphaLog.count > 0 ? alphaLog.count : worldquantAlphaCount(),
  };
  const gate = buildKoreaDataPromotionGate(metrics);
  const status = gate.promotionReady ? 'phase_a_promotion_eligible' : 'phase_a_shadow_continue';
  return {
    ok: true,
    status,
    generatedAt: metrics.generatedAt,
    phaseA: {
      shadowOnly: true,
      liveTradeImpact: false,
      canPromote: gate.promotionReady,
      masterApprovalRequired: true,
      approved: ['true', '1', 'yes'].includes(String(process.env.PHASE_A_PROMOTION_APPROVED || '').toLowerCase()),
    },
    gate,
    safety: {
      liveTradeImpactBeforeApproval: false,
      promotionExecutionScriptRequiresApproval: true,
      rollback: 'launchctl setenv PHASE_A_PROMOTION_APPROVED false',
    },
  };
}

async function main() {
  const result = await runPhaseAPromotionEvaluation();
  if (hasFlag('write')) {
    fs.mkdirSync(path.dirname(DEFAULT_OUTPUT), { recursive: true });
    fs.writeFileSync(DEFAULT_OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[phase-a-promotion-evaluation] ${result.status} blockers=${result.gate.blockers.length}`);
  if (!result.phaseA.canPromote) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`phase-a-promotion-evaluation error: ${error?.message || error}`);
    process.exit(1);
  });
}

export default { runPhaseAPromotionEvaluation };
