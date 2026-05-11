import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildMeanReversionShadow,
  buildPairsTradingShadow,
  marketForStatArbExchange,
  normalizeStatArbExchange,
  normalizeStatArbShadowRow,
} from '../../shared/stat-arb-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestStatArbShadowRows(queryFn, { strategyType, symbol, exchange, market, limit }) {
  const conds = [];
  const params = [];
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

function outputFromShadow(shadow, skillId, params = {}) {
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

function outputFromRows(rows = [], skillId, params = {}) {
  const normalized = rows.map(normalizeStatArbShadowRow);
  const primary = normalized[0] || {};
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

function outputFromCandidate(params = {}, skillId) {
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

export function createStatArbShadowHandler({ queryFn = defaultQuery, skillId = 'stat-arb-shadow' } = {}) {
  return async function statArbShadow(params = {}) {
    const exchange = params.exchange ? normalizeStatArbExchange(params.exchange) : null;
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
  registerSkillHandler('stat-arb-shadow', createStatArbShadowHandler(options));
}

export default {
  createStatArbShadowHandler,
  registerStatArbShadowSkill,
};
