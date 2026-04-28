#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaL5ReadinessReport } from './luna-l5-readiness-report.ts';
import {
  buildAutopilotBottleneckReport,
  renderAutopilotBottleneckReport,
} from './runtime-position-runtime-autopilot-bottleneck-report.ts';
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

function enabled(report, key) {
  return String(report?.G1_killSwitches?.[key]?.effectiveHint || '').trim().toLowerCase() === 'true';
}

export async function buildLunaMapekCanaryObservation({ hours = 24 } = {}) {
  const readiness = await buildLunaL5ReadinessReport();
  const bottleneck = buildAutopilotBottleneckReport({ hours });
  const mapekEnabled = enabled(readiness, 'LUNA_MAPEK_ENABLED');
  const hardFailures = Number(bottleneck?.dispatch?.hardFailureCount || 0);
  const status = !mapekEnabled
    ? 'mapek_canary_not_enabled'
    : hardFailures > 0
      ? 'mapek_canary_attention'
      : 'mapek_canary_observing';
  const warnings = [];
  if (!mapekEnabled) warnings.push('LUNA_MAPEK_ENABLED is not enabled');
  if (hardFailures > 0) warnings.push(`hard dispatch failures observed: ${hardFailures}`);
  const observations = [];
  if (Number(bottleneck?.dispatch?.staleCandidateCount || 0) > 0) {
    observations.push(`stale candidates observed as no-op: ${bottleneck.dispatch.staleCandidateCount}`);
  }
  if (Number(bottleneck?.dispatch?.historicalHardFailureCount || 0) > hardFailures) {
    observations.push(`historical hard failures recovered by clean streak: ${bottleneck.dispatch.historicalHardFailureCount}`);
  }
  return {
    ok: mapekEnabled && hardFailures === 0,
    checkedAt: new Date().toISOString(),
    status,
    hours,
    warnings,
    observations,
    readiness: {
      warnings: readiness.warnings || [],
      killSwitches: Object.fromEntries(Object.entries(readiness.G1_killSwitches || {}).map(([key, value]) => [
        key,
        value?.effectiveHint ?? null,
      ])),
      latestAutopilotStatus: readiness.G2_runtimeAutopilot?.history?.latestStatus || null,
      latestAutopilotAt: readiness.G2_runtimeAutopilot?.history?.latestRecordedAt || null,
    },
    bottleneck,
  };
}

export function renderLunaMapekCanaryObservation(report = {}) {
  return [
    '🌙 Luna MAPE-K canary observation',
    `status: ${report.status || 'unknown'}`,
    `ok: ${report.ok === true}`,
    `warnings: ${(report.warnings || []).length ? report.warnings.join(' / ') : 'none'}`,
    `observations: ${(report.observations || []).length ? report.observations.join(' / ') : 'none'}`,
    '',
    renderAutopilotBottleneckReport(report.bottleneck || {}),
  ].join('\n');
}

export async function publishLunaMapekCanaryObservation(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaMapekCanaryObservation(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      warnings: report.warnings || [],
      bottleneck: report.bottleneck?.dispatch || {},
    },
  });
}

export async function runLunaMapekCanaryObserverSmoke() {
  const report = await buildLunaMapekCanaryObservation({ hours: 24 });
  assert.ok(report.checkedAt);
  assert.ok(report.status);
  assert.ok(report.bottleneck);
  assert.ok(report.readiness);
  return report;
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaMapekCanaryObservation(args);
  if (args.telegram) await publishLunaMapekCanaryObservation(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else if (!args.telegram) console.log(renderLunaMapekCanaryObservation(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna MAPE-K canary observer 실패:',
  });
}
