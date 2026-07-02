#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { C3_REGIME_STRATEGY_MAP_V2, LUNA_C3_REALIGN_RULE_VERSION } from '../shared/luna-c3-realign.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function flagValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonMaybe(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function fixtureRows() {
  return [
    { family: 'momentum_rotation', matched: true, regime: { regime: 'trending_bull' }, details: { c3Realign: { remapped: true, targetFamily: 'momentum_rotation' } } },
    { family: 'mean_reversion', matched: true, regime: { regime: 'trending_bear' }, details: { c3Realign: { remapped: true, targetFamily: 'mean_reversion' } } },
    { family: 'mean_reversion', matched: true, regime: { regime: 'ranging' }, details: { c3Realign: { remapped: false, targetFamily: 'mean_reversion' } } },
  ];
}

function rowRegime(row) {
  const regime = parseJsonMaybe(row.regime, row.regime || {});
  const details = parseJsonMaybe(row.details, row.details || {});
  return String(regime?.regime || details?.c3Realign?.regime || '').toLowerCase();
}

export function buildC3RealignReport(rows = [], options = {}) {
  const total = rows.length;
  const matched = rows.filter((row) => row.matched === true).length;
  const matchedRate = total > 0 ? matched / total : 0;
  const shadowRows = rows.filter((row) => parseJsonMaybe(row.details, row.details || {})?.c3Realign);
  const bearDefensiveRows = rows.filter((row) => rowRegime(row).includes('bear') && row.family === 'defensive_rotation');
  const c7Passed = options.c7Passed === true;
  const promotionReady = total > 0
    && matchedRate >= 0.60
    && bearDefensiveRows.length === 0
    && c7Passed;
  const blockers = [];
  if (total === 0) blockers.push('no_c3_shadow_samples');
  if (matchedRate < 0.60) blockers.push('matched_rate_below_60pct');
  if (bearDefensiveRows.length > 0) blockers.push('bear_defensive_rotation_present');
  if (!c7Passed) blockers.push('c7_evidence_missing');
  return {
    ok: blockers.length === 0,
    shadowOnly: true,
    liveMutation: false,
    promotionReady,
    manualPromotionReviewCandidate: promotionReady,
    ruleVersion: LUNA_C3_REALIGN_RULE_VERSION,
    map: C3_REGIME_STRATEGY_MAP_V2,
    metrics: {
      total,
      matched,
      matchedRate: Number(matchedRate.toFixed(4)),
      shadowRows: shadowRows.length,
      bearDefensiveRows: bearDefensiveRows.length,
      simulatedPnlPaceBaselineUsd2mo: 692,
      shadowBaselineOk: matchedRate >= 0.60 && bearDefensiveRows.length === 0,
    },
    blockers,
  };
}

export async function runLunaC3RealignReport(options = {}) {
  if (options.noDb) {
    return buildC3RealignReport(options.rows || fixtureRows(), options);
  }
  const hours = Math.max(1, Math.round(num(options.hours, 168)));
  const rows = await (options.queryFn || db.query)(
    `SELECT family, matched, regime, details, created_at
       FROM investment.luna_strategy_signals
      WHERE created_at >= NOW() - ($1::text || ' hours')::interval
        AND (
          rule_version = $2
          OR signal_type = 'c3_realign_shadow'
          OR details ? 'c3Realign'
        )
      ORDER BY created_at DESC
      LIMIT 5000`,
    [String(hours), LUNA_C3_REALIGN_RULE_VERSION],
  );
  return buildC3RealignReport(rows || [], { ...options, hours });
}

async function main() {
  const result = await runLunaC3RealignReport({
    noDb: hasFlag('no-db'),
    hours: flagValue('hours', 168),
    c7Passed: hasFlag('c7-passed'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`c3 realign report: samples=${result.metrics.total} promotionReady=${result.promotionReady}`);
  if (hasFlag('strict') && !result.promotionReady) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-c3-realign-report failed:' });
}
