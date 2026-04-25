// @ts-nocheck

import { readPositionRuntimeAutopilotHistoryLines } from '../scripts/runtime-position-runtime-autopilot-history-store.ts';

export const LUNA_AUTONOMY_PHASES = {
  L4_PRE_AUTOTUNE: 'l4_pre_autotune',
  L4_POST_AUTOTUNE: 'l4_post_autotune',
  L5_AUTONOMOUS: 'l5_autonomous',
};

const L5_CUTOVER_AT = String(process.env.LUNA_L5_CUTOVER_AT || '').trim() || null;

let _cachedAutotuneCutoverAt = null;

function parseTs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function getLunaAutotuneCutoverAt() {
  if (_cachedAutotuneCutoverAt !== null) return _cachedAutotuneCutoverAt;
  const history = readPositionRuntimeAutopilotHistoryLines();
  const applied = history
    .filter((row) => row && row.executed === true && row.autotuneApplied === true)
    .map((row) => parseTs(row.recordedAt))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  _cachedAutotuneCutoverAt = applied[0] || null;
  return _cachedAutotuneCutoverAt;
}

export function getLunaL5CutoverAt() {
  return parseTs(L5_CUTOVER_AT);
}

export function resolveLunaAutonomyPhase(timestampMs = null) {
  const ts = parseTs(timestampMs);
  const l5CutoverAt = getLunaL5CutoverAt();
  if (ts != null && l5CutoverAt != null && ts >= l5CutoverAt) {
    return LUNA_AUTONOMY_PHASES.L5_AUTONOMOUS;
  }
  const autotuneCutoverAt = getLunaAutotuneCutoverAt();
  if (ts != null && autotuneCutoverAt != null && ts >= autotuneCutoverAt) {
    return LUNA_AUTONOMY_PHASES.L4_POST_AUTOTUNE;
  }
  return LUNA_AUTONOMY_PHASES.L4_PRE_AUTOTUNE;
}

export function buildLunaAutonomyPhaseContext(timestampMs = null) {
  return {
    phase: resolveLunaAutonomyPhase(timestampMs),
    autotuneCutoverAt: getLunaAutotuneCutoverAt(),
    l5CutoverAt: getLunaL5CutoverAt(),
  };
}
