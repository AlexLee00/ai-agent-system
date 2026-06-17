// @ts-nocheck

import { callViaHub } from './hub-llm-client.ts';
import { validateAlphaCandidate } from './luna-alpha-factor-expression.ts';

const DEFAULT_FIXTURES = Object.freeze([
  {
    name: 'momentum_quality_volume',
    expression: '(return_20d * 0.55) + (roe * 0.35) + (log(volume) * 0.02)',
    hypothesis: 'Medium-term winners with improving quality and sufficient liquidity can keep attracting institutional flow.',
    universe: 'domestic_equity',
    generatedBy: 'fixture',
  },
  {
    name: 'value_reversal_quality',
    expression: '(1 / max(pbr, 0.1)) + (return_5d * -0.25) + (roe * 0.2)',
    hypothesis: 'Profitable low valuation names that recently pulled back can mean-revert when quality remains intact.',
    universe: 'domestic_equity',
    generatedBy: 'fixture',
  },
]);

function extractJsonArray(text: string) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.candidates || [];
  } catch {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    }
  }
  return [];
}

export function fixtureAlphaCandidates(options: any = {}) {
  const maxComplexity = Number(options.maxComplexity ?? 12);
  return DEFAULT_FIXTURES.map((candidate) => validateAlphaCandidate(candidate, { ...options, maxComplexity }));
}

export async function generateAlphaFactorCandidates(options: any = {}, deps: any = {}) {
  const maxComplexity = Number(options.maxComplexity ?? 12);
  const limit = Math.max(1, Math.min(10, Number(options.limit ?? 2)));
  if (!options.llm) {
    return {
      ok: true,
      source: 'fixture',
      candidates: fixtureAlphaCandidates({ ...options, maxComplexity }).slice(0, limit),
      error: null,
    };
  }

  const hubCall = deps.callViaHub || callViaHub;
  const systemPrompt = [
    'You generate shadow-only quantitative alpha factor candidates.',
    'Return JSON array only.',
    'Each item must include name, expression, hypothesis, universe.',
    `Expression complexity must be <= ${maxComplexity}.`,
    'Use only allowed fields: open, high, low, close, volume, marketCap, pbr, roe, revenueGrowth, momentum, return_1d, return_5d, return_20d, return_60d, volatility_20d.',
    'Do not include code, SQL, network, filesystem, or execution instructions.',
  ].join('\n');
  const userPrompt = `Generate ${limit} domestic equity alpha factors with clear economic hypotheses.`;
  try {
    const result = await hubCall('luna', systemPrompt, userPrompt, {
      taskType: 'alpha_factor_discovery',
      market: options.market || 'domestic',
      urgency: 'low',
      maxTokens: 1600,
      callerTeam: 'luna',
    });
    if (!result?.ok) throw new Error(result?.error || 'hub_llm_failed');
    const rawCandidates = extractJsonArray(result.text);
    const candidates = rawCandidates
      .map((candidate) => validateAlphaCandidate({ ...candidate, generatedBy: result.provider || 'hub_llm' }, { ...options, maxComplexity }))
      .slice(0, limit);
    if (!candidates.length) throw new Error('hub_llm_empty_candidates');
    return { ok: true, source: 'hub_llm', candidates, error: null };
  } catch (error) {
    return {
      ok: true,
      source: 'fixture_fallback',
      candidates: fixtureAlphaCandidates({ ...options, maxComplexity }).slice(0, limit),
      error: error?.message || String(error),
    };
  }
}
