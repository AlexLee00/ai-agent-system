#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getEntryTriggerOperationalStats, listActiveEntryTriggers } from '../shared/luna-discovery-entry-store.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import {
  evaluateActiveEntryTriggerQualityGate,
  loadActiveEntryTriggerQuality,
} from '../shared/entry-trigger-engine.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-entry-trigger-operating-report.json');

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addCount(map, key) {
  if (!key) return;
  map[key] = Number(map[key] || 0) + 1;
}

function marketForExchange(exchange = 'binance') {
  const normalized = String(exchange || 'binance').trim().toLowerCase();
  if (normalized === 'kis') return 'domestic';
  if (normalized === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function buildBacktestRefreshCommand({ exchange = 'binance', symbol = '' } = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return null;
  return `npm --prefix bots/investment run -s runtime:luna-candidate-backtest-refresh -- --json --force --market=${marketForExchange(exchange)} --symbols=${normalizedSymbol}`;
}

function buildPredictiveRefreshCommand({ exchange = 'binance', symbol = '' } = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return null;
  return `npm --prefix bots/investment run -s runtime:luna-predictive-evidence-refresh -- --json --dry-run --market=${marketForExchange(exchange)} --symbols=${normalizedSymbol}`;
}

function buildPaperPromotionGateCommand({ exchange = 'binance', symbol = '' } = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return null;
  return `npm --prefix bots/investment run -s runtime:luna-paper-promotion-gate -- --json --dry-run --market=${marketForExchange(exchange)} --limit=1000 --symbols=${normalizedSymbol}`;
}

function buildEntryTriggerDiagnoseCommand({ exchange = 'binance', hours = 24 } = {}) {
  return `npm --prefix bots/investment run -s runtime:luna-entry-trigger-diagnose -- --json --exchange=${normalizeExchange(exchange || 'binance')} --hours=${Number(hours || 24)}`;
}

function normalizeExchange(value = '') {
  return String(value || '').trim().toLowerCase();
}

function selectExchangeScopedHeartbeat(readiness = {}, exchange = 'binance') {
  const requestedExchange = normalizeExchange(exchange || 'binance');
  const payload = readiness?.heartbeat?.payload || {};
  const heartbeatExchange = normalizeExchange(payload.exchange || '');
  const heartbeatResult = payload.result || {};
  const matchesExchange = requestedExchange === 'all'
    || (heartbeatExchange && heartbeatExchange === requestedExchange);
  const ignoredReason = matchesExchange
    ? null
    : heartbeatExchange
      ? `heartbeat_exchange_mismatch:${heartbeatExchange}`
      : 'heartbeat_exchange_missing';
  return {
    payload,
    result: matchesExchange ? heartbeatResult : {},
    results: matchesExchange ? (heartbeatResult.results || []) : [],
    heartbeatExchange: heartbeatExchange || null,
    matchesExchange,
    ignoredReason,
  };
}

function readinessBlockers(item = {}) {
  const details = item.fireReadiness || {};
  const blockers = [];
  if (item.fired === true) return blockers;
  const promotionPassCount = finiteNumber(details.promotionPassCount);
  const minPassCount = finiteNumber(details.minPassCount);
  const promotionConsecutivePasses = finiteNumber(details.promotionConsecutivePasses);
  const minConsecutivePasses = finiteNumber(details.minConsecutivePasses);
  const confidence = finiteNumber(details.confidence);
  const minConfidence = finiteNumber(details.minConfidence);
  const promotionEvidenceReady = (
    promotionPassCount != null
    && minPassCount != null
    && promotionPassCount >= minPassCount
    && promotionConsecutivePasses != null
    && minConsecutivePasses != null
    && promotionConsecutivePasses >= minConsecutivePasses
  );
  const promotionConfidenceReady = minConfidence == null || (confidence != null && confidence >= minConfidence);
  if (item.fireReason) {
    const fireReason = String(item.fireReason);
    if (fireReason === 'promotion_shadow_readiness_incomplete' && promotionEvidenceReady) {
      blockers.push(promotionConfidenceReady
        ? 'promotion_ready_entry_confirmation_pending'
        : 'promotion_ready_confidence_below_min');
    } else {
      blockers.push(fireReason);
    }
  }
  const telemetry = details.technicalTelemetry || {};
  const mtfTelemetryMissing = telemetry.mtfAvailable === false || telemetry.missing === true;
  const volumeTelemetryMissing = telemetry.volumeAvailable === false || telemetry.missing === true;
  if (mtfTelemetryMissing) blockers.push('mtf_telemetry_missing');
  else {
    if (details.mtfBullish === false) blockers.push('mtf_not_bullish');
    if (details.mtfDominantSignal && String(details.mtfDominantSignal).toUpperCase() !== 'BUY') {
      blockers.push('mtf_dominant_not_buy');
    }
  }
  const predictiveScore = finiteNumber(details.predictiveScore);
  if (predictiveScore != null && predictiveScore < 0.55) blockers.push('predictive_score_below_0_55');
  const mtfAgreement = finiteNumber(details.mtfAgreement);
  if (!mtfTelemetryMissing && mtfAgreement != null && mtfAgreement < 0.72) blockers.push('mtf_agreement_below_0_72');
  const volumeBurst = finiteNumber(details.volumeBurst);
  if (volumeTelemetryMissing) blockers.push('volume_telemetry_missing');
  else if (volumeBurst != null && volumeBurst < 1.1) blockers.push('volume_burst_below_1_1');
  const technical = details.technicalConfirmation || {};
  if (technical.ok === false) {
    blockers.push('technical_confirmation_incomplete');
    const gaps = technical.gaps || {};
    for (const [key, value] of Object.entries(gaps)) {
      if (finiteNumber(value) != null && Number(value) > 0) blockers.push(`${key}_gap`);
    }
  }
  return [...new Set(blockers)];
}

function summarizeReadinessResults(results = []) {
  const waitReasonCounts = {};
  const readiness = (results || []).map((item) => {
    const details = item.fireReadiness || {};
    const blockers = readinessBlockers(item);
    for (const blocker of blockers) addCount(waitReasonCounts, blocker);
    return {
      triggerId: item.triggerId || null,
      symbol: item.symbol || null,
      state: item.state || null,
      fired: item.fired === true,
      reason: item.reason || null,
      fireReason: item.fireReason || null,
      blockers,
      triggerType: details.triggerType || null,
      confidence: finiteNumber(details.confidence),
      predictiveScore: finiteNumber(details.predictiveScore),
      discoveryScore: finiteNumber(details.discoveryScore),
      mtfAgreement: finiteNumber(details.mtfAgreement),
      mtfAlignmentScore: finiteNumber(details.mtfAlignmentScore),
      mtfDominantSignal: details.mtfDominantSignal || null,
      mtfBullish: details.mtfBullish === true,
      volumeBurst: finiteNumber(details.volumeBurst),
      technicalTelemetry: details.technicalTelemetry || null,
      breakoutRetest: details.breakoutRetest === true,
      newsMomentum: finiteNumber(details.newsMomentum),
      technicalConfirmation: details.technicalConfirmation || null,
      minConfidence: finiteNumber(details.minConfidence),
      confidenceGap: finiteNumber(details.minConfidence) == null || finiteNumber(details.confidence) == null
        ? null
        : Number(Math.max(0, finiteNumber(details.minConfidence) - finiteNumber(details.confidence)).toFixed(4)),
      minPassCount: finiteNumber(details.minPassCount),
      minConsecutivePasses: finiteNumber(details.minConsecutivePasses),
      promotionPassCount: finiteNumber(details.promotionPassCount),
      promotionConsecutivePasses: finiteNumber(details.promotionConsecutivePasses),
    };
  });
  return {
    checked: readiness.length,
    fired: readiness.filter((row) => row.fired).length,
    waiting: readiness.filter((row) => !row.fired).length,
    waitReasonCounts,
    readiness,
  };
}

function commandsForReadinessBlockers(row = {}, { exchange = 'binance', hours = 24 } = {}) {
  const symbol = String(row.symbol || '').trim().toUpperCase();
  const commands = [];
  const add = (command) => {
    if (command && !commands.includes(command)) commands.push(command);
  };
  for (const blocker of row.blockers || []) {
    if (blocker === 'promotion_shadow_readiness_incomplete') {
      add(buildPaperPromotionGateCommand({ exchange, symbol }));
    }
    if (blocker === 'promotion_ready_confidence_below_min') {
      add(buildPaperPromotionGateCommand({ exchange, symbol }));
      add(buildEntryTriggerDiagnoseCommand({ exchange, hours }));
    }
    if (blocker === 'promotion_ready_entry_confirmation_pending') {
      add(buildEntryTriggerDiagnoseCommand({ exchange, hours }));
    }
    if (blocker === 'predictive_score_below_0_55') {
      add(buildPredictiveRefreshCommand({ exchange, symbol }));
    }
    if (
      blocker.startsWith('mtf_')
      || blocker.startsWith('volume_')
      || blocker === 'technical_confirmation_incomplete'
      || blocker.endsWith('_gap')
    ) {
      add(buildEntryTriggerDiagnoseCommand({ exchange, hours }));
    }
  }
  return commands;
}

function buildReadinessRemediationPlan(readinessSummary = {}, { exchange = 'binance', hours = 24 } = {}) {
  const waitingRows = (readinessSummary.readiness || []).filter((row) => row.fired !== true);
  const byBlocker = {};
  const items = waitingRows.map((row) => {
    for (const blocker of row.blockers || []) addCount(byBlocker, blocker);
    return {
      triggerId: row.triggerId || null,
      symbol: row.symbol || null,
      blockers: row.blockers || [],
      nextShadowCommands: commandsForReadinessBlockers(row, { exchange, hours }),
      liveMutation: false,
    };
  });
  return {
    status: items.length === 0 ? 'no_waiting_entry_triggers' : 'entry_trigger_waiting_remediation_ready',
    waitingSymbols: [...new Set(items.map((item) => item.symbol).filter(Boolean))],
    byBlocker,
    nextShadowCommands: [...new Set(items.flatMap((item) => item.nextShadowCommands || []))],
    items,
    liveMutation: false,
  };
}

async function buildActiveQualityGateSummary({ exchange = 'binance' } = {}) {
  const active = await listActiveEntryTriggers({ exchange, limit: 1000 }).catch(() => []);
  const symbols = [...new Set((active || []).map((row) => String(row.symbol || '').trim().toUpperCase()).filter(Boolean))];
  const qualityBySymbol = await loadActiveEntryTriggerQuality(symbols, { exchange }).catch(() => new Map());
  const byReason = {};
  const items = (active || []).map((trigger) => {
    const symbol = String(trigger.symbol || '').trim().toUpperCase();
    const gate = evaluateActiveEntryTriggerQualityGate(trigger, qualityBySymbol.get(symbol), {});
    if (!gate.ok) addCount(byReason, gate.reason);
    const needsBacktestRefresh = (gate.reasons || []).includes('backtest_missing_or_stale');
    const backtestAgeHours = finiteNumber(gate.backtest?.ageHours);
    const maxBacktestAgeHours = finiteNumber(gate.maxBacktestAgeHours);
    return {
      triggerId: trigger.id || null,
      symbol,
      state: trigger.trigger_state || null,
      ok: gate.ok === true,
      reason: gate.reason || null,
      reasons: gate.reasons || [],
      backtestGateStatus: gate.backtest?.gateStatus || null,
      backtestFresh: gate.backtest?.fresh ?? null,
      backtestAgeHours,
      maxBacktestAgeHours,
      backtestStaleByHours: backtestAgeHours == null || maxBacktestAgeHours == null
        ? null
        : Number(Math.max(0, backtestAgeHours - maxBacktestAgeHours).toFixed(2)),
      backtestHealthy: gate.backtest?.healthy ?? null,
      predictiveDecision: gate.predictive?.decision || null,
      predictiveScore: finiteNumber(gate.predictive?.score),
      recommendedRefreshCommand: needsBacktestRefresh ? buildBacktestRefreshCommand({ exchange, symbol }) : null,
    };
  });
  return {
    checked: items.length,
    pass: items.filter((item) => item.ok).length,
    blocked: items.filter((item) => !item.ok).length,
    byReason,
    items,
  };
}

export async function buildLunaEntryTriggerOperatingReport({ exchange = 'binance', hours = 24 } = {}) {
  const [stats, readiness, activeQualityGate] = await Promise.all([
    getEntryTriggerOperationalStats({ exchange, hours }),
    buildLunaEntryTriggerWorkerReadiness({ exchange, hours }),
    buildActiveQualityGateSummary({ exchange }),
  ]);
  const heartbeatScope = selectExchangeScopedHeartbeat(readiness, exchange);
  const heartbeatResult = heartbeatScope.result || {};
  const readinessSummary = summarizeReadinessResults(heartbeatScope.results || []);
  const readinessRemediationPlan = buildReadinessRemediationPlan(readinessSummary, { exchange, hours });
  const workerMigrated = readiness?.status === 'entry_trigger_worker_migrated_to_luna_skill';
  const fired = Number(stats?.recentByState?.fired || 0);
  const waiting = Number(stats?.recentByState?.waiting || 0);
  const armed = Number(stats?.recentByState?.armed || 0);
  const duplicateFiredScopeCount = Number(stats?.duplicateFiredScopeCount || 0);
  const warnings = [
    ...(readiness?.warnings || []),
    ...(duplicateFiredScopeCount > 0 ? [`duplicate fired scopes: ${duplicateFiredScopeCount}`] : []),
  ];
  return {
    ok: warnings.length === 0,
    checkedAt: new Date().toISOString(),
    status: warnings.length === 0 ? 'entry_trigger_operating' : 'entry_trigger_attention',
    exchange,
    hours,
    summary: {
      activeCount: Number(stats?.activeCount || 0),
      fired,
      waiting,
      armed,
      duplicateFiredScopeCount,
      heartbeatSource: workerMigrated ? 'retired_legacy_ignored' : 'worker_heartbeat',
      heartbeatExchange: heartbeatScope.heartbeatExchange,
      heartbeatMatchesExchange: heartbeatScope.matchesExchange,
      heartbeatIgnoredReason: heartbeatScope.ignoredReason,
      heartbeatAgeMinutes: workerMigrated ? null : (readiness?.heartbeat?.ageMinutes ?? null),
      legacyHeartbeatAgeMinutes: workerMigrated ? (readiness?.heartbeat?.ageMinutes ?? null) : null,
      heartbeatMode: workerMigrated ? null : (heartbeatResult?.mode || null),
      heartbeatAllowLiveFire: workerMigrated ? null : heartbeatResult?.allowLiveFire === true,
      heartbeatChecked: workerMigrated ? 0 : Number(heartbeatResult?.checked || 0),
      heartbeatFired: workerMigrated ? 0 : Number(heartbeatResult?.fired || 0),
      heartbeatReadyBlocked: workerMigrated ? 0 : Number(heartbeatResult?.readyBlocked || 0),
      readinessChecked: readinessSummary.checked,
      readinessFired: readinessSummary.fired,
      readinessWaiting: readinessSummary.waiting,
      waitReasonCounts: readinessSummary.waitReasonCounts,
      activeQualityChecked: activeQualityGate.checked,
      activeQualityBlocked: activeQualityGate.blocked,
      activeQualityPass: activeQualityGate.pass,
      activeQualityBlockReasons: activeQualityGate.byReason,
      readinessRemediationCommands: readinessRemediationPlan.nextShadowCommands.length,
    },
    tradeCompletionReadiness: readinessSummary,
    readinessRemediationPlan,
    activeQualityGate,
    stats,
    readiness: {
      status: readiness?.status || null,
      warnings: readiness?.warnings || [],
      launchctl: readiness?.launchctl || null,
      installedPlist: readiness?.installedPlist || null,
    },
    warnings,
  };
}

export function saveLunaEntryTriggerOperatingReport(report = {}, file = DEFAULT_OUTPUT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

export function renderLunaEntryTriggerOperatingReport(report = {}) {
  const summary = report.summary || {};
  return [
    '🎯 Luna entry-trigger operating report',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 24}h`,
    `active=${summary.activeCount ?? 'n/a'} / armed=${summary.armed ?? 'n/a'} / waiting=${summary.waiting ?? 'n/a'} / fired=${summary.fired ?? 'n/a'} / dup=${summary.duplicateFiredScopeCount ?? 'n/a'}`,
    summary.heartbeatSource === 'retired_legacy_ignored'
      ? `heartbeat: retired legacy ignored / legacyAge=${summary.legacyHeartbeatAgeMinutes ?? 'n/a'}m / exchange=${summary.heartbeatExchange || 'n/a'} / matched=${summary.heartbeatMatchesExchange === true}${summary.heartbeatIgnoredReason ? ` / ignored=${summary.heartbeatIgnoredReason}` : ''}`
      : `heartbeat: ${summary.heartbeatAgeMinutes ?? 'n/a'}m / exchange=${summary.heartbeatExchange || 'n/a'} / matched=${summary.heartbeatMatchesExchange === true} / mode=${summary.heartbeatMode || 'n/a'} / live=${summary.heartbeatAllowLiveFire === true} / checked=${summary.heartbeatChecked ?? 'n/a'} / readyBlocked=${summary.heartbeatReadyBlocked ?? 'n/a'}${summary.heartbeatIgnoredReason ? ` / ignored=${summary.heartbeatIgnoredReason}` : ''}`,
    `readiness: checked=${summary.readinessChecked ?? 0} / waiting=${summary.readinessWaiting ?? 0} / fired=${summary.readinessFired ?? 0}`,
    `waitReasons: ${Object.entries(summary.waitReasonCounts || {}).map(([key, count]) => `${key}:${count}`).join(', ') || 'none'}`,
    `readinessActions: ${summary.readinessRemediationCommands ?? 0}`,
    `activeQuality: checked=${summary.activeQualityChecked ?? 0} / blocked=${summary.activeQualityBlocked ?? 0} / pass=${summary.activeQualityPass ?? 0} / reasons=${Object.entries(summary.activeQualityBlockReasons || {}).map(([key, count]) => `${key}:${count}`).join(', ') || 'none'}`,
    `warnings: ${(report.warnings || []).length ? report.warnings.join(' / ') : 'none'}`,
  ].join('\n');
}

export async function publishLunaEntryTriggerOperatingReport(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaEntryTriggerOperatingReport(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      exchange: report.exchange,
      summary: report.summary,
      readinessRemediationPlan: report.readinessRemediationPlan || null,
      warnings: report.warnings || [],
    },
  });
}

export async function runLunaEntryTriggerOperatingReportSmoke() {
  const scopedMismatch = selectExchangeScopedHeartbeat({
    heartbeat: {
      payload: {
        exchange: 'kis',
        result: { checked: 1, results: [{ symbol: '005930', fireReadiness: { mtfAgreement: 0 } }] },
      },
    },
  }, 'binance');
  assert.equal(scopedMismatch.matchesExchange, false);
  assert.equal(scopedMismatch.results.length, 0);
  assert.equal(scopedMismatch.ignoredReason, 'heartbeat_exchange_mismatch:kis');
  const scopedMatch = selectExchangeScopedHeartbeat({
    heartbeat: {
      payload: {
        exchange: 'binance',
        result: { checked: 1, results: [{ symbol: 'BTC/USDT', fireReadiness: { mtfAgreement: 0.9 } }] },
      },
    },
  }, 'binance');
  assert.equal(scopedMatch.matchesExchange, true);
  assert.equal(scopedMatch.results.length, 1);
  const telemetryMissing = summarizeReadinessResults([
    {
      fired: false,
      fireReason: 'fire_condition_unmet',
      fireReadiness: {
        mtfBullish: false,
        mtfAgreement: 0,
        volumeBurst: 0,
        technicalTelemetry: { mtfAvailable: false, volumeAvailable: false, missing: true },
      },
    },
  ]);
  assert.equal(telemetryMissing.waitReasonCounts.mtf_telemetry_missing, 1);
  assert.equal(telemetryMissing.waitReasonCounts.volume_telemetry_missing, 1);
  assert.equal(telemetryMissing.waitReasonCounts.mtf_not_bullish, undefined);
  assert.equal(telemetryMissing.waitReasonCounts.mtf_agreement_below_0_72, undefined);
  const promotionReadyButMtfWaiting = summarizeReadinessResults([
    {
      symbol: 'PEPE/USDT',
      fired: false,
      fireReason: 'promotion_shadow_readiness_incomplete',
      fireReadiness: {
        promotionPassCount: 14,
        promotionConsecutivePasses: 14,
        minPassCount: 3,
        minConsecutivePasses: 3,
        confidence: 0.66,
        minConfidence: 0.65,
        mtfBullish: false,
        mtfDominantSignal: 'HOLD',
        mtfAgreement: 0.66,
        technicalTelemetry: { mtfAvailable: true, volumeAvailable: true },
      },
    },
  ]);
  assert.equal(promotionReadyButMtfWaiting.waitReasonCounts.promotion_shadow_readiness_incomplete, undefined);
  assert.equal(promotionReadyButMtfWaiting.waitReasonCounts.promotion_ready_entry_confirmation_pending, 1);
  assert.equal(promotionReadyButMtfWaiting.waitReasonCounts.mtf_not_bullish, 1);
  const promotionReadyButConfidenceLow = summarizeReadinessResults([
    {
      symbol: 'PEPE/USDT',
      fired: false,
      fireReason: 'promotion_shadow_readiness_incomplete',
      fireReadiness: {
        promotionPassCount: 14,
        promotionConsecutivePasses: 14,
        minPassCount: 3,
        minConsecutivePasses: 3,
        confidence: 0.6312,
        minConfidence: 0.65,
        mtfBullish: false,
        mtfDominantSignal: 'HOLD',
        mtfAgreement: 0.66,
        technicalTelemetry: { mtfAvailable: true, volumeAvailable: true },
      },
    },
  ]);
  assert.equal(promotionReadyButConfidenceLow.waitReasonCounts.promotion_ready_entry_confirmation_pending, undefined);
  assert.equal(promotionReadyButConfidenceLow.waitReasonCounts.promotion_ready_confidence_below_min, 1);
  const report = await buildLunaEntryTriggerOperatingReport({ exchange: 'binance', hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.summary);
  assert.ok(report.tradeCompletionReadiness);
  assert.ok(report.activeQualityGate);
  assert.equal(typeof report.summary.waitReasonCounts, 'object');
  assert.equal(typeof report.summary.activeQualityBlockReasons, 'object');
  assert.ok(report.readinessRemediationPlan);
  assert.equal(report.readinessRemediationPlan.liveMutation, false);
  assert.equal(Array.isArray(report.readinessRemediationPlan.nextShadowCommands), true);
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('entry-trigger operating report'));
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('readiness:'));
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('readinessActions:'));
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('activeQuality:'));

  const remediationPlan = buildReadinessRemediationPlan({
    readiness: [{
      symbol: 'BTC/USDT',
      fired: false,
      blockers: ['promotion_shadow_readiness_incomplete', 'mtf_not_bullish', 'predictive_score_below_0_55'],
    }],
  }, { exchange: 'binance', hours: 24 });
  assert.equal(remediationPlan.waitingSymbols.includes('BTC/USDT'), true);
  assert.equal(remediationPlan.liveMutation, false);
  assert.equal(remediationPlan.nextShadowCommands.some((command) => command.includes('runtime:luna-paper-promotion-gate') && command.includes('--dry-run')), true);
  assert.equal(remediationPlan.nextShadowCommands.some((command) => command.includes('runtime:luna-entry-trigger-diagnose')), true);
  assert.equal(remediationPlan.nextShadowCommands.some((command) => command.includes('runtime:luna-predictive-evidence-refresh') && command.includes('--dry-run')), true);
  const entryConfirmationPlan = buildReadinessRemediationPlan(promotionReadyButMtfWaiting, { exchange: 'binance', hours: 24 });
  assert.equal(entryConfirmationPlan.nextShadowCommands.some((command) => command.includes('runtime:luna-paper-promotion-gate')), false);
  assert.equal(entryConfirmationPlan.nextShadowCommands.some((command) => command.includes('runtime:luna-entry-trigger-diagnose')), true);
  const confidencePlan = buildReadinessRemediationPlan(promotionReadyButConfidenceLow, { exchange: 'binance', hours: 24 });
  assert.equal(confidencePlan.nextShadowCommands.some((command) => command.includes('runtime:luna-paper-promotion-gate') && command.includes('--dry-run')), true);
  assert.equal(confidencePlan.nextShadowCommands.some((command) => command.includes('runtime:luna-entry-trigger-diagnose')), true);
  return report;
}

async function main() {
  const json = hasFlag('--json');
  const telegram = hasFlag('--telegram');
  const write = hasFlag('--write');
  const smoke = hasFlag('--smoke');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 24));
  const output = argValue('--output', DEFAULT_OUTPUT);
  const report = smoke ? await runLunaEntryTriggerOperatingReportSmoke() : await buildLunaEntryTriggerOperatingReport({ exchange, hours });
  if (write && !smoke) report.savedPath = saveLunaEntryTriggerOperatingReport(report, output);
  if (telegram && !smoke) await publishLunaEntryTriggerOperatingReport(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna entry-trigger operating report smoke ok' : renderLunaEntryTriggerOperatingReport(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger operating report 실패:',
  });
}
