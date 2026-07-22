const crypto = require('node:crypto');
const path = require('node:path');

function stableJsonValue(value, seen) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('write_plan_non_finite_number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') throw new TypeError('write_plan_unsupported_value');
  if (seen.has(value)) throw new TypeError('write_plan_circular_reference');
  seen.add(value);
  try {
    if (typeof value.toJSON === 'function') {
      const projected = value.toJSON();
      if (projected === value) throw new TypeError('write_plan_circular_reference');
      return stableJsonValue(projected, seen);
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError('write_plan_sparse_array');
      }
      return `[${value.map((item) => stableJsonValue(item, seen)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('write_plan_non_plain_object');
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError('write_plan_unsupported_value');
    if (Object.getOwnPropertyNames(value).some((key) => !Object.prototype.propertyIsEnumerable.call(value, key))) {
      throw new TypeError('write_plan_unsupported_value');
    }
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key], seen)}`);
    return `{${fields.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * New write runners should publish this stable plan hash in dry-run output, require
 * an exact confirm before opening a write transaction, snapshot locked rows before
 * mutation, and return explicit before/after counts.
 */
function stableWritePlanJson(plan) {
  const serialized = stableJsonValue(plan, new Set());
  if (serialized === undefined) throw new TypeError('write_plan_not_serializable');
  return serialized;
}

function writePlanSha256(plan, serialize = stableWritePlanJson) {
  const serialized = serialize(plan);
  if (typeof serialized !== 'string') throw new TypeError('write_plan_serializer_must_return_string');
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function matchesWriteActionConfirm(supplied, expected) {
  return typeof supplied === 'string'
    && typeof expected === 'string'
    && expected.length > 0
    && supplied === expected;
}

function buildLockedRollbackSnapshotPath({ artifactDir, actionPrefix, planSha256, runId }) {
  if (!/^[a-f0-9]{64}$/.test(planSha256)) throw new Error('snapshot_plan_sha256_required');
  if (!actionPrefix || path.basename(actionPrefix) !== actionPrefix) throw new Error('snapshot_action_prefix_invalid');
  if (!runId || path.basename(runId) !== runId) throw new Error('snapshot_run_id_invalid');
  return path.join(
    artifactDir,
    `${actionPrefix}-${planSha256.slice(0, 12)}-apply-${runId}.locked-rollback-snapshot.json`,
  );
}

function defineWriteCountEvidence(before, after) {
  return { before, after };
}

module.exports = {
  buildLockedRollbackSnapshotPath,
  defineWriteCountEvidence,
  matchesWriteActionConfirm,
  stableWritePlanJson,
  writePlanSha256,
};
