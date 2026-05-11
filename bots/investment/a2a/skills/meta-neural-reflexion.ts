// @ts-nocheck
import { query as defaultQuery } from '../../shared/db.ts';
import {
  buildDeterministicMetaNeuralReflexion,
  buildMetaNeuralReflexionInput,
  buildMetaReflexionTelegramPayload,
  expandMetaReflexionLayers,
  redactMetaReflexionValue,
} from '../../shared/meta-neural-reflexion-shadow.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function latestMetaReflexionShadow(queryFn, { layer, scope }) {
  const params = [];
  const conds = [`event_type = 'luna_meta_reflexion_shadow'`];
  if (layer && layer !== 'all') {
    params.push(layer);
    conds.push(`payload->>'layer' = $${params.length}`);
  }
  if (scope) {
    params.push(scope);
    conds.push(`payload->>'scope' = $${params.length}`);
  }
  const rows = await Promise.resolve(queryFn(
    `SELECT event_type, payload, created_at
       FROM investment.mapek_knowledge
      WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT 1`,
    params,
  )).catch(() => []);
  return Array.isArray(rows) ? rows[0] || null : null;
}

function outputFromShadow(row, skillId, params = {}) {
  const payload = redactMetaReflexionValue(parsePayload(row.payload, {}));
  return {
    ok: true,
    skill: skillId,
    layer: payload.layer || params.layer || 'all',
    scope: payload.scope || params.scope || 'luna_phase4_shadow',
    shadowMode: true,
    dataHealth: 'shadow_ready',
    recommendations: payload.recommendations || payload.deterministic?.recommendations || [],
    lossPatterns: payload.lossPatterns || payload.deterministic?.lossPatterns || [],
    policyRecommendations: payload.policyRecommendations || payload.deterministic?.policyRecommendations || {},
    riskAssessment: payload.riskAssessment || payload.deterministic?.riskAssessment || {},
    confidence: payload.confidence ?? payload.deterministic?.confidence ?? 0,
    priority: payload.priority || payload.deterministic?.priority || 'LOW',
    memoryWritePlanned: payload.memoryWritePlanned !== false,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    telegramPayload: payload.telegramPayload || buildMetaReflexionTelegramPayload(payload),
    evidence: {
      source: 'investment.mapek_knowledge:luna_meta_reflexion_shadow',
      observedAt: row.created_at || payload.observedAt || null,
    },
  };
}

function outputFromParams(params = {}, skillId) {
  const layer = expandMetaReflexionLayers(params.layer || 'l2')[0] || 'l2';
  const input = buildMetaNeuralReflexionInput({
    layer,
    periodStart: params.periodStart || null,
    periodEnd: params.periodEnd || null,
    dpoRows: params.dpoRows || [],
    mapekRows: params.mapekRows || [],
    scope: params.scope || 'luna_phase4_shadow',
  });
  const deterministic = buildDeterministicMetaNeuralReflexion(input);
  const payload = {
    layer,
    scope: input.scope,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    input,
    deterministic,
    recommendations: deterministic.recommendations,
    lossPatterns: deterministic.lossPatterns,
    policyRecommendations: deterministic.policyRecommendations,
    riskAssessment: deterministic.riskAssessment,
    confidence: deterministic.confidence,
    priority: deterministic.priority,
    memoryWritePlanned: true,
    broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
    shadowOnly: true,
  };
  return {
    ok: true,
    skill: skillId,
    layer,
    scope: payload.scope,
    shadowMode: true,
    dataHealth: input.tradeSummary.totalTrades > 0 ? 'candidate_only' : 'no_shadow_evidence',
    recommendations: payload.recommendations,
    lossPatterns: payload.lossPatterns,
    policyRecommendations: payload.policyRecommendations,
    riskAssessment: payload.riskAssessment,
    confidence: payload.confidence,
    priority: payload.priority,
    memoryWritePlanned: true,
    broadcastPlanned: payload.broadcastPlanned,
    telegramPayload: buildMetaReflexionTelegramPayload(payload),
    evidence: {
      source: 'candidate_params',
      observedAt: null,
    },
  };
}

export function createMetaNeuralReflexionHandler({ queryFn = defaultQuery, skillId = 'meta-neural-reflexion' } = {}) {
  return async function metaNeuralReflexion(params = {}) {
    const layer = expandMetaReflexionLayers(params?.layer || 'all')[0] || 'l2';
    const row = await latestMetaReflexionShadow(queryFn, {
      layer: params?.layer === 'all' ? null : layer,
      scope: params?.scope || null,
    });
    const output = row ? outputFromShadow(row, skillId, params) : outputFromParams({ ...params, layer }, skillId);
    return {
      status: output.ok ? 'completed' : 'failed',
      output,
      metadata: {
        source: row ? 'luna_meta_reflexion_shadow' : 'candidate_params',
        dataHealth: output.dataHealth,
        broadcastEnabled: broadcastEnabled(),
      },
      error: output.ok ? undefined : { code: -32602, message: 'meta reflexion 입력 부족' },
    };
  };
}

export function registerMetaNeuralReflexionSkill(options = {}) {
  registerSkillHandler('meta-neural-reflexion', createMetaNeuralReflexionHandler(options));
}

export default {
  createMetaNeuralReflexionHandler,
  registerMetaNeuralReflexionSkill,
};
