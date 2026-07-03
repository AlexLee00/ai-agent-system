// @ts-nocheck
'use strict';

const fs = require('fs');
const kst = require('../../../packages/core/lib/kst');
const {
  ensureDir,
  getReservationRuntimeDir,
  getReservationRuntimeFile,
} = require('./runtime-paths');

const HISTORY_FILE = 'cancel-shadow-diff-history.jsonl';
const LATEST_FILE = 'cancel-shadow-diff-latest.json';

function historyPath() {
  return getReservationRuntimeFile(HISTORY_FILE);
}

function latestPath() {
  return getReservationRuntimeFile(LATEST_FILE);
}

function countsFromResult(result = {}) {
  const diff = result.diff || {};
  const counts = diff.counts || {};
  return {
    unified: Number(counts.unified ?? diff.unified ?? 0),
    legacy: Number(counts.legacy ?? diff.legacy ?? 0),
    todayMissingInLegacy: Number(counts.todayMissingInLegacy ?? diff.todayMissingInLegacy?.length ?? 0),
    todayMissingInUnified: Number(counts.todayMissingInUnified ?? diff.todayMissingInUnified?.length ?? 0),
    futureUnifiedOnly: Number(counts.futureUnifiedOnly ?? diff.futureUnifiedOnly?.length ?? 0),
  };
}

function buildCancelShadowSummary(result = {}) {
  const scannerSkipped = Boolean(result.skipped || result.unified?.skipped);
  const reason = result.reason || result.unified?.reason || null;
  return {
    recordedAt: kst.datetimeStr(),
    today: result.today || kst.today(),
    ok: result.ok === true,
    skipped: scannerSkipped,
    reason,
    scannerOk: result.unified?.ok !== false && !scannerSkipped,
    rawCount: Number(result.unified?.rawCount || 0),
    counts: countsFromResult(result),
    workspace: result.workspace || getReservationRuntimeDir(),
  };
}

function appendCancelShadowSummary(result) {
  const summary = buildCancelShadowSummary(result);
  ensureDir(getReservationRuntimeDir());
  fs.appendFileSync(historyPath(), `${JSON.stringify(summary)}\n`, 'utf8');
  fs.writeFileSync(latestPath(), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

function readCancelShadowHistory({ limit = 30, filePath = historyPath() } = {}) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-Math.max(1, Number(limit) || 30)).map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return { ok: false, skipped: true, reason: `invalid_history_line:${String(error?.message || error).slice(0, 120)}` };
    }
  });
}

function readLatestCancelShadowSummary({ filePath = latestPath() } = {}) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: `invalid_latest_shadow:${String(error?.message || error).slice(0, 120)}`,
    };
  }
}

function mergeDaySummary(existing, entry) {
  if (!existing) return entry;
  const existingCounts = existing.counts || {};
  const entryCounts = entry.counts || {};
  return {
    ...existing,
    ...entry,
    ok: Boolean(existing.ok && entry.ok),
    skipped: Boolean(existing.skipped || entry.skipped),
    scannerOk: existing.scannerOk !== false && entry.scannerOk !== false,
    reason: existing.skipped || existing.scannerOk === false
      ? (existing.reason || entry.reason || null)
      : (entry.reason || existing.reason || null),
    counts: {
      unified: Math.max(Number(existingCounts.unified || 0), Number(entryCounts.unified || 0)),
      legacy: Math.max(Number(existingCounts.legacy || 0), Number(entryCounts.legacy || 0)),
      todayMissingInLegacy: Math.max(Number(existingCounts.todayMissingInLegacy || 0), Number(entryCounts.todayMissingInLegacy || 0)),
      todayMissingInUnified: Math.max(Number(existingCounts.todayMissingInUnified || 0), Number(entryCounts.todayMissingInUnified || 0)),
      futureUnifiedOnly: Math.max(Number(existingCounts.futureUnifiedOnly || 0), Number(entryCounts.futureUnifiedOnly || 0)),
    },
  };
}

function evaluateCancelLegacyCleanupGate({
  history = readCancelShadowHistory({ limit: 100 }),
  days = 3,
} = {}) {
  const requiredDays = Math.max(1, Number(days) || 3);
  const byDay = new Map();
  for (const entry of history) {
    if (!entry?.today) continue;
    byDay.set(entry.today, mergeDaySummary(byDay.get(entry.today), entry));
  }
  const recent = Array.from(byDay.values())
    .sort((a, b) => String(b.today).localeCompare(String(a.today)))
    .slice(0, requiredDays);
  const blockers = [];
  if (recent.length < requiredDays) {
    blockers.push(`insufficient_shadow_days:${recent.length}/${requiredDays}`);
  }
  const mismatch = recent.find((entry) =>
    Number(entry.counts?.todayMissingInLegacy || 0) > 0
    || Number(entry.counts?.todayMissingInUnified || 0) > 0);
  if (mismatch) blockers.push(`today_mismatch:${mismatch.today}`);
  const skipped = recent.find((entry) => entry.skipped || entry.scannerOk === false);
  if (skipped) blockers.push(`scanner_skipped:${skipped.today}:${skipped.reason || 'unknown'}`);
  const noFutureEvidence = recent.length > 0 && !recent.some((entry) => Number(entry.counts?.futureUnifiedOnly || 0) > 0);
  if (noFutureEvidence) blockers.push('future_unified_only_not_observed');

  return {
    ok: blockers.length === 0,
    ready: blockers.length === 0,
    requiredDays,
    observedDays: recent.length,
    blockers,
    recent,
  };
}

module.exports = {
  HISTORY_FILE,
  LATEST_FILE,
  historyPath,
  latestPath,
  buildCancelShadowSummary,
  appendCancelShadowSummary,
  readCancelShadowHistory,
  readLatestCancelShadowSummary,
  mergeDaySummary,
  evaluateCancelLegacyCleanupGate,
};
