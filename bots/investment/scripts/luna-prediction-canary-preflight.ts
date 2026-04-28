#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaKillSwitchCanaryPlan } from './luna-kill-switch-canary.ts';
import { buildLunaMapekCanaryObservation } from './luna-mapek-canary-observer.ts';
import { runLunaPredictiveValidationSmoke } from './luna-predictive-validation-smoke.ts';
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

export async function buildLunaPredictionCanaryPreflight({ hours = 24 } = {}) {
  const canaryPlan = await buildLunaKillSwitchCanaryPlan();
  const mapek = await buildLunaMapekCanaryObservation({ hours });
  const predictiveSmoke = runLunaPredictiveValidationSmoke();
  const nextKey = canaryPlan?.nextPhase?.key || null;
  const predictionPhase = (canaryPlan?.phases || []).find((phase) => phase.key === 'LUNA_PREDICTION_ENABLED') || null;
  const alreadyEnabled = predictionPhase?.enabled === true;
  const blockers = [];
  if (!alreadyEnabled && nextKey !== 'LUNA_PREDICTION_ENABLED') {
    blockers.push(`next canary is ${nextKey || 'none'}, not LUNA_PREDICTION_ENABLED`);
  }
  if (mapek.ok !== true) blockers.push('MAPE-K canary observation is not clean');
  if (predictiveSmoke?.ok !== true) blockers.push('predictive validation smoke failed');
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0
      ? (alreadyEnabled ? 'prediction_canary_already_enabled' : 'prediction_canary_ready')
      : 'prediction_canary_blocked',
    blockers,
    commands: blockers.length === 0 && !alreadyEnabled ? canaryPlan.commands : [],
    alreadyEnabled,
    canaryPlan,
    mapek: {
      ok: mapek.ok,
      status: mapek.status,
      warnings: mapek.warnings || [],
      observations: mapek.observations || [],
      cleanStreakSamples: mapek.bottleneck?.dispatch?.cleanStreakSamples ?? null,
      hardFailureCount: mapek.bottleneck?.dispatch?.hardFailureCount ?? null,
    },
    predictiveSmoke: {
      ok: predictiveSmoke.ok,
      advisoryCount: predictiveSmoke.advisory?.advisory ?? null,
      hardBlockedCount: predictiveSmoke.hard?.blocked ?? null,
    },
  };
}

export function renderLunaPredictionCanaryPreflight(report = {}) {
  return [
    '🧪 Luna prediction canary preflight',
    `status: ${report.status || 'unknown'}`,
    `ok: ${report.ok === true}`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `commands: ${(report.commands || []).length ? report.commands.join(' && ') : 'none'}`,
  ].join('\n');
}

export async function publishLunaPredictionCanaryPreflight(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaPredictionCanaryPreflight(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      blockers: report.blockers || [],
      commands: report.commands || [],
    },
  });
}

export async function runLunaPredictionCanaryPreflightSmoke() {
  const report = await buildLunaPredictionCanaryPreflight({ hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.status);
  assert.ok(Array.isArray(report.blockers));
  assert.equal(report.predictiveSmoke?.ok, true);
  return report;
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaPredictionCanaryPreflight(args);
  if (args.telegram) await publishLunaPredictionCanaryPreflight(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.telegram) console.log(renderLunaPredictionCanaryPreflight(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna prediction canary preflight 실패:',
  });
}
