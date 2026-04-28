#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getEntryTriggerOperationalStats } from '../shared/luna-discovery-entry-store.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
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

export async function buildLunaEntryTriggerOperatingReport({ exchange = 'binance', hours = 24 } = {}) {
  const [stats, readiness] = await Promise.all([
    getEntryTriggerOperationalStats({ exchange, hours }),
    buildLunaEntryTriggerWorkerReadiness({ exchange, hours }),
  ]);
  const heartbeatResult = readiness?.heartbeat?.payload?.result || {};
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
      heartbeatAgeMinutes: readiness?.heartbeat?.ageMinutes ?? null,
      heartbeatMode: heartbeatResult?.mode || null,
      heartbeatAllowLiveFire: heartbeatResult?.allowLiveFire === true,
      heartbeatChecked: Number(heartbeatResult?.checked || 0),
      heartbeatFired: Number(heartbeatResult?.fired || 0),
      heartbeatReadyBlocked: Number(heartbeatResult?.readyBlocked || 0),
    },
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
    `heartbeat: ${summary.heartbeatAgeMinutes ?? 'n/a'}m / mode=${summary.heartbeatMode || 'n/a'} / live=${summary.heartbeatAllowLiveFire === true} / checked=${summary.heartbeatChecked ?? 'n/a'} / readyBlocked=${summary.heartbeatReadyBlocked ?? 'n/a'}`,
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
  assert.ok(renderLunaEntryTriggerOperatingReport(report).includes('entry-trigger operating report'));
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
