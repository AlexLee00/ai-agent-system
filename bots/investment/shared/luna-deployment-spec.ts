// @ts-nocheck

import crypto from 'node:crypto';

export const LUNA_DEPLOYMENT_SPEC_VERSION = 'luna-phase3-deployment-consistent-v1';

function normalizeValue(value) {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeValue(value[key])]),
    );
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Number(value.toFixed(10)) : null;
  }
  return value ?? null;
}

export function stableStringify(value) {
  return JSON.stringify(normalizeValue(value));
}

export function hashLunaDeploymentSpec(spec = {}) {
  return crypto.createHash('sha256').update(stableStringify(spec)).digest('hex');
}

function compactCandidate(candidate = {}) {
  return {
    symbol: candidate?.symbol || null,
    market: candidate?.market || null,
    score: candidate?.score ?? candidate?.candidate_score ?? null,
    source: candidate?.source || null,
    reasonCode: candidate?.reason_code || candidate?.reasonCode || null,
  };
}

function compactBacktest(backtest = {}) {
  return {
    fresh: backtest?.fresh === true || String(backtest?.fresh).toLowerCase() === 'true',
    healthy: backtest?.healthy === true || String(backtest?.healthy).toLowerCase() === 'true',
    sharpe: backtest?.sharpe ?? null,
    maxDrawdown: backtest?.max_drawdown ?? backtest?.maxDrawdown ?? null,
    winRate: backtest?.win_rate ?? backtest?.winRate ?? null,
    gateStatus: backtest?.gate_status || backtest?.gateStatus || null,
    wouldBlock: backtest?.would_block === true || backtest?.wouldBlock === true || String(backtest?.would_block).toLowerCase() === 'true',
  };
}

function compactPredictive(predictive = {}) {
  return {
    decision: predictive?.decision || null,
    score: predictive?.score ?? null,
    threshold: predictive?.threshold ?? null,
    componentCoverage: predictive?.component_coverage ?? predictive?.componentCoverage ?? null,
  };
}

function compactCommunity(community = {}) {
  return {
    avgScore: community?.avg_score ?? community?.avgScore ?? community?.score ?? null,
    sourceCount: community?.source_count ?? community?.sourceCount ?? null,
    botNoise: community?.bot_noise_score ?? community?.botNoiseScore ?? null,
    hypeSpike: community?.hype_spike ?? community?.hypeSpike ?? null,
  };
}

export function buildLunaDeploymentDecisionSpec(input = {}) {
  const candidate = input.candidate || input;
  const market = candidate?.market || input.market || null;
  const exchange = candidate?.exchange || input.exchange || null;
  const specCore = {
    specVersion: LUNA_DEPLOYMENT_SPEC_VERSION,
    symbol: candidate?.symbol || input.symbol || null,
    market,
    exchange,
    asOf: input.asOf || null,
    inputs: {
      candidate: compactCandidate(candidate),
      backtest: compactBacktest(input.backtest || candidate?.backtest || {}),
      predictive: compactPredictive(input.predictive || candidate?.predictive || {}),
      community: compactCommunity(input.community || candidate?.community || {}),
    },
    guards: {
      noLookaheadRequired: true,
      freshBacktestRequired: true,
      predictivePassRequired: true,
      liveMutation: false,
    },
  };
  return {
    ...specCore,
    runtimeMode: input.mode || 'shadow',
    specHash: hashLunaDeploymentSpec(specCore),
  };
}

export function extractLunaDeploymentSpecHash(row = {}) {
  const evidence = row?.evidence || {};
  return evidence?.decisionSpecHash || evidence?.decisionSpec?.specHash || row?.decisionSpecHash || null;
}

export function auditLunaDeploymentConsistency({ weightVector = {}, paperPlan = null, expectedMode = 'paper' } = {}) {
  const reasons = [];
  const specHash = extractLunaDeploymentSpecHash(weightVector);
  const paperHash = extractLunaDeploymentSpecHash(paperPlan || {});
  if (!specHash) reasons.push('missing_weight_vector_spec_hash');
  if (paperPlan && !paperHash) reasons.push('missing_paper_spec_hash');
  if (paperPlan && specHash && paperHash && specHash !== paperHash) reasons.push('spec_hash_mismatch');
  if (paperPlan && String(weightVector?.symbol || '') !== String(paperPlan?.symbol || '')) reasons.push('symbol_mismatch');
  if (paperPlan && String(weightVector?.market || '') !== String(paperPlan?.market || '')) reasons.push('market_mismatch');
  if (paperPlan && String(weightVector?.exchange || '') !== String(paperPlan?.exchange || '')) reasons.push('exchange_mismatch');
  if (weightVector?.shadowOnly !== true && weightVector?.shadow_only !== true) reasons.push('weight_vector_not_shadow');
  if (paperPlan && paperPlan?.shadowOnly !== true && paperPlan?.shadow_only !== true) reasons.push('paper_plan_not_shadow');
  if (weightVector?.evidence?.liveMutation === true || paperPlan?.evidence?.liveMutation === true) reasons.push('live_mutation_detected');
  if (expectedMode === 'paper' && !paperPlan) reasons.push('paper_plan_missing');
  return {
    ok: reasons.length === 0,
    liveBacktestConsistent: reasons.length === 0,
    reasons,
    specHash,
    paperHash,
    specVersion: LUNA_DEPLOYMENT_SPEC_VERSION,
  };
}

export default {
  LUNA_DEPLOYMENT_SPEC_VERSION,
  stableStringify,
  hashLunaDeploymentSpec,
  buildLunaDeploymentDecisionSpec,
  extractLunaDeploymentSpecHash,
  auditLunaDeploymentConsistency,
};
