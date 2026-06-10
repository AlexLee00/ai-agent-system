import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildMeanReversionShadow,
  buildPairsTradingShadow,
  marketForStatArbExchange,
  normalizeStatArbExchange,
  normalizeStatArbShadowRow,
} from '../../shared/stat-arb-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;

type StatArbParams = {
  strategyType?: string;
  strategy?: string;
  symbol?: string;
  symbols?: string[];
  exchange?: string;
  market?: string;
  limit?: number;
  bars?: unknown[];
  barsA?: unknown[];
  barsB?: unknown[];
  broadcast?: boolean;
  candidate?: {
    exchange?: string;
    symbols?: string[];
    symbol?: string;
    bars?: unknown[];
    barsA?: unknown[];
    barsB?: unknown[];
  };
};

type LatestRowsOptions = {
  strategyType?: string;
  symbol?: string;
  exchange?: string | null;
  market?: string;
  limit?: number;
};

type StatArbShadowOutput = {
  ok: boolean;
  skill: string;
  market: string;
  shadowMode: boolean;
  strategyType?: string;
  symbols: unknown[];
  signal?: string;
  zScore?: number;
  confidence?: number;
  dataHealth?: string;
  broadcastPlanned: boolean;
  evidence: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
};

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestStatArbShadowRows(queryFn: QueryFn, { strategyType, symbol, exchange, market, limit }: LatestRowsOptions) {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (strategyType) {
    params.push(strategyType);
    conds.push(`strategy_type = $${params.length}`);
  }
  if (symbol) {
    params.push(JSON.stringify([symbol]));
    conds.push(`symbols @> $${params.length}::jsonb`);
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
       FROM investment.luna_stat_arb_shadow
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY observed_at DESC, ABS(z_score) DESC
      LIMIT $${params.length}`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function outputFromShadow(shadow: Record<string, any>, skillId: string, params: StatArbParams = {}): StatArbShadowOutput {
  return {
    ok: Boolean(shadow.ok),
    skill: skillId,
    market: shadow.market || marketForStatArbExchange(params.exchange || shadow.exchange),
    shadowMode: true,
    strategyType: shadow.strategyType,
    symbols: shadow.symbols || [],
    signal: shadow.signal,
    zScore: shadow.zScore,
    confidence: shadow.confidence,
    dataHealth: shadow.dataHealth,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: shadow.evidence || {},
  };
}

function outputFromRows(rows: unknown[] = [], skillId: string, params: StatArbParams = {}) {
  const normalized = rows.map((row) => normalizeStatArbShadowRow(row as Record<string, unknown>));
  const primary = (normalized[0] || {}) as Record<string, any>;
  return {
    ...outputFromShadow(primary, skillId, params),
    rows: normalized.map((row) => ({
      strategyType: row.strategyType,
      symbols: row.symbols,
      exchange: row.exchange,
      signal: row.signal,
      zScore: row.zScore,
      confidence: row.confidence,
      dataHealth: row.dataHealth,
    })),
    evidence: {
      source: 'investment.luna_stat_arb_shadow',
      observedAt: primary.evidence?.observedAt || null,
    },
  };
}

function outputFromCandidate(params: StatArbParams = {}, skillId: string) {
  const exchange = normalizeStatArbExchange(params.exchange || params.candidate?.exchange);
  const strategyType = String(params.strategyType || params.strategy || 'mean_reversion');
  const shadow = strategyType === 'pairs_trading' || strategyType === 'pairs'
    ? buildPairsTradingShadow({
      symbols: params.symbols || params.candidate?.symbols,
      exchange,
      barsA: params.barsA || params.candidate?.barsA,
      barsB: params.barsB || params.candidate?.barsB,
    }, { source: 'candidate_params' })
    : buildMeanReversionShadow({
      symbol: params.symbol || params.candidate?.symbol || params.symbols?.[0],
      exchange,
      bars: params.bars || params.candidate?.bars,
    }, { source: 'candidate_params' });
  return outputFromShadow(shadow, skillId, params);
}

export function createStatArbShadowHandler({ queryFn = defaultQuery as QueryFn, skillId = 'stat-arb-shadow' }: { queryFn?: QueryFn; skillId?: string } = {}) {
  return async function statArbShadow(params: StatArbParams = {}) {
    const exchange = params.exchange ? normalizeStatArbExchange(params.exchange) : undefined;
    const rows = await latestStatArbShadowRows(queryFn, {
      strategyType: params.strategyType || params.strategy,
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
        source: rows.length > 0 ? 'luna_stat_arb_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
      },
      error: output.ok ? undefined : { code: -32602, message: 'stat arb shadow input missing' },
    };
  };
}

export function registerStatArbShadowSkill(options = {}) {
  registerSkillHandler('stat-arb-shadow', createStatArbShadowHandler(options) as any);
}

export default {
  createStatArbShadowHandler,
  registerStatArbShadowSkill,
};
