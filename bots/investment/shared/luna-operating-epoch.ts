// @ts-nocheck
/**
 * Luna operating epoch boundary.
 *
 * Historical trades/signals before the epoch are treated as development-stage
 * evidence. They remain auditable, but should not drive live policy learning or
 * data-derived hard gates unless explicitly allowed.
 */

const DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled']);
const ENABLE_VALUES = new Set(['1', 'true', 'on', 'enabled']);

export const DEFAULT_LUNA_OPERATING_EPOCH_STARTED_AT = '2026-05-08T00:00:00.000Z';

function parseDateMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function isLunaOperatingEpochEnabled(env = process.env) {
  const raw = String(env.LUNA_OPERATING_EPOCH_ENABLED ?? 'true').trim().toLowerCase();
  return !DISABLE_VALUES.has(raw);
}

export function isDevDataDerivedPolicyAllowed(env = process.env) {
  const raw = String(
    env.LUNA_ALLOW_DEV_DATA_DERIVED_GUARDS
      ?? env.LUNA_TRADE_DATA_DERIVED_GUARDS_ALLOW_DEV
      ?? '',
  ).trim().toLowerCase();
  return ENABLE_VALUES.has(raw);
}

export function getLunaOperatingEpoch(env = process.env) {
  const enabled = isLunaOperatingEpochEnabled(env);
  const startedAt = String(env.LUNA_OPERATING_EPOCH_STARTED_AT || DEFAULT_LUNA_OPERATING_EPOCH_STARTED_AT);
  const startedAtMs = parseDateMs(startedAt);
  return {
    enabled,
    startedAt,
    startedAtMs,
    valid: !enabled || startedAtMs != null,
    developmentDataPolicy: enabled ? 'exclude_from_policy_learning' : 'include_all_history',
    devDataDerivedPolicyAllowed: isDevDataDerivedPolicyAllowed(env),
  };
}

export function classifyLunaOperatingTimestamp(value, env = process.env) {
  const epoch = getLunaOperatingEpoch(env);
  const tsMs = parseDateMs(value);
  if (!epoch.enabled) return { stage: 'operating', reason: 'epoch_disabled', epoch, tsMs };
  if (!epoch.valid) return { stage: 'unknown', reason: 'invalid_epoch_started_at', epoch, tsMs };
  if (tsMs == null) return { stage: 'unknown', reason: 'missing_timestamp', epoch, tsMs };
  if (tsMs < epoch.startedAtMs) return { stage: 'development', reason: 'before_operating_epoch', epoch, tsMs };
  return { stage: 'operating', reason: 'at_or_after_operating_epoch', epoch, tsMs };
}

export function isDevelopmentStageTimestamp(value, env = process.env) {
  return classifyLunaOperatingTimestamp(value, env).stage === 'development';
}

export function shouldUseRowForPolicyLearning(row = {}, timestampFields = ['created_at', 'executed_at', 'entry_time', 'exit_time'], env = process.env) {
  if (isExplicitlyExcludedFromPolicyLearning(row)) return false;
  const epoch = getLunaOperatingEpoch(env);
  if (!epoch.enabled) return true;
  for (const field of timestampFields) {
    const value = row?.[field];
    if (value == null || value === '') continue;
    return classifyLunaOperatingTimestamp(value, env).stage === 'operating';
  }
  return false;
}

export function filterRowsForPolicyLearning(rows = [], timestampFields, env = process.env) {
  return (rows || []).filter((row) => shouldUseRowForPolicyLearning(row, timestampFields, env));
}

export function isExplicitlyExcludedFromPolicyLearning(row = {}) {
  const excluded = row?.exclude_from_learning ?? row?.excludeFromLearning;
  const qualityFlag = String(row?.quality_flag ?? row?.qualityFlag ?? '').trim().toLowerCase();
  return excluded === true
    || String(excluded || '').trim().toLowerCase() === 'true'
    || qualityFlag === 'exclude_from_learning';
}

export function summarizeRowsByOperatingEpoch(rows = [], timestampFields = ['created_at', 'executed_at', 'entry_time', 'exit_time'], env = process.env) {
  const summary = {
    total: 0,
    operating: 0,
    development: 0,
    unknown: 0,
    epoch: getLunaOperatingEpoch(env),
  };
  for (const row of rows || []) {
    summary.total += 1;
    let classification = null;
    for (const field of timestampFields) {
      const value = row?.[field];
      if (value == null || value === '') continue;
      classification = classifyLunaOperatingTimestamp(value, env);
      break;
    }
    const stage = classification?.stage || 'unknown';
    summary[stage] = Number(summary[stage] || 0) + 1;
  }
  return summary;
}

export function buildOperatingEpochLowerBoundSql(existingSql = null, env = process.env) {
  const epoch = getLunaOperatingEpoch(env);
  const bounds = [];
  if (existingSql) bounds.push(existingSql);
  if (epoch.enabled && epoch.valid) bounds.push(`TIMESTAMP '${epoch.startedAt}'`);
  if (bounds.length === 0) return null;
  if (bounds.length === 1) return bounds[0];
  return `GREATEST(${bounds.join(', ')})`;
}

export function shouldUseDevelopmentDerivedHardGates(env = process.env) {
  const epoch = getLunaOperatingEpoch(env);
  return !epoch.enabled || epoch.devDataDerivedPolicyAllowed;
}

export default {
  DEFAULT_LUNA_OPERATING_EPOCH_STARTED_AT,
  getLunaOperatingEpoch,
  isLunaOperatingEpochEnabled,
  isDevDataDerivedPolicyAllowed,
  classifyLunaOperatingTimestamp,
  isDevelopmentStageTimestamp,
  shouldUseRowForPolicyLearning,
  filterRowsForPolicyLearning,
  isExplicitlyExcludedFromPolicyLearning,
  summarizeRowsByOperatingEpoch,
  buildOperatingEpochLowerBoundSql,
  shouldUseDevelopmentDerivedHardGates,
};
