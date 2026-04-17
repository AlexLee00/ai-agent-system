// @ts-nocheck
'use strict';

function _toTimestamp(value) {
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function _median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function evaluateDataset(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const requiredFields = Array.isArray(input.required_fields) ? input.required_fields : [];
  const freshnessField = input.freshness_field;
  const freshnessThresholdDays = Number(input.freshness_threshold_days || 7);
  const numericFields = Array.isArray(input.numeric_fields) ? input.numeric_fields : [];

  if (rows.length === 0) {
    return {
      passed: false,
      quality_score: 0,
      issues: [{ type: 'empty_dataset', count: 0 }],
      stats: {
        total_rows: 0,
        duplicate_rows: 0,
        missing_rows: 0,
        stale_rows: 0,
        outlier_rows: 0,
      },
    };
  }

  let duplicateRows = 0;
  let missingRows = 0;
  let staleRows = 0;
  let outlierRows = 0;
  const issues = [];

  const seen = new Set();
  for (const row of rows) {
    const fingerprint = JSON.stringify(row);
    if (seen.has(fingerprint)) duplicateRows += 1;
    seen.add(fingerprint);
  }
  if (duplicateRows > 0) issues.push({ type: 'duplicate', count: duplicateRows });

  const missingByField = {};
  for (const field of requiredFields) {
    const count = rows.filter((row) => row[field] == null || row[field] === '').length;
    if (count > 0) {
      missingByField[field] = count;
      missingRows += count;
      issues.push({ type: 'missing_required', field, count });
    }
  }

  if (freshnessField) {
    const now = Date.now();
    const maxAgeMs = freshnessThresholdDays * 24 * 60 * 60 * 1000;
    staleRows = rows.filter((row) => {
      const ts = _toTimestamp(row[freshnessField]);
      return ts == null || now - ts > maxAgeMs;
    }).length;
    if (staleRows > 0) issues.push({ type: 'stale', count: staleRows });
  }

  for (const field of numericFields) {
    const values = rows
      .map((row) => Number(row[field]))
      .filter((value) => Number.isFinite(value));
    const median = _median(values);
    if (median == null) continue;
    const threshold = Math.max(10, Math.abs(median) * 5);
    const count = rows.filter((row) => {
      const value = Number(row[field]);
      return Number.isFinite(value) && Math.abs(value - median) > threshold;
    }).length;
    if (count > 0) {
      outlierRows += count;
      issues.push({ type: 'outlier', field, count, baseline: Number(median.toFixed(2)) });
    }
  }

  let qualityScore = 10;
  qualityScore -= duplicateRows * 0.6;
  qualityScore -= missingRows * 0.8;
  qualityScore -= staleRows * 0.7;
  qualityScore -= outlierRows * 0.4;
  qualityScore = Math.max(0, Number(qualityScore.toFixed(1)));

  return {
    passed: issues.length === 0,
    quality_score: qualityScore,
    issues,
    stats: {
      total_rows: rows.length,
      duplicate_rows: duplicateRows,
      missing_rows: missingRows,
      stale_rows: staleRows,
      outlier_rows: outlierRows,
    },
  };
}

module.exports = {
  evaluateDataset,
};
