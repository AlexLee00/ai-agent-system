// @ts-nocheck
import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildRuleDynamicTpSl,
  compareTpSl,
} from '../../shared/dynamic-tpsl-shadow-judge.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function normalizeExchange(value) {
  const raw = String(value || 'binance').trim().toLowerCase();
  if (raw === 'domestic') return 'kis';
  if (raw === 'overseas') return 'kis_overseas';
  if (raw === 'crypto') return 'binance';
  return ['binance', 'kis', 'kis_overseas'].includes(raw) ? raw : 'binance';
}

function marketForExchange(exchange) {
  if (exchange === 'kis') return 'domestic';
  if (exchange === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestDynamicTpSlShadow(queryFn, { triggerId, symbol, exchange }) {
  const conds = [];
  const params = [];
  if (triggerId) {
    params.push(triggerId);
    conds.push(`trigger_id = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol);
    conds.push(`symbol = $${params.length}`);
  }
  if (exchange) {
    params.push(exchange);
    conds.push(`exchange = $${params.length}`);
  }
  if (conds.length === 0) return null;
  const rows = await Promise.resolve(queryFn(
    `SELECT *
       FROM investment.luna_dynamic_tpsl_shadow
      WHERE ${conds.join(' AND ')}
      ORDER BY observed_at DESC
      LIMIT 1`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function outputFromShadow(row, skillId, params = {}) {
  const ruleTpSl = {
    tpPct: toNumber(row.rule_tp_pct, 0),
    slPct: toNumber(row.rule_sl_pct, 0),
    takeProfit: toNumber(row.rule_tp_price, null),
    stopLoss: toNumber(row.rule_sl_price, null),
  };
  const llmTpSl = {
    tpPct: toNumber(row.llm_tp_pct, 0),
    slPct: toNumber(row.llm_sl_pct, 0),
    takeProfit: toNumber(row.llm_tp_price, null),
    stopLoss: toNumber(row.llm_sl_price, null),
    rrRatio: toNumber(row.rr_ratio, 0),
    reasoning: row.reasoning || '',
    riskAssessment: row.risk_assessment || {},
  };
  const comparison = compareTpSl(ruleTpSl, llmTpSl);
  return {
    ok: true,
    skill: skillId,
    symbol: row.symbol,
    exchange: row.exchange,
    market: row.market || marketForExchange(row.exchange),
    shadowMode: true,
    dataHealth: 'shadow_ready',
    entryPrice: toNumber(row.entry_price, null),
    ruleTpSl,
    llmTpSl,
    rrRatio: llmTpSl.rrRatio,
    match: row.match == null ? comparison.match : Boolean(row.match),
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: {
      triggerId: row.trigger_id || null,
      observedAt: row.observed_at || null,
      source: 'luna_dynamic_tpsl_shadow',
    },
  };
}

function outputFromCandidate(params = {}, skillId) {
  const exchange = normalizeExchange(params.exchange || params.candidate?.exchange);
  const market = params.market || marketForExchange(exchange);
  const candidate = {
    ...(params.candidate || {}),
    symbol: params.symbol || params.candidate?.symbol || null,
    exchange,
    market,
    entry_price: params.entryPrice ?? params.entry_price ?? params.candidate?.entry_price ?? params.candidate?.entryPrice ?? null,
    atr: params.atr ?? params.candidate?.atr ?? null,
    setup_type: params.setupType || params.candidate?.setup_type || null,
    side: params.side || params.candidate?.side || 'BUY',
  };
  const ruleTpSl = buildRuleDynamicTpSl({
    candidate,
    regimeShadow: params.regimeShadow || null,
    entryShadow: null,
    context: params.contextEvidence || {},
  });
  return {
    ok: Boolean(candidate.symbol && ruleTpSl.ok),
    skill: skillId,
    symbol: candidate.symbol,
    exchange,
    market,
    shadowMode: true,
    dataHealth: candidate.symbol ? (ruleTpSl.ok ? 'candidate_only' : 'rule_tpsl_not_ready') : 'input_missing',
    entryPrice: ruleTpSl.entryPrice || null,
    ruleTpSl,
    llmTpSl: null,
    rrRatio: ruleTpSl.rrRatio || null,
    match: null,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: {
      triggerId: params.triggerId || null,
      observedAt: null,
      source: 'candidate_params',
    },
  };
}

export function createDynamicTpSlShadowHandler({ queryFn = defaultQuery, skillId = 'dynamic-tpsl-shadow' } = {}) {
  return async function dynamicTpSlShadow(params = {}) {
    const hasExplicitExchange = params?.exchange != null && String(params.exchange).trim() !== '';
    const exchange = hasExplicitExchange ? normalizeExchange(params.exchange) : normalizeExchange(params?.candidate?.exchange);
    const lookupExchange = hasExplicitExchange || !params?.triggerId ? exchange : null;
    const row = await latestDynamicTpSlShadow(queryFn, {
      triggerId: params?.triggerId,
      symbol: params?.symbol,
      exchange: lookupExchange,
    });
    const output = row
      ? outputFromShadow(row, skillId, params)
      : outputFromCandidate({ ...params, exchange }, skillId);
    return {
      status: output.ok ? 'completed' : 'failed',
      output,
      metadata: {
        source: row ? 'luna_dynamic_tpsl_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
      },
      error: output.ok ? undefined : { code: -32602, message: 'symbol과 entryPrice/ATR 또는 triggerId 필요' },
    };
  };
}

export function registerDynamicTpSlShadowSkill(options = {}) {
  registerSkillHandler('dynamic-tpsl-shadow', createDynamicTpSlShadowHandler(options));
}

export default {
  createDynamicTpSlShadowHandler,
  registerDynamicTpSlShadowSkill,
};
