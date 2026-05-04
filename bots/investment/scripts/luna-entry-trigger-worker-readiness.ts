#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getEntryTriggerOperationalStats } from '../shared/luna-discovery-entry-store.ts';
import { publishAlert } from '../shared/alert-publisher.ts';

const require = createRequire(import.meta.url);
const { getServiceOwnership, isRetiredService } = require('../../../packages/core/lib/service-ownership');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(INVESTMENT_DIR, '..', '..');
const LABEL = 'ai.investment.luna-entry-trigger-worker';
const REPO_PLIST = path.join(INVESTMENT_DIR, 'launchd', `${LABEL}.plist`);
const INSTALLED_PLIST = path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `${LABEL}.plist`);
const HEARTBEAT_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-entry-trigger-worker-heartbeat.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readPlist(file) {
  if (!fs.existsSync(file)) return null;
  const proc = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  if (proc.status !== 0 || !proc.stdout) return null;
  try {
    return JSON.parse(proc.stdout);
  } catch {
    return null;
  }
}

function ageMinutes(iso) {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}

function launchctlPrint(label) {
  const proc = spawnSync('launchctl', ['print', `gui/${process.getuid?.() || 501}/${label}`], { encoding: 'utf8' });
  return {
    ok: proc.status === 0,
    status: proc.status,
    summary: String(proc.stdout || proc.stderr || '').split('\n').slice(0, 8).join('\n'),
  };
}

export async function buildLunaEntryTriggerWorkerReadiness({
  exchange = 'binance',
  hours = 24,
  maxHeartbeatAgeMinutes = 10,
} = {}) {
  const repoPlist = readPlist(REPO_PLIST);
  const installedPlist = readPlist(INSTALLED_PLIST);
  const heartbeat = readJson(process.env.LUNA_ENTRY_TRIGGER_HEARTBEAT_PATH || HEARTBEAT_PATH);
  const heartbeatAge = heartbeat?.checkedAt ? ageMinutes(heartbeat.checkedAt) : null;
  const ownership = getServiceOwnership(LABEL);
  const stats = await getEntryTriggerOperationalStats({ exchange, hours }).catch((error) => ({
    error: error?.message || String(error),
  }));
  if (isRetiredService(LABEL)) {
    const service = {
      ok: true,
      status: null,
      retired: true,
      replacement: ownership?.replacement || 'luna.skills.entry_trigger',
      summary: 'retired service; entry triggers are handled by Luna skills/runtime scheduler',
    };
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      status: 'entry_trigger_worker_migrated_to_luna_skill',
      label: LABEL,
      replacement: ownership?.replacement || 'luna.skills.entry_trigger',
      repoRoot: REPO_ROOT,
      repoPlist: {
        path: REPO_PLIST,
        exists: !!repoPlist,
        startIntervalSeconds: Number(repoPlist?.StartInterval || 0) || null,
        programArguments: repoPlist?.ProgramArguments || [],
        env: repoPlist?.EnvironmentVariables || {},
      },
      installedPlist: {
        path: INSTALLED_PLIST,
        exists: !!installedPlist,
        startIntervalSeconds: Number(installedPlist?.StartInterval || 0) || null,
      },
      launchctl: service,
      heartbeat: {
        path: process.env.LUNA_ENTRY_TRIGGER_HEARTBEAT_PATH || HEARTBEAT_PATH,
        exists: !!heartbeat,
        ageMinutes: heartbeatAge,
        payload: heartbeat,
      },
      service,
      stats,
      warnings: [],
      installCommand: null,
      unloadCommand: null,
      migration: {
        retired: true,
        replacement: ownership?.replacement || null,
      },
    };
  }
  const service = launchctlPrint(LABEL);
  const warnings = [];
  if (!repoPlist) warnings.push('repo launchd plist missing');
  if (!installedPlist) warnings.push('installed launchd plist missing');
  if (!service.ok) warnings.push('launchctl service not loaded');
  if (!heartbeat) warnings.push('worker heartbeat missing');
  if (heartbeatAge != null && heartbeatAge > maxHeartbeatAgeMinutes) warnings.push(`worker heartbeat stale: ${heartbeatAge}m`);
  if (Number(stats?.duplicateFiredScopeCount || 0) > 0) warnings.push(`duplicate fired scopes: ${stats.duplicateFiredScopeCount}`);

  return {
    ok: warnings.length === 0,
    checkedAt: new Date().toISOString(),
    status: warnings.length === 0 ? 'entry_trigger_worker_ready' : 'entry_trigger_worker_attention',
    label: LABEL,
    repoRoot: REPO_ROOT,
    repoPlist: {
      path: REPO_PLIST,
      exists: !!repoPlist,
      startIntervalSeconds: Number(repoPlist?.StartInterval || 0) || null,
      programArguments: repoPlist?.ProgramArguments || [],
      env: repoPlist?.EnvironmentVariables || {},
    },
    installedPlist: {
      path: INSTALLED_PLIST,
      exists: !!installedPlist,
      startIntervalSeconds: Number(installedPlist?.StartInterval || 0) || null,
    },
    launchctl: service,
    heartbeat: {
      path: process.env.LUNA_ENTRY_TRIGGER_HEARTBEAT_PATH || HEARTBEAT_PATH,
      exists: !!heartbeat,
      ageMinutes: heartbeatAge,
      payload: heartbeat,
    },
    stats,
    warnings,
    installCommand: `cp ${REPO_PLIST} ${INSTALLED_PLIST} && launchctl bootstrap gui/$(id -u) ${INSTALLED_PLIST}`,
    unloadCommand: `launchctl bootout gui/$(id -u) ${INSTALLED_PLIST}`,
  };
}

