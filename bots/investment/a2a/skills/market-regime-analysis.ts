// @ts-nocheck
import { query as defaultQuery } from '../../shared/db.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

const VALID_MARKETS = new Set(['crypto', 'domestic', 'overseas']);

function normalizeMarket(value) {
  const market = String(value || 'crypto').trim().toLowerCase();
  return VALID_MARKETS.has(market) ? market : 'crypto';
}

function toNumber(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function broadcastEnabled() {
  return String(process.env.LUNA_A2A_BROADCAST_ENABLED || '').toLowerCase() === 'true';
}

async function latestRuleSnapshot(queryFn, market) {
  const rows = await Promise.resolve(queryFn(
    `SELECT regime, confidence, indicators, captured_at
       FROM investment.market_regime_snapshots
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    regime: row?.regime || 'unknown',
    confidence: toNumber(row?.confidence, 0.5),
    indicators: row?.indicators || {},
    capturedAt: row?.captured_at || null,
  };
}

async function latestShadowSnapshot(queryFn, market) {
  const rows = await Promise.resolve(queryFn(
    `SELECT rule_regime, rule_confidence, llm_regime, llm_confidence,
            llm_rationale, llm_duration, llm_key_signals, match, captured_at
       FROM investment.luna_regime_llm_shadow
      WHERE market = $1
      ORDER BY captured_at DESC
      LIMIT 1`,
    [market],
  )).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  return {
    ruleRegime: row.rule_regime || 'unknown',
    ruleConfidence: toNumber(row.rule_confidence, 0.5),
    llmRegime: row.llm_regime || 'unknown',
    llmConfidence: toNumber(row.llm_confidence, 0.5),
    rationale: row.llm_rationale || '',
    durationEstimate: row.llm_duration || '',
    keySignals: Array.isArray(row.llm_key_signals) ? row.llm_key_signals : [],
    match: Boolean(row.match),
    capturedAt: row.captured_at || null,
  };
}

export function createMarketRegimeAnalysisHandler({ queryFn = defaultQuery } = {}) {
  return async function marketRegimeAnalysis(params = {}) {
    const market = normalizeMarket(params?.market);
    const shadowMode = params?.shadowMode !== false;
    const [rule, shadow] = await Promise.all([
      latestRuleSnapshot(queryFn, market),
      latestShadowSnapshot(queryFn, market),
    ]);

    const llmRegime = shadow?.llmRegime || 'unknown';
    const dataHealth = shadow ? 'shadow_ready' : 'shadow_missing';
    const output = {
      ok: true,
      skill: 'market-regime-analysis',
      market,
      shadowMode,
      dataHealth,
      ruleRegime: shadow?.ruleRegime || rule.regime,
      llmRegime,
      confidence: shadow?.llmConfidence ?? rule.confidence,
      match: shadow ? shadow.match : null,
      broadcastPlanned: broadcastEnabled() && params?.broadcast !== false,
      rationale: shadow?.rationale || '',
      durationEstimate: shadow?.durationEstimate || '',
      keySignals: shadow?.keySignals || [],
      evidence: {
        ruleCapturedAt: rule.capturedAt,
        shadowCapturedAt: shadow?.capturedAt || null,
      },
    };

    return {
      status: 'completed',
      output,
      metadata: {
        source: shadow ? 'luna_regime_llm_shadow' : 'market_regime_snapshots',
        dataHealth,
        broadcastEnabled: broadcastEnabled(),
      },
    };
  };
}

export function registerMarketRegimeAnalysisSkill(options = {}) {
  registerSkillHandler('market-regime-analysis', createMarketRegimeAnalysisHandler(options));
}

export default {
  createMarketRegimeAnalysisHandler,
  registerMarketRegimeAnalysisSkill,
};
