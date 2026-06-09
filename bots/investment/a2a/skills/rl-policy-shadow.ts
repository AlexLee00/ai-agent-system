import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildRlPolicyShadow,
  marketForRlExchange,
  normalizeRlExchange,
  normalizeRlPolicyShadowRow,
} from '../../shared/rl-policy-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;

type RlPolicyCandidate = {
  symbol?: string;
  exchange?: string;
  bars?: unknown[];
  factorEvidence?: Record<string, unknown>;
  statArbEvidence?: Record<string, unknown>;
  entryEvidence?: Record<string, unknown>;
  regimeEvidence?: Record<string, unknown>;
  portfolio?: Record<string, unknown>;
};

type RlPolicyParams = {
  symbol?: string;
  symbols?: string[];
  exchange?: string | null;
  market?: string;
  limit?: number;
  broadcast?: boolean;
  bars?: unknown[];
  candidate?: RlPolicyCandidate;
  factorEvidence?: Record<string, unknown>;
  statArbEvidence?: Record<string, unknown>;
  entryEvidence?: Record<string, unknown>;
  regimeEvidence?: Record<string, unknown>;
  portfolio?: Record<string, unknown>;
};

type RlPolicyShadow = Omit<ReturnType<typeof buildRlPolicyShadow>, 'evidence'> & {
  evidence: Record<string, unknown>;
};
type RlPolicyOutput = ReturnType<typeof outputFromShadow> & {
  rows?: Array<{
    symbol: unknown;
    exchange: unknown;
    actionType: unknown;
    action: unknown;
    confidence: unknown;
    dataHealth: unknown;
    modelStatus: unknown;
  }>;
};

type RlPolicyHandlerOptions = {
  queryFn?: QueryFn;
  skillId?: string;
};

type RlPolicyRowsQuery = {
  symbol?: string;
  exchange?: string | null;
  market?: string;
  limit?: number;
};

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

function asRlPolicyParams(params: unknown): RlPolicyParams {
  return params && typeof params === 'object' ? (params as RlPolicyParams) : {};
}

async function latestRlPolicyRows(queryFn: QueryFn, { symbol, exchange, market, limit }: RlPolicyRowsQuery) {
  const conds: string[] = [];
  const params: unknown[] = [];
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

function outputFromShadow(shadow: RlPolicyShadow, skillId: string, params: RlPolicyParams = {}) {
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

function outputFromRows(rows: unknown[] = [], skillId: string, params: RlPolicyParams = {}): RlPolicyOutput {
  const normalized = rows.map((row) => normalizeRlPolicyShadowRow(row as Record<string, unknown>));
  const primary = normalized[0] || {};
  return {
    ...outputFromShadow(primary as RlPolicyShadow, skillId, params),
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

function outputFromCandidate(params: RlPolicyParams = {}, skillId: string) {
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

export function createRlPolicyShadowHandler({ queryFn = defaultQuery as QueryFn, skillId = 'rl-policy-shadow' }: RlPolicyHandlerOptions = {}) {
  return async function rlPolicyShadow(rawParams: unknown = {}): Promise<A2ATaskResult> {
    const params = asRlPolicyParams(rawParams);
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
      id: '',
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
  return async function rlPolicyUpdate(rawParams: unknown = {}): Promise<A2ATaskResult> {
    const params = asRlPolicyParams(rawParams);
    return {
      id: '',
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

export function registerRlPolicyShadowSkills(options: RlPolicyHandlerOptions = {}) {
  registerSkillHandler('rl-policy-shadow', createRlPolicyShadowHandler({ ...options, skillId: 'rl-policy-shadow' }));
  registerSkillHandler('policy-inference', createRlPolicyShadowHandler({ ...options, skillId: 'policy-inference' }));
  registerSkillHandler('policy-update', createRlPolicyUpdateHandler({ skillId: 'policy-update' }));
}

export default {
  createRlPolicyShadowHandler,
  createRlPolicyUpdateHandler,
  registerRlPolicyShadowSkills,
};