export function renderLunaEntryTriggerWorkerReadiness(report = {}) {
  return [
    '🎯 Luna entry-trigger worker readiness',
    `status: ${report.status || 'unknown'}`,
    `warnings: ${(report.warnings || []).length ? report.warnings.join(' / ') : 'none'}`,
    `repo plist: ${report.repoPlist?.exists ? 'yes' : 'no'} / installed: ${report.installedPlist?.exists ? 'yes' : 'no'} / launchctl: ${report.launchctl?.ok ? 'loaded' : 'not_loaded'}`,
    `heartbeat: ${report.heartbeat?.exists ? `${report.heartbeat.ageMinutes ?? 'n/a'}m ago` : 'missing'}`,
    `entry triggers: active=${report.stats?.activeCount ?? 'n/a'} / duplicate fired=${report.stats?.duplicateFiredScopeCount ?? 'n/a'}`,
  ].join('\n');
}

export async function publishLunaEntryTriggerWorkerReadiness(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaEntryTriggerWorkerReadiness(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      warnings: report.warnings || [],
      activeCount: report.stats?.activeCount ?? null,
      duplicateFiredScopeCount: report.stats?.duplicateFiredScopeCount ?? null,
    },
  });
}

export async function runLunaEntryTriggerWorkerReadinessSmoke() {
  const report = await buildLunaEntryTriggerWorkerReadiness({ exchange: 'binance', hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.repoPlist.path.endsWith(`${LABEL}.plist`));
  assert.ok(Array.isArray(report.warnings));
  if (report.migration?.retired) {
    assert.equal(report.installCommand, null);
    assert.equal(report.unloadCommand, null);
    assert.ok(report.replacement);
  } else {
    assert.ok(report.installCommand.includes(LABEL));
  }
  return report;
}

async function main() {
  const json = process.argv.includes('--json');
  const telegram = process.argv.includes('--telegram');
  const report = await buildLunaEntryTriggerWorkerReadiness();
  if (telegram) await publishLunaEntryTriggerWorkerReadiness(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else if (!telegram) console.log(renderLunaEntryTriggerWorkerReadiness(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger worker readiness 실패:',
  });
}
