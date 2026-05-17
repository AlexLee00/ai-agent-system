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

function readinessBlockers(item = {}) {
  const details = item.fireReadiness || {};
  const blockers = [];
  if (item.fired === true) return blockers;
  if (item.fireReason) blockers.push(String(item.fireReason));
  if (details.mtfBullish === false) blockers.push('mtf_not_bullish');
  if (details.mtfDominantSignal && String(details.mtfDominantSignal).toUpperCase() !== 'BUY') {
    blockers.push('mtf_dominant_not_buy');
  }
  const predictiveScore = finiteNumber(details.predictiveScore);
  if (predictiveScore != null && predictiveScore < 0.55) blockers.push('predictive_score_below_0_55');
  const mtfAgreement = finiteNumber(details.mtfAgreement);
  if (mtfAgreement != null && mtfAgreement < 0.72) blockers.push('mtf_agreement_below_0_72');
  const volumeBurst = finiteNumber(details.volumeBurst);
  if (volumeBurst != null && volumeBurst < 1.1) blockers.push('volume_burst_below_1_1');
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
      breakoutRetest: details.breakoutRetest === true,
      newsMomentum: finiteNumber(details.newsMomentum),
      technicalConfirmation: details.technicalConfirmation || null,
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

async function buildActiveQualityGateSummary({ exchange = 'binance' } = {}) {
  const active = await listActiveEntryTriggers({ exchange, limit: 1000 }).catch(() => []);
  const symbols = [...new Set((active || []).map((row) => String(row.symbol || '').trim().toUpperCase()).filter(Boolean))];
  const qualityBySymbol = await loadActiveEntryTriggerQuality(symbols, { exchange }).catch(() => new Map());
  const byReason = {};
  const items = (active || []).map((trigger) => {
    const symbol = String(trigger.symbol || '').trim().toUpperCase();
    const gate = evaluateActiveEntryTriggerQualityGate(trigger, qualityBySymbol.get(symbol), {});
    if (!gate.ok) addCount(byReason, gate.reason);
    return {
      triggerId: trigger.id || null,
      symbol,
      state: trigger.trigger_state || null,
      ok: gate.ok === true,
      reason: gate.reason || null,
      reasons: gate.reasons || [],
      backtestGateStatus: gate.backtest?.gateStatus || null,
      backtestFresh: gate.backtest?.fresh ?? null,
      backtestHealthy: gate.backtest?.healthy ?? null,
      predictiveDecision: gate.predictive?.decision || null,
      predictiveScore: finiteNumber(gate.predictive?.score),
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
  const heartbeatResult = readiness?.heartbeat?.payload?.result || {};
  const readinessSummary = summarizeReadinessResults(heartbeatResult?.results || []);
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
    },
    tradeCompletionReadiness: readinessSummary,
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
      ? `heartbeat: retired legacy ignored / legacyAge=${summary.legacyHeartbeatAgeMinutes ?? 'n/a'}m`
      : `heartbeat: ${summary.heartbeatAgeMinutes ?? 'n/a'}m / mode=${summary.heartbeatMode || 'n/a'} / live=${summary.heartbeatAllowLiveFire === true} / checked=${summary.heartbeatChecked ?? 'n/a'} / readyBlocked=${summary.heartbeatReadyBlocked ?? 'n/a'}`,
    `readiness: checked=${summary.readinessChecked ?? 0} / waiting=${summary.readinessWaiting ?? 0} / fired=${summary.readinessFired ?? 0}`,
    `waitReasons: ${Object.entries(summary.waitReasonCounts || {}).map(([key, count]) => `${key}:${count}`).join(', ') || 'none'}`,
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
      warnings: report.warnings || [],
    },
  });
}

export async function runLunaEntryTriggerOperatingReportSmoke() {
  const report = await buildLunaEntryTriggerOperatingReport({ exchange: 'binance', hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.summary);
  assert.ok(report.tradeCompletionReadiness);
  assert.ok(report.activeQualityGate);
  assert.equal(typeof report.summary.waitReasonCounts, 'object');
  assert.equal(typeof report.summary.activeQualityBlockReasons, 'object');
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('entry-trigger operating report'));
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('readiness:'));
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('activeQuality:'));
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
