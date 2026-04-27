#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaKillSwitchCanaryPlan } from './luna-kill-switch-canary.ts';
import { buildLunaMapekCanaryObservation } from './luna-mapek-canary-observer.ts';
import { publishAlert } from '../shared/alert-publisher.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { json: false, telegram: false, hours: 24 };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--telegram') args.telegram = true;
    else if (raw.startsWith('--hours=')) args.hours = Math.max(1, Number(raw.split('=').slice(1).join('=') || 24));
  }
  return args;
}

export async function buildLunaValidationCanaryPreflight({ hours = 24 } = {}) {
  const canaryPlan = await buildLunaKillSwitchCanaryPlan();
  const mapek = await buildLunaMapekCanaryObservation({ hours });
  const nextKey = canaryPlan?.nextPhase?.key || null;
  const hardFailures = Number(mapek?.bottleneck?.dispatch?.hardFailureCount || 0);
  const blockers = [];
  if (nextKey !== 'LUNA_VALIDATION_ENABLED') {
    blockers.push(`next canary is ${nextKey || 'none'}, not LUNA_VALIDATION_ENABLED`);
  }
  if (mapek.ok !== true) {
    blockers.push('MAPE-K canary observation is not clean');
  }
  if (hardFailures > 0) {
    blockers.push(`hard dispatch failures remain: ${hardFailures}`);
  }
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'validation_canary_ready' : 'validation_canary_blocked',
    blockers,
    commands: blockers.length === 0 ? canaryPlan.commands : [],
    canaryPlan,
    mapek,
  };
}

export function renderLunaValidationCanaryPreflight(report = {}) {
  return [
    '🧪 Luna validation canary preflight',
    `status: ${report.status || 'unknown'}`,
    `ok: ${report.ok === true}`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `commands: ${(report.commands || []).length ? report.commands.join(' && ') : 'none'}`,
  ].join('\n');
}

export async function publishLunaValidationCanaryPreflight(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaValidationCanaryPreflight(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      blockers: report.blockers || [],
      commands: report.commands || [],
    },
  });
}

export async function runLunaValidationCanaryPreflightSmoke() {
  const report = await buildLunaValidationCanaryPreflight({ hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.status);
  assert.ok(Array.isArray(report.blockers));
  return report;
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaValidationCanaryPreflight(args);
  if (args.telegram) await publishLunaValidationCanaryPreflight(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.telegram) console.log(renderLunaValidationCanaryPreflight(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna validation canary preflight 실패:',
  });
}
