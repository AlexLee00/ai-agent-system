// @ts-nocheck

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max, fallback = min) {
  const n = finiteNumber(value, fallback);
  return Math.max(min, Math.min(max, n));
}

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function redactSensitiveText(value = '', limit = 2000) {
  return String(value || '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer ***')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=:-]{8,}/gi, '$1=***')
    .replace(/\s+/g, ' ')
    .slice(0, limit);
}

export function redactMetaReflexionValue(value, depth = 0) {
  if (depth > 6) return '[redacted:depth]';
  if (typeof value === 'string') return redactSensitiveText(value, 4000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => redactMetaReflexionValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 120).map(([key, item]) => {
      if (/token|secret|password|credential|authorization|api[_-]?key/i.test(key)) return [key, '[redacted]'];
      return [key, redactMetaReflexionValue(item, depth + 1)];
    }));
  }
  return redactSensitiveText(value, 1000);
}

function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeLayer(value = 'all') {
  const raw = String(value || 'all').trim().toLowerCase();
  if (raw === '1' || raw === 'l1') return 'l1';
  if (raw === '2' || raw === 'l2') return 'l2';
  if (raw === '3' || raw === 'l3') return 'l3';
  return 'all';
}

export function expandMetaReflexionLayers(value = 'all') {
  const layer = normalizeLayer(value);
  return layer === 'all' ? ['l1', 'l2', 'l3'] : [layer];
}

function categoryCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const key = String(row.category || 'neutral').toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function sourceCounts(rows = []) {
  return rows.reduce((acc, row) => {
    const key = String(row.source || row.source_kind || 'unknown').toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function inferPattern(text = '') {
  const lower = String(text || '').toLowerCase();
  if (/stop|sl|손절|청산|exit/.test(lower)) return 'exit_or_stop_loss_quality';
  if (/entry|진입|timing|타이밍/.test(lower)) return 'entry_timing_quality';
  if (/trend|regime|추세|시장/.test(lower)) return 'regime_alignment_quality';
  if (/risk|sizing|size|비중|리스크/.test(lower)) return 'risk_sizing_quality';
  if (/volume|거래량|liquidity|유동성/.test(lower)) return 'liquidity_volume_quality';
  if (/sentiment|news|뉴스|감성/.test(lower)) return 'external_evidence_quality';
  return 'trade_rationale_quality';
}

function normalizeFeedbackRow(row = {}) {
  const score = finiteNumber(row.score ?? row.overall_score ?? row.overallScore, 0);
  const outcomeSummary = parseJsonMaybe(row.outcome_summary ?? row.outcomeSummary ?? row.sub_score_breakdown, {});
  const fiveWhy = parseJsonMaybe(row.five_why, {});
  const stageAttribution = parseJsonMaybe(row.stage_attribution, {});
  const avoidPattern = parseJsonMaybe(row.avoid_pattern, {});
  const critique = [
    row.critique,
    row.hindsight,
    row.rationale,
    Object.keys(fiveWhy).length ? JSON.stringify(fiveWhy) : '',
    Object.keys(stageAttribution).length ? JSON.stringify(stageAttribution) : '',
    Object.keys(avoidPattern).length ? JSON.stringify(avoidPattern) : '',
  ].filter(Boolean).join(' ');
  const explicitCategory = String(row.category || '').toLowerCase();
  const category = explicitCategory || (score >= 0.7 ? 'preferred' : score <= 0.45 ? 'rejected' : 'neutral');
  return {
    ...row,
    score,
    category,
    critique,
    outcome_summary: outcomeSummary,
    source: row.source || row.source_kind || 'unknown',
  };
}

function summarizeFeedbackRows(rows = []) {
  const safeRows = (Array.isArray(rows) ? rows : []).map(normalizeFeedbackRow);
  const counts = categoryCounts(safeRows);
  const scores = safeRows.map((row) => finiteNumber(row.score, 0)).filter((n) => Number.isFinite(n));
  const rejected = safeRows.filter((row) => String(row.category || '').toLowerCase() === 'rejected');
  const preferred = safeRows.filter((row) => String(row.category || '').toLowerCase() === 'preferred');
  const lossPatterns = Object.entries(rejected.reduce((acc, row) => {
    const pattern = inferPattern(`${row.critique || ''} ${JSON.stringify(parseJsonMaybe(row.outcome_summary, {}))}`);
    acc[pattern] = (acc[pattern] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]).map(([pattern, count]) => ({ pattern, count }));

  return {
    totalTrades: safeRows.length,
    sourceCounts: sourceCounts(safeRows),
    preferredCount: counts.preferred || 0,
    neutralCount: counts.neutral || 0,
    rejectedCount: counts.rejected || 0,
    avgScore: round(scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0, 4),
    preferredSamples: preferred.slice(0, 3).map((row) => redactSensitiveText(row.critique || '', 240)),
    rejectedSamples: rejected.slice(0, 3).map((row) => redactSensitiveText(row.critique || '', 240)),
    lossPatterns,
  };
}

function summarizeMapekRows(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return safeRows.slice(0, 20).map((row) => {
    const payload = parseJsonMaybe(row.payload, row.payload || {});
    return {
      eventType: row.event_type || row.eventType || null,
      createdAt: row.created_at || row.createdAt || null,
      payload: redactMetaReflexionValue(payload),
    };
  });
}

function deterministicRecommendations(layer, tradeSummary) {
  const recs = [];
  if (tradeSummary.totalTrades === 0) {
    recs.push('최근 거래 표본이 없어 정책 변경 대신 관찰을 유지한다.');
  }
  if (tradeSummary.rejectedCount > tradeSummary.preferredCount) {
    recs.push('rejected 거래가 preferred보다 많으므로 다음 cycle에서 진입 근거와 리스크 비중을 보수적으로 재검증한다.');
  }
  if (tradeSummary.avgScore > 0 && tradeSummary.avgScore < 0.5) {
    recs.push('평균 self-reward score가 낮으므로 L2 일일 분석에서 실패 critique 상위 패턴을 우선 검토한다.');
  }
  if (tradeSummary.lossPatterns.some((p) => p.pattern === 'entry_timing_quality')) {
    recs.push('entry timing 실패 패턴은 Phase 2 Entry LLM Shadow와 비교해 dynamic threshold 후보로만 기록한다.');
  }
  if (tradeSummary.lossPatterns.some((p) => p.pattern === 'exit_or_stop_loss_quality')) {
    recs.push('exit/SL 실패 패턴은 Phase 3 Dynamic TP/SL Shadow evidence와 비교하고 live TP/SL은 변경하지 않는다.');
  }
  if (layer === 'l3') {
    recs.push('주간 전략 진화 권고는 Darwin R&D 요청 후보로만 공유하고 broadcast는 기본 OFF로 둔다.');
  }
  if (recs.length === 0) {
    recs.push('현재 표본에서는 정책 변경보다 shadow evidence 누적을 우선한다.');
  }
  return recs.slice(0, 5);
}

export function buildMetaNeuralReflexionInput({
  layer = 'l2',
  periodStart = null,
  periodEnd = null,
  feedbackRows = null,
  dpoRows = [],
  qualityRows = [],
  failureRows = [],
  mapekRows = [],
  scope = 'luna_phase4_shadow',
} = {}) {
  const normalizedLayer = normalizeLayer(layer) === 'all' ? 'l2' : normalizeLayer(layer);
  const sourceRows = Array.isArray(feedbackRows)
    ? feedbackRows
    : [...(Array.isArray(dpoRows) ? dpoRows : []), ...(Array.isArray(qualityRows) ? qualityRows : []), ...(Array.isArray(failureRows) ? failureRows : [])];
  const tradeSummary = summarizeFeedbackRows(sourceRows);
  return {
    layer: normalizedLayer,
    scope,
    periodStart,
    periodEnd,
    tradeSummary,
    existingReflexionEvidence: summarizeMapekRows(mapekRows),
  };
}

export function buildDeterministicMetaNeuralReflexion(input = {}) {
  const summary = input.tradeSummary || summarizeFeedbackRows([]);
  const recommendations = deterministicRecommendations(input.layer, summary);
  const confidence = summary.totalTrades >= 5
    ? clamp(0.55 + Math.min(summary.totalTrades, 20) / 100, 0.55, 0.8, 0.6)
    : clamp(0.35 + summary.totalTrades / 20, 0.2, 0.55, 0.35);
  const priority = summary.rejectedCount >= Math.max(2, summary.preferredCount) ? 'HIGH' : summary.totalTrades === 0 ? 'LOW' : 'MEDIUM';
  return {
    recommendations,
    lossPatterns: summary.lossPatterns,
    policyRecommendations: {
      layer2: recommendations.filter((item) => /진입|L2|threshold|리스크|검토/.test(item)),
      layer3: recommendations.filter((item) => /TP\/SL|exit|SL|Phase 3/.test(item)),
      layer4: recommendations,
      promotionAllowed: false,
      liveConfigMutationAllowed: false,
    },
    memoryWritePlan: {
      planned: true,
      target: 'investment.mapek_knowledge',
      eventType: 'luna_meta_reflexion_shadow',
    },
    riskAssessment: {
      riskLevel: priority === 'HIGH' ? 'medium' : 'low',
      mainRisk: summary.totalTrades === 0 ? 'insufficient_trade_samples' : 'policy_overfit_without_promotion_gate',
    },
    confidence: round(confidence, 3),
    priority,
    shadowOnly: true,
  };
}

function extractJson(text = '') {
  if (typeof text === 'object' && text !== null) return text;
  const cleaned = String(text || '').replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('meta_reflexion_json_not_found');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function arrayOfText(value, fallback = []) {
  const arr = Array.isArray(value) ? value : fallback;
  return arr.map((item) => redactSensitiveText(item, 500)).filter(Boolean).slice(0, 8);
}

export function normalizeMetaNeuralReflexionResult(raw, fallback = {}) {
  const parsed = extractJson(raw);
  const deterministic = fallback.deterministic || {};
  const recommendations = arrayOfText(parsed.recommendations || parsed.suggestions, deterministic.recommendations || []);
  return {
    recommendations,
    lossPatterns: redactMetaReflexionValue(parsed.lossPatterns || parsed.loss_patterns || deterministic.lossPatterns || []),
    policyRecommendations: redactMetaReflexionValue(parsed.policyRecommendations || parsed.policy_recommendations || deterministic.policyRecommendations || {}),
    memoryWritePlan: redactMetaReflexionValue(parsed.memoryWritePlan || parsed.memory_write_plan || deterministic.memoryWritePlan || {}),
    riskAssessment: redactMetaReflexionValue(parsed.riskAssessment || parsed.risk_assessment || deterministic.riskAssessment || {}),
    confidence: round(clamp(parsed.confidence, 0, 1, deterministic.confidence || 0.5), 3),
    priority: ['HIGH', 'MEDIUM', 'LOW'].includes(String(parsed.priority || '').toUpperCase())
      ? String(parsed.priority).toUpperCase()
      : deterministic.priority || 'MEDIUM',
    shadowOnly: true,
  };
}

export function buildMetaNeuralReflexionPrompt(input = {}, deterministic = {}) {
  const safeInput = redactSensitiveText(JSON.stringify({ input, deterministic }, null, 2), 7000);
  return [
    '너는 Luna Phase 4 Meta-Neural Reflexion Shadow Judge다.',
    '실거래, live config, TP/SL, 주문, 포지션을 변경할 권한은 없다.',
    '전일/주간 거래 self-reward 결과를 바탕으로 손실 패턴과 정책 추천만 JSON으로 작성한다.',
    '추천은 Phase 2 Entry LLM, Phase 3 Dynamic TP/SL, Phase 4 memory/reflexion으로 분리한다.',
    '응답은 JSON 객체만 반환한다.',
    '{"recommendations":["..."],"lossPatterns":[{"pattern":"...","count":1}],"policyRecommendations":{"layer2":[],"layer3":[],"layer4":[],"promotionAllowed":false,"liveConfigMutationAllowed":false},"riskAssessment":{"riskLevel":"low","mainRisk":"..."},"confidence":0.5,"priority":"LOW"}',
    '',
    safeInput,
  ].join('\n');
}

export function buildMetaReflexionTelegramPayload(row = {}) {
  const recs = row.recommendations || row.llm?.recommendations || row.deterministic?.recommendations || [];
  return {
    title: 'Luna Phase 4 Meta-Neural Reflexion Shadow',
    severity: row.priority === 'HIGH' ? 'warning' : 'info',
    layer: row.layer,
    scope: row.scope,
    period: `${row.periodStart || 'unknown'}~${row.periodEnd || 'unknown'}`,
    shadowOnly: true,
    summary: {
      totalTrades: row.input?.tradeSummary?.totalTrades ?? row.tradeSummary?.totalTrades ?? 0,
      avgScore: row.input?.tradeSummary?.avgScore ?? row.tradeSummary?.avgScore ?? 0,
      recommendationCount: recs.length,
      broadcastPlanned: row.broadcastPlanned === true,
      memoryWritePlanned: row.memoryWritePlanned !== false,
    },
    recommendations: recs.slice(0, 5),
  };
}

export default {
  expandMetaReflexionLayers,
  buildMetaNeuralReflexionInput,
  buildDeterministicMetaNeuralReflexion,
  buildMetaNeuralReflexionPrompt,
  normalizeMetaNeuralReflexionResult,
  buildMetaReflexionTelegramPayload,
  redactMetaReflexionValue,
};
