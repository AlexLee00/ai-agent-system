// @ts-nocheck
import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildCandidateFromEntryTrigger,
  buildEntryDecisionDebate,
  evaluateEntryTriggerShadowCandidate,
} from '../../shared/entry-llm-shadow-judge.ts';
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
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestEntryShadow(queryFn, { triggerId, symbol, exchange }) {
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
       FROM investment.luna_entry_llm_shadow
      WHERE ${conds.join(' AND ')}
      ORDER BY observed_at DESC
      LIMIT 1`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function outputFromShadow(row, skillId, params = {}) {
  const deterministic = {
    fire: row.deterministic_fire === true,
    reason: row.deterministic_reason || null,
    confidence: toNumber(row.deterministic_confidence, 0),
  };
  const llm = {
    fire: row.llm_fire === true,
    confidence: toNumber(row.llm_confidence, 0),
    dynamicThreshold: toNumber(row.dynamic_threshold, 0.7),
    positionSizePct: toNumber(row.position_size_pct, 0.1),
    reasoning: row.reasoning || '',
    riskAssessment: row.risk_assessment || {},
  };
  return {
    ok: true,
    skill: skillId,
    symbol: row.symbol,
    exchange: row.exchange,
    market: row.market || marketForExchange(row.exchange),
    shadowMode: true,
    dataHealth: 'shadow_ready',
    deterministic,
    llm,
    debate: row.n_agent_debate || {},
    contextEvidence: row.context_evidence || {},
    match: row.match == null ? deterministic.fire === llm.fire : Boolean(row.match),
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: {
      triggerId: row.trigger_id || null,
      observedAt: row.observed_at || null,
      source: 'luna_entry_llm_shadow',
    },
  };
}

function outputFromCandidate(params = {}, skillId) {
  const exchange = normalizeExchange(params.exchange);
  const market = params.market || marketForExchange(exchange);
  const trigger = {
    id: params.triggerId || null,
    symbol: params.symbol || params.candidate?.symbol || null,
    exchange,
    setup_type: params.setupType || params.candidate?.setup_type || null,
    trigger_type: params.triggerType || params.candidate?.triggerType || 'mtf_alignment',
    confidence: params.confidence ?? params.candidate?.confidence ?? 0,
    predictive_score: params.predictiveScore ?? params.candidate?.predictiveScore ?? 0,
    trigger_context: { hints: params.triggerHints || params.candidate?.triggerHints || {} },
    trigger_meta: params.triggerMeta || params.candidate?.block_meta || {},
  };
  const evaluation = trigger.symbol
    ? evaluateEntryTriggerShadowCandidate(trigger, {
      market,
      exchange,
      regimeShadow: params.regimeShadow || null,
      contextEvidence: params.contextEvidence || {},
    })
    : null;
  const candidate = evaluation?.candidate || buildCandidateFromEntryTrigger(trigger, { market });
  const debate = evaluation?.debate || buildEntryDecisionDebate({
    candidate,
    fireReadiness: { ok: false, reason: 'symbol_missing', details: {} },
    contextEvidence: params.contextEvidence || {},
  });
  return {
    ok: Boolean(trigger.symbol),
    skill: skillId,
    symbol: trigger.symbol,
    exchange,
    market,
    shadowMode: true,
    dataHealth: trigger.symbol ? 'candidate_only' : 'input_missing',
    deterministic: evaluation?.input?.deterministic || {
      fire: false,
      reason: 'symbol_missing',
      confidence: 0,
    },
    llm: null,
    debate,
    contextEvidence: evaluation?.input?.contextEvidence || params.contextEvidence || {},
    match: null,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    evidence: {
      triggerId: trigger.id,
      observedAt: null,
      source: 'candidate_params',
    },
  };
}

export function createEntryDecisionShadowHandler({ queryFn = defaultQuery, skillId = 'entry-decision-shadow' } = {}) {
  return async function entryDecisionShadow(params = {}) {
    const hasExplicitExchange = params?.exchange != null && String(params.exchange).trim() !== '';
    const exchange = hasExplicitExchange ? normalizeExchange(params?.exchange) : normalizeExchange(params?.candidate?.exchange);
    const lookupExchange = hasExplicitExchange || !params?.triggerId ? exchange : null;
    const row = await latestEntryShadow(queryFn, {
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
        source: row ? 'luna_entry_llm_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
      },
      error: output.ok ? undefined : { code: -32602, message: 'symbol 또는 triggerId 필요' },
    };
  };
}

export function registerEntryDecisionShadowSkill(options = {}) {
  registerSkillHandler('entry-decision-shadow', createEntryDecisionShadowHandler({ ...options, skillId: 'entry-decision-shadow' }));
  registerSkillHandler('trade-signal-generation', createEntryDecisionShadowHandler({ ...options, skillId: 'trade-signal-generation' }));
  registerSkillHandler('n-agent-debate', createEntryDecisionShadowHandler({ ...options, skillId: 'n-agent-debate' }));
}

export default {
  createEntryDecisionShadowHandler,
  registerEntryDecisionShadowSkill,
};
