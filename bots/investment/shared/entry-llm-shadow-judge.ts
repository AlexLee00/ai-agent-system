// @ts-nocheck
import { buildEntryTriggerFireReadiness } from './entry-trigger-engine.ts';

const REGIME_RISK = Object.freeze({
  trending_bull: 0.15,
  ranging: 0.45,
  volatile: 0.65,
  trending_bear: 0.8,
  unknown: 0.55,
});

const MAX_CONTEXT_ANALYSIS_ROWS = 12;

function redactSensitiveText(value = '', limit = 240) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=:-]{8,}/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

function redactSensitiveValue(value, depth = 0) {
  if (depth > 6) return '[redacted:depth]';
  if (typeof value === 'string') return redactSensitiveText(value, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactSensitiveValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 80).map(([key, item]) => {
        if (/token|secret|password|credential|authorization|api[_-]?key/i.test(key)) {
          return [key, '[redacted]'];
        }
        return [key, redactSensitiveValue(item, depth + 1)];
      }),
    );
  }
  return redactSensitiveText(value, 1000);
}

function finiteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max, fallback = min) {
  const num = finiteNumber(value, fallback);
  return Math.max(min, Math.min(max, num));
}

function clamp01(value, fallback = 0) {
  return clamp(value, 0, 1, fallback);
}

function normalizeRatio(value, fallback = 0) {
  const raw = finiteNumber(value, fallback);
  const ratio = raw > 1 ? raw / 100 : raw;
  return clamp01(ratio, fallback);
}

function normalizeDynamicThreshold(value, fallback = 0.7) {
  return clamp(normalizeRatio(value, fallback), 0.5, 0.9, fallback);
}

function normalizePositionSizePct(value, fallback = 0.1) {
  return clamp01(normalizeRatio(value, fallback), fallback);
}

