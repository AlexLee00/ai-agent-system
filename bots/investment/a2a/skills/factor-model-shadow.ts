import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildFactorModelShadow,
  marketForFactorExchange,
  normalizeFactorShadowRow,
} from '../../shared/factor-model-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;

type FactorParams = {
  symbol?: string;
  exchange?: string;
  market?: string;
  limit?: number;
  confidence?: number;
  predictiveScore?: number;
  quoteVolume?: number;
  bars?: unknown[];
  fundamentals?: Record<string, unknown>;
  marketContext?: Record<string, unknown>;
  broadcast?: boolean;
  candidate?: {
    symbol?: string;
    exchange?: string;
    market?: string;
    confidence?: number;
    predictiveScore?: number;
    quoteVolume?: number;
    bars?: unknown[];
    fundamentals?: Record<string, unknown>;
  };
};

type LatestFactorOptions = {
  symbol?: string;
  exchange?: string | null;
  market?: string;
  limit?: number;
};

function normalizeExchange(value: unknown) {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'crypto') return 'binance';
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  return ['binance', 'kis', 'kis_overseas'].includes(raw) ? raw : 'binance';
}

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestFactorShadowRows(queryFn: QueryFn, { symbol, exchange, market, limit }: LatestFactorOptions) {
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
       FROM investment.luna_factor_model_shadow
      ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
      ORDER BY observed_at DESC, rank ASC NULLS LAST
      LIMIT $${params.length}`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

function outputFromRows(rows: unknown[] = [], skillId: string, params: FactorParams = {}) {
  const normalized = rows.map((row) => normalizeFactorShadowRow(row as Record<string, unknown>));
  return {
    ok: true,
    skill: skillId,
    market: params.market || normalized[0]?.market || marketForFactorExchange(params.exchange || normalized[0]?.exchange),
    shadowMode: true,
    dataHealth: normalized.some((row) => row.dataHealth === 'ready') ? 'shadow_ready' : 'shadow_partial',
    symbols: normalized.map((row) => row.symbol),
    factorScores: Object.fromEntries(normalized.map((row) => [row.symbol, row.factorScores])),
    ranks: normalized.map((row) => ({
      symbol: row.symbol,
      exchange: row.exchange,
      rank: row.rank,
      compositeScore: row.compositeScore,
      dataHealth: row.dataHealth,
    })),
    allocationHints: Object.fromEntries(normalized.map((row) => [row.symbol, row.allocationHint])),
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: {
      source: 'investment.luna_factor_model_shadow',
      observedAt: normalized[0]?.evidence?.observedAt || null,
    },
  };
}

function outputFromCandidate(params: FactorParams = {}, skillId: string) {
  const exchange = normalizeExchange(params.exchange || params.candidate?.exchange);
  const candidate = {
    ...(params.candidate || {}),
    symbol: params.symbol || params.candidate?.symbol || null,
    exchange,
    market: params.market || params.candidate?.market || marketForFactorExchange(exchange),
    confidence: params.confidence ?? params.candidate?.confidence,
    predictiveScore: params.predictiveScore ?? params.candidate?.predictiveScore,
    quoteVolume: params.quoteVolume ?? params.candidate?.quoteVolume,
    bars: params.bars || params.candidate?.bars,
    fundamentals: params.fundamentals || params.candidate?.fundamentals,
  };
  const shadow = buildFactorModelShadow(candidate, {
    exchange,
    market: candidate.market,
    marketContext: params.marketContext || {},
    source: 'candidate_params',
  });
  return {
    ok: Boolean(shadow.ok),
    skill: skillId,
    market: shadow.market,
    shadowMode: true,
    dataHealth: shadow.dataHealth,
    symbols: shadow.symbol ? [shadow.symbol] : [],
    factorScores: shadow.symbol ? { [shadow.symbol]: shadow.factorScores } : {},
    ranks: shadow.symbol ? [{
      symbol: shadow.symbol,
      exchange: shadow.exchange,
      rank: null,
      compositeScore: shadow.compositeScore,
      dataHealth: shadow.dataHealth,
    }] : [],
    allocationHints: shadow.symbol ? { [shadow.symbol]: shadow.allocationHint } : {},
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: {
      source: 'candidate_params',
      observedAt: null,
    },
  };
}

export function createFactorModelShadowHandler({ queryFn = defaultQuery as QueryFn, skillId = 'factor-model-shadow' }: { queryFn?: QueryFn; skillId?: string } = {}) {
  return async function factorModelShadow(params: FactorParams = {}) {
    const exchange = params.exchange ? normalizeExchange(params.exchange) : undefined;
    const rows = await latestFactorShadowRows(queryFn, {
      symbol: params?.symbol,
      exchange,
      market: params?.market,
      limit: params?.limit || 10,
    });
    const output = rows.length > 0
      ? outputFromRows(rows, skillId, { ...params, exchange })
      : outputFromCandidate({ ...params, exchange: exchange || params?.candidate?.exchange }, skillId);
    return {
      status: output.ok ? 'completed' : 'failed',
      output,
      metadata: {
        source: rows.length > 0 ? 'luna_factor_model_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
      },
      error: output.ok ? undefined : { code: -32602, message: 'factor model shadow 입력 부족' },
    };
  };
}

export function registerFactorModelShadowSkill(options = {}) {
  registerSkillHandler('factor-model-shadow', createFactorModelShadowHandler(options) as any);
}

export default {
  createFactorModelShadowHandler,
  registerFactorModelShadowSkill,
};
