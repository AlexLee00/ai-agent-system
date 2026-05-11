import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildRlPolicyShadow,
  marketForRlExchange,
  normalizeRlExchange,
  normalizeRlPolicyShadowRow,
} from '../../shared/rl-policy-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestRlPolicyRows(queryFn, { symbol, exchange, market, limit }) {
  const conds = [];
  const params = [];
  if (symbol) {
    params.push(symbol);
    conds.push(`symbol = $${params.length}`);
  }
  if (exchange) {
    params.push(exchange);
    conds.push(`exchange = $${params.length}`);
  }
  if (market) {
    params.push(market);
    conds.push(`market = $${params.length}`);
  }
  params.push(Math.max(1, Number(limit || 10)));
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_rl_policy_shadow
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY observed_at DESC, confidence DESC
      LIMIT $${params.length}`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function outputFromShadow(shadow, skillId, params = {}) {
  return {
    ok: Boolean(shadow.ok),
    skill: skillId,
    symbol: shadow.symbol,
    exchange: shadow.exchange,
    market: shadow.market || marketForRlExchange(params.exchange || shadow.exchange),
    shadowMode: true,
    stateVector: shadow.stateVector,
    action: shadow.action,
    actionType: shadow.actionType,
    actionSizePct: shadow.actionSizePct,
    confidence: shadow.confidence,
    rewardEstimate: shadow.rewardEstimate,
    modelStatus: shadow.modelStatus,
    dataHealth: shadow.dataHealth,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: shadow.evidence || {},
  };
}

function outputFromRows(rows = [], skillId, params = {}) {
  const normalized = rows.map(normalizeRlPolicyShadowRow);
  const primary = normalized[0] || {};
  return {
    ...outputFromShadow(primary, skillId, params),
    rows: normalized.map((row) => ({
      symbol: row.symbol,
      exchange: row.exchange,
      actionType: row.actionType,
      action: row.action,
      confidence: row.confidence,
      dataHealth: row.dataHealth,
      modelStatus: row.modelStatus,
    })),
    evidence: {
      source: 'investment.luna_rl_policy_shadow',
      observedAt: primary.evidence?.observedAt || null,
    },
  };
}

function outputFromCandidate(params = {}, skillId) {
  const exchange = normalizeRlExchange(params.exchange || params.candidate?.exchange);
  const shadow = buildRlPolicyShadow({
    symbol: params.symbol || params.candidate?.symbol || params.symbols?.[0],
    exchange,
    bars: params.bars || params.candidate?.bars,
    factorEvidence: params.factorEvidence || params.candidate?.factorEvidence,
    statArbEvidence: params.statArbEvidence || params.candidate?.statArbEvidence,
    entryEvidence: params.entryEvidence || params.candidate?.entryEvidence,
    regimeEvidence: params.regimeEvidence || params.candidate?.regimeEvidence,
    portfolio: params.portfolio || params.candidate?.portfolio,
  }, {
    source: 'candidate_params',
    optionalDepsReady: false,
    modelLoaded: false,
  });
  return outputFromShadow(shadow, skillId, params);
}

export function createRlPolicyShadowHandler({ queryFn = defaultQuery, skillId = 'rl-policy-shadow' } = {}) {
  return async function rlPolicyShadow(params = {}) {
    const exchange = params.exchange ? normalizeRlExchange(params.exchange) : null;
    const rows = await latestRlPolicyRows(queryFn, {
      symbol: params.symbol,
      exchange,
      market: params.market,
      limit: params.limit || 10,
    });
    const output = rows.length > 0
      ? outputFromRows(rows, skillId, { ...params, exchange })
      : outputFromCandidate({ ...params, exchange: exchange || params?.candidate?.exchange }, skillId);
    return {
      status: output.ok ? 'completed' : 'failed',
      output,
      metadata: {
        source: rows.length > 0 ? 'luna_rl_policy_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
        liveMutation: false,
      },
      error: output.ok ? undefined : { code: -32602, message: 'rl policy shadow input missing' },
    };
  };
}

export function createRlPolicyUpdateHandler({ skillId = 'policy-update' } = {}) {
  return async function rlPolicyUpdate(params = {}) {
    return {
      status: 'completed',
      output: {
        ok: true,
        skill: skillId,
        shadowMode: true,
        updatePlanned: false,
        trainingPlanned: false,
        liveMutation: false,
        confirmRequired: 'luna-rl-policy-shadow',
        modelStatus: 'training_scaffold_only',
        broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
        evidence: {
          source: 'rl_policy_update_shadow',
          reason: 'Phase 7 does not train or promote PPO without explicit later approval',
        },
      },
      metadata: {
        source: 'rl_policy_update_shadow',
        broadcastEnabled: broadcastEnabled(),
      },
    };
  };
}

export function registerRlPolicyShadowSkills(options = {}) {
  registerSkillHandler('rl-policy-shadow', createRlPolicyShadowHandler({ ...options, skillId: 'rl-policy-shadow' }));
  registerSkillHandler('policy-inference', createRlPolicyShadowHandler({ ...options, skillId: 'policy-inference' }));
  registerSkillHandler('policy-update', createRlPolicyUpdateHandler({ skillId: 'policy-update' }));
}

export default {
  createRlPolicyShadowHandler,
  createRlPolicyUpdateHandler,
  registerRlPolicyShadowSkills,
};