function extractJson(text = '') {
  if (typeof text === 'object' && text !== null) return text;
  const cleaned = String(text || '').replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('entry_llm_json_not_found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeAnalysisEvidence(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .slice(0, MAX_CONTEXT_ANALYSIS_ROWS)
    .map((row) => ({
      analyst: String(row?.analyst || '').slice(0, 32),
      signal: String(row?.signal || '').toUpperCase().slice(0, 12),
      confidence: clamp01(row?.confidence, 0),
      createdAt: row?.createdAt || row?.created_at || null,
      reasoning: redactSensitiveText(row?.reasoning, 240),
    }))
    .filter((row) => row.analyst && row.signal);
}

function normalizeContextEvidence(evidence = {}) {
  const analysisRows = normalizeAnalysisEvidence(evidence.analysis?.recent || evidence.recentAnalysis || []);
  const signalCounts = analysisRows.reduce((acc, row) => {
    acc[row.signal] = (acc[row.signal] || 0) + 1;
    return acc;
  }, {});
  const openPositions = evidence.openPositions || evidence.positions || {};
  return {
    analysis: {
      recent: analysisRows,
      signalCounts,
      latestAt: analysisRows
        .map((row) => row.createdAt)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    },
    risk: {
      sameSymbolOpen: Math.max(0, finiteNumber(openPositions.sameSymbolOpen ?? evidence.sameSymbolOpen, 0)),
      openPositionCount: Math.max(0, finiteNumber(openPositions.openPositionCount ?? evidence.openPositionCount, 0)),
      exchangeOpenPositionCount: Math.max(0, finiteNumber(openPositions.exchangeOpenPositionCount ?? evidence.exchangeOpenPositionCount, 0)),
      capitalMode: String(evidence.capital?.mode || evidence.capitalMode || '').slice(0, 48) || null,
      balanceStatus: String(evidence.capital?.balanceStatus || evidence.balanceStatus || '').slice(0, 48) || null,
    },
  };
}

export function normalizeEntryLlmShadowResult(raw, fallback = {}) {
  const parsed = extractJson(raw);
  const confidence = normalizeRatio(parsed.confidence ?? parsed.score, fallback.confidence ?? 0.5);
  const dynamicThreshold = normalizeDynamicThreshold(
    parsed.dynamicThreshold ?? parsed.dynamic_threshold ?? parsed.threshold,
    fallback.dynamicThreshold ?? 0.7,
  );
  const positionSizePct = normalizePositionSizePct(
    parsed.positionSizePct ?? parsed.position_size_pct ?? parsed.size_pct,
    fallback.positionSizePct ?? 0.1,
  );
  const fire = typeof parsed.fire === 'boolean'
    ? parsed.fire
    : confidence >= dynamicThreshold;
  const riskAssessment = parsed.riskAssessment || parsed.risk_assessment || {};
  return {
    fire,
    confidence,
    dynamicThreshold,
    positionSizePct,
    reasoning: redactSensitiveText(parsed.reasoning || parsed.rationale || '', 1600),
    riskAssessment: riskAssessment && typeof riskAssessment === 'object'
      ? redactSensitiveValue(riskAssessment)
      : {},
    shadowOnly: true,
  };
}

export function buildEntryDecisionDebate({ candidate = {}, fireReadiness = {}, regimeShadow = null, contextEvidence = {} } = {}) {
  const details = fireReadiness?.details || {};
  const confidence = clamp01(candidate.confidence, 0);
  const predictiveScore = clamp01(candidate.predictiveScore, 0);
  const mtfAgreement = clamp01(details.mtfAgreement, 0);
  const discoveryScore = clamp01(details.discoveryScore, 0);
  const volumeBurstScore = clamp01(finiteNumber(details.volumeBurst, 0) / 2, 0);
  const regime = String(regimeShadow?.llm_regime || regimeShadow?.llmRegime || regimeShadow?.rule_regime || regimeShadow?.ruleRegime || 'unknown');
  const regimeRisk = REGIME_RISK[regime] ?? REGIME_RISK.unknown;
  const normalizedContext = normalizeContextEvidence(contextEvidence);
  const sameSymbolOpen = normalizedContext.risk.sameSymbolOpen > 0;
  const fireOk = fireReadiness?.ok === true;
  const technicalScore = clamp01((mtfAgreement * 0.35) + (discoveryScore * 0.25) + (volumeBurstScore * 0.15) + (confidence * 0.25), 0);
  const quantScore = clamp01((confidence * 0.35) + (predictiveScore * 0.35) + (mtfAgreement * 0.3), 0);
  const riskScore = clamp01((regimeRisk * 0.45) + (fireOk ? 0.1 : 0.35) + (confidence < 0.5 ? 0.2 : 0) + (sameSymbolOpen ? 0.35 : 0), 0);
  const bullVote = fireOk || technicalScore >= 0.62;
  const quantVote = quantScore >= 0.6;
  const riskVeto = riskScore >= 0.74;
  const finalFire = bullVote && quantVote && !riskVeto;
  return {
    agents: {
      zeusBull: {
        stance: bullVote ? 'support' : 'wait',
        score: Number(technicalScore.toFixed(4)),
        reason: fireOk ? fireReadiness.reason || 'deterministic_fire_ready' : 'technical_confirmation_incomplete',
      },
      athenaBear: {
        stance: fireOk ? 'watch' : 'oppose',
        score: Number((1 - technicalScore).toFixed(4)),
        reason: fireOk ? 'bear_case_not_dominant' : fireReadiness.reason || 'entry_condition_unmet',
      },
      hermesQuant: {
        stance: quantVote ? 'support' : 'wait',
        score: Number(quantScore.toFixed(4)),
        reason: 'confidence_predictive_mtf_composite',
      },
      nemesisRisk: {
        stance: riskVeto ? 'veto' : 'allow_shadow',
        score: Number(riskScore.toFixed(4)),
        reason: sameSymbolOpen ? 'same_symbol_open_position_risk' : riskVeto ? 'risk_score_high' : 'risk_within_shadow_observation',
      },
    },
    finalVote: {
      fire: finalFire,
      confidence: Number(clamp01((technicalScore + quantScore + (1 - riskScore)) / 3, 0).toFixed(4)),
      reason: finalFire ? 'debate_shadow_consensus_supports_entry' : 'debate_shadow_consensus_wait',
    },
  };
}

export function buildEntryLlmJudgeInput({ trigger = {}, candidate = {}, fireReadiness = {}, regimeShadow = null, contextEvidence = {} } = {}) {
  const normalizedContext = normalizeContextEvidence(contextEvidence);
  const debate = buildEntryDecisionDebate({ candidate, fireReadiness, regimeShadow, contextEvidence: normalizedContext });
  const details = fireReadiness?.details || {};
  const deterministicConfidence = clamp01(candidate.confidence ?? trigger.confidence, 0);
  const fixedThreshold = normalizeDynamicThreshold(
    details.minConfidence ?? details.minPredictiveScore ?? 0.7,
    0.7,
  );
  return {
    triggerId: trigger.id || null,
    symbol: candidate.symbol || trigger.symbol || null,
    exchange: candidate.exchange || trigger.exchange || 'binance',
    market: candidate.market || null,
    triggerType: candidate.triggerType || trigger.trigger_type || null,
    deterministic: {
      fire: fireReadiness?.ok === true,
      reason: fireReadiness?.reason || 'unknown',
      confidence: deterministicConfidence,
      fixedThreshold,
      details,
    },
    regime: regimeShadow ? {
      ruleRegime: regimeShadow.rule_regime || regimeShadow.ruleRegime || null,
      llmRegime: regimeShadow.llm_regime || regimeShadow.llmRegime || null,
      confidence: normalizeRatio(regimeShadow.llm_confidence ?? regimeShadow.llmConfidence, 0.5),
      capturedAt: regimeShadow.captured_at || regimeShadow.capturedAt || null,
    } : null,
    contextEvidence: normalizedContext,
    debate,
    candidate: {
      confidence: deterministicConfidence,
      predictiveScore: clamp01(candidate.predictiveScore, 0),
      setupType: candidate.setup_type || candidate.setupType || trigger.setup_type || null,
      hints: candidate.triggerHints || {},
    },
  };
}

export function buildEntryLlmPrompt(input = {}) {
  const safeInput = redactSensitiveText(JSON.stringify(input, null, 2), 6000);
  return [
    '너는 Luna Phase 2 Entry Decision LLM Shadow Judge다.',
    '실거래 권한은 없고, 기존 fixed threshold 판단과 비교할 shadow 판단만 JSON으로 반환한다.',
    'dynamicThreshold는 0.50~0.90 사이, confidence와 position_size_pct는 0~100 또는 0~1 모두 허용된다.',
    '',
    '[entry_context]',
    safeInput,
    '',
    '응답은 코드블록 없이 JSON 객체만 출력한다.',
    '{"fire":false,"confidence":62,"dynamic_threshold":70,"position_size_pct":10,"reasoning":"한 문장 근거","risk_assessment":{"risk_level":"medium","main_risk":"근거"}}',
  ].join('\n');
}

export function buildCandidateFromEntryTrigger(trigger = {}, { market = null } = {}) {
  const context = trigger.trigger_context || {};
  const meta = trigger.trigger_meta || {};
  const hints = {
    ...(context.hints || {}),
    ...(meta.event?.triggerHints || {}),
  };
  return {
    symbol: trigger.symbol,
    action: 'BUY',
    market,
    exchange: trigger.exchange || 'binance',
    confidence: finiteNumber(trigger.confidence, 0),
    setup_type: trigger.setup_type || null,
    triggerType: trigger.trigger_type || null,
    predictiveScore: finiteNumber(trigger.predictive_score, 0),
    triggerHints: hints,
    block_meta: meta,
  };
}

export function evaluateEntryTriggerShadowCandidate(trigger = {}, context = {}) {
  const candidate = buildCandidateFromEntryTrigger(trigger, context);
  const fireReadiness = buildEntryTriggerFireReadiness(candidate, context);
  const input = buildEntryLlmJudgeInput({
    trigger,
    candidate,
    fireReadiness,
    regimeShadow: context.regimeShadow || null,
    contextEvidence: context.contextEvidence || context.evidence || {},
  });
  return { candidate, fireReadiness, input, debate: input.debate };
}

export default {
  normalizeEntryLlmShadowResult,
  buildEntryDecisionDebate,
  buildEntryLlmJudgeInput,
  buildEntryLlmPrompt,
  buildCandidateFromEntryTrigger,
  evaluateEntryTriggerShadowCandidate,
};
