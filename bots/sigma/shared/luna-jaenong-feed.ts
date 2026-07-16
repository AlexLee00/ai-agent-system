// @ts-nocheck

import { normalizeLibraryCoords } from './library-coords.ts';

const SENSITIVE_TEXT = /\b(?:api[_ -]?key|secret|token|account(?:_id)?|authorization|bearer)\b|주문\s*번호|계좌\s*번호/i;

function text(value) {
  return String(value ?? '').trim();
}

function dateOrNull(value) {
  const date = value instanceof Date ? value : new Date(String(value || ''));
  return Number.isFinite(date.getTime()) ? date : null;
}

function hygiene(route, marketView) {
  if (route?.shadowOnly !== true || route?.executionConnected !== false || route?.orderPath != null) {
    return { ok: false, reason: 'jaenong_prediction_shadow_contract_invalid' };
  }
  if (route?.selectedTrack !== 'pullback' || !text(route.signalRef)) {
    return { ok: false, reason: 'jaenong_prediction_pullback_route_required' };
  }
  if (!dateOrNull(route.createdAt)) return { ok: false, reason: 'jaenong_prediction_created_at_invalid' };
  if (SENSITIVE_TEXT.test(text(marketView))) return { ok: false, reason: 'jaenong_prediction_hygiene_blocked' };
  return { ok: true, reason: null };
}

export function buildLunaJaenongPredictionFeedInput(route = {}, options = {}) {
  if (options.enabled !== true) {
    return { enabled: false, record: null, reason: 'jaenong_prediction_gate_off', mutationAllowed: false };
  }
  const marketView = text(options.marketView);
  const gate = hygiene(route, marketView);
  if (!gate.ok) return { enabled: false, record: null, reason: gate.reason, mutationAllowed: false };

  const createdAt = dateOrNull(route.createdAt);
  const horizon = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const symbols = (route.treatment?.candidates || [])
    .map((candidate) => text(candidate.symbol || candidate.ticker).toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  const coords = normalizeLibraryCoords({
    abstraction_level: 'L0',
    time_stage: 'raw',
    validation_state: 'unverified',
    prediction_state: 'forward',
    prediction_horizon: horizon,
  });
  const entryPlan = {
    ...(route.treatment?.tranchePlan || {}),
    candidates: symbols,
    shadowOnly: true,
    executionConnected: false,
  };
  const exitPlan = {
    trackMddCircuitPct: route.risk?.trackMddCircuitPct ?? null,
    zoneStopLossAlpha: route.risk?.zoneStopLossAlpha ?? null,
    status: 'planned_shadow',
    shadowOnly: true,
    executionConnected: false,
  };
  return {
    enabled: true,
    reason: 'jaenong_prediction_forward_ready',
    mutationAllowed: false,
    record: {
      team: 'luna',
      agent: 'jaenong-priority-router',
      sourceKind: 'luna_jaenong_shadow',
      sourceId: route.signalRef,
      createdAt: createdAt.toISOString(),
      text: [
        'JAENONG shadow prediction',
        `track=pullback`,
        `symbols=${symbols.join(',') || 'none'}`,
        `expected_horizon=${horizon}`,
        marketView ? `market_view=${marketView}` : '',
      ].filter(Boolean).join(' '),
      payload: {
        signalRef: route.signalRef,
        briefRef: route.briefRef || null,
        referenceSnapshotHash: route.referenceSnapshotHash || null,
        marketView: marketView || null,
        entryPlan,
        exitPlan,
        treatmentScore: route.treatment?.score ?? null,
        controlScore: route.control?.score ?? null,
        libraryCoords: coords,
      },
      constitutionAllowed: true,
    },
  };
}

export default { buildLunaJaenongPredictionFeedInput };
