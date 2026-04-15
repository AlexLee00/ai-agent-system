// @ts-nocheck

function normalizePlannerContext(payload = {}) {
  return payload?.planner_context || payload?.plannerContext || null;
}

export function buildPreScreenPlannerCompact(payload = {}) {
  const plannerContext = normalizePlannerContext(payload) || {};
  const compact = plannerContext?.planner?.compact || {};

  return {
    market: payload?.market || plannerContext?.market || 'unknown',
    source: payload?.source || 'unknown',
    symbolCount: Array.isArray(payload?.symbols) ? payload.symbols.length : 0,
    timeMode: plannerContext?.timeMode || 'unknown',
    tradeMode: plannerContext?.tradeMode || 'normal',
    researchOnly: Boolean(plannerContext?.researchOnly),
    mode: compact?.mode || 'unknown',
    shouldAnalyze: Boolean(compact?.shouldAnalyze),
    researchDepth: Number(compact?.researchDepth || 0),
    skipReason: compact?.skipReason || null,
  };
}

export function renderPreScreenPlannerReport(payload = {}) {
  const compact = buildPreScreenPlannerCompact(payload);

  const lines = [
    `market: ${compact.market}`,
    `source: ${compact.source}`,
    `symbols: ${compact.symbolCount}`,
    `timeMode: ${compact.timeMode}`,
    `tradeMode: ${compact.tradeMode}`,
    `researchOnly: ${compact.researchOnly ? 'yes' : 'no'}`,
    `mode: ${compact.mode}`,
    `shouldAnalyze: ${compact.shouldAnalyze ? 'yes' : 'no'}`,
    `researchDepth: ${compact.researchDepth}`,
  ];

  if (compact.skipReason) {
    lines.push(`skipReason: ${compact.skipReason}`);
  }

  return lines.join('\n');
}

export function buildPreScreenPlannerReport(payload = {}) {
  return {
    compact: buildPreScreenPlannerCompact(payload),
    text: renderPreScreenPlannerReport(payload),
  };
}

export default {
  buildPreScreenPlannerCompact,
  buildPreScreenPlannerReport,
  renderPreScreenPlannerReport,
};
