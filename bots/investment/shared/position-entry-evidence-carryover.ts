// @ts-nocheck

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function parseJsonMaybe(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function parseAnalystSignals(raw = '') {
  const result = {};
  for (const part of String(raw || '').split('|')) {
    const [name, signal] = part.split(':');
    if (!name || !signal) continue;
    result[String(name).trim()] = String(signal).trim().toUpperCase();
  }
  return result;
}

function evidenceItem(source, weight = 1, meta = {}) {
  return {
    source,
    weight: clamp(weight, 0.05, 2),
    meta,
  };
}

export function buildEntryEvidenceContext({
  decision = null,
  seedSignal = null,
  strategy = null,
  strategyRoute = null,
} = {}) {
  const blockMeta = {
    ...parseJsonMaybe(seedSignal?.block_meta, {}),
    ...parseJsonMaybe(decision?.block_meta, {}),
  };
  const confidence = clamp(
    decision?.confidence ?? seedSignal?.confidence ?? blockMeta?.decisionTrace?.sourceConfidence ?? 0.5,
    0,
    1,
  );
  const predictiveScore = safeNumber(
    blockMeta?.predictiveValidation?.score
      ?? blockMeta?.entryTrigger?.predictiveScore
      ?? blockMeta?.decisionTrace?.predictiveScore,
    null,
  );
  const analystSignals = parseAnalystSignals(seedSignal?.analyst_signals || blockMeta?.analystSignals || '');
  const analystVotes = Object.values(analystSignals).filter(Boolean);
  const bullishVotes = analystVotes.filter((item) => item === 'B' || item === 'BUY').length;
  const bearishVotes = analystVotes.filter((item) => item === 'S' || item === 'SELL').length;
  const items = [];

  if (confidence > 0) {
    items.push(evidenceItem('entry_decision_confidence', Math.max(0.25, confidence), { confidence }));
  }
  if (analystVotes.length > 0) {
    const consensus = analystVotes.length > 0 ? (bullishVotes - bearishVotes) / analystVotes.length : 0;
    items.push(evidenceItem('entry_analyst_consensus', Math.abs(consensus) || 0.25, {
      votes: analystVotes.length,
      bullishVotes,
      bearishVotes,
      consensus,
    }));
  }
  if (blockMeta?.entryTrigger) {
    items.push(evidenceItem('entry_trigger', 0.8, {
      triggerType: blockMeta.entryTrigger.triggerType || null,
      state: blockMeta.entryTrigger.state || null,
    }));
  }
  if (blockMeta?.predictiveValidation || predictiveScore != null) {
    items.push(evidenceItem('predictive_validation', predictiveScore != null ? predictiveScore : 0.55, {
      score: predictiveScore,
      mode: blockMeta?.predictiveValidation?.mode || null,
    }));
  }
  if (strategyRoute || blockMeta?.scoreFusion || blockMeta?.technicalPresignal || strategy?.entry_condition) {
    items.push(evidenceItem('technical_strategy_route', 0.65, {
      setupType: strategyRoute?.setupType || strategy?.setup_type || null,
      hasScoreFusion: Boolean(blockMeta?.scoreFusion),
      hasTechnicalPresignal: Boolean(blockMeta?.technicalPresignal),
    }));
  }

  if (items.length === 0 && (decision?.reasoning || seedSignal?.reasoning || strategy?.summary)) {
    items.push(evidenceItem('entry_thesis_text', Math.max(0.35, confidence), {}));
  }

  const weighted = items.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const baseQuality = 0.5 + (confidence * 0.22) + (Math.min(1, Math.max(0, predictiveScore ?? confidence)) * 0.12);
  const consensusBoost = analystVotes.length > 0 ? Math.max(0, bullishVotes - bearishVotes) * 0.03 : 0;
  const qualityScore = clamp(baseQuality + consensusBoost + Math.min(0.1, items.length * 0.015), 0.45, 0.82);
  const sentimentScore = analystVotes.length > 0
    ? clamp((bullishVotes - bearishVotes) / Math.max(1, analystVotes.length), -1, 1)
    : clamp((confidence - 0.5) * 1.2, -0.35, 0.35);

  const summary = {
    source: 'entry_signal_snapshot',
    evidenceCount: items.length,
    sourceCount: items.length > 0 ? Math.min(items.length, 4) : 0,
    sources: items.map((item) => ({
      source: item.source,
      count: 1,
      avgScore: sentimentScore,
      avgQuality: qualityScore,
      weight: item.weight,
    })),
    sentimentScore,
    qualityScore,
    avgQuality: qualityScore,
    avgFreshness: 1,
    warning: items.length > 0 ? null : 'entry_evidence_unavailable',
    entryEvidence: true,
    carryoverMaxHours: 24,
    items,
  };

  const thesis = [
    decision?.reasoning ? `decision=${String(decision.reasoning).slice(0, 240)}` : null,
    strategy?.summary ? `strategy=${String(strategy.summary).slice(0, 240)}` : null,
    strategy?.entry_condition ? `entry=${String(strategy.entry_condition).slice(0, 240)}` : null,
    seedSignal?.id ? `seedSignal=${seedSignal.id}` : null,
  ].filter(Boolean);

  return {
    entryEvidenceSummary: summary,
    entryThesisSnapshot: {
      createdAt: new Date().toISOString(),
      signalId: seedSignal?.id || decision?.signalId || null,
      confidence,
      predictiveScore,
      analystVotes: analystVotes.length,
      bullishVotes,
      bearishVotes,
      strategyRoute: strategyRoute || null,
      thesis,
    },
  };
}

export function resolveEntryEvidenceCarryover({
  externalEvidenceSummary = null,
  strategyProfile = null,
  seedSignal = null,
  heldHours = 0,
  maxHours = null,
} = {}) {
  if (Number(externalEvidenceSummary?.evidenceCount || 0) > 0) {
    return {
      summary: externalEvidenceSummary,
      usedCarryover: false,
      reason: 'external_evidence_available',
    };
  }

  const strategyContext = strategyProfile?.strategy_context || strategyProfile?.strategyContext || {};
  let entrySummary = strategyContext?.entryEvidenceSummary || null;
  let entryThesis = strategyContext?.entryThesisSnapshot || null;
  if (!entrySummary && seedSignal) {
    const built = buildEntryEvidenceContext({ seedSignal });
    entrySummary = built.entryEvidenceSummary;
    entryThesis = built.entryThesisSnapshot;
  }
  const evidenceCount = Number(entrySummary?.evidenceCount || 0);
  if (evidenceCount <= 0) {
    return {
      summary: externalEvidenceSummary,
      usedCarryover: false,
      reason: 'entry_evidence_unavailable',
    };
  }

  const carryoverMaxHours = Number(maxHours ?? entrySummary?.carryoverMaxHours ?? 24);
  const ageHours = safeNumber(heldHours, 0);
  if (ageHours > carryoverMaxHours) {
    return {
      summary: externalEvidenceSummary,
      usedCarryover: false,
      reason: 'entry_evidence_expired',
      carryoverMaxHours,
      heldHours: ageHours,
    };
  }

  return {
    summary: {
      ...entrySummary,
      warning: null,
      carriedFromEntry: true,
      carryoverReason: 'external_evidence_empty_entry_snapshot_carryover',
      heldHours: ageHours,
      entryThesisSnapshot: entryThesis || null,
    },
    usedCarryover: true,
    reason: 'external_evidence_empty_entry_snapshot_carryover',
    carryoverMaxHours,
    heldHours: ageHours,
  };
}

export default {
  buildEntryEvidenceContext,
  resolveEntryEvidenceCarryover,
};
