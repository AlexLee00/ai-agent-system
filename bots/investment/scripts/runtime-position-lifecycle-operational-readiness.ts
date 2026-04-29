#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolvePositionLifecycleFlags } from '../shared/position-lifecycle-flags.ts';
import { refreshPositionSignals } from '../shared/position-signal-refresh.ts';
import { syncPositionsAtMarketOpen } from '../shared/position-sync.ts';
import {
  buildLifecycleExecutionReadiness,
  filterLifecycleCoverageProfiles,
  summarizeLifecyclePositionSync,
  summarizeLifecycleStageCoverage,
} from '../shared/position-lifecycle-operational-readiness.ts';
import { getInvestmentSyncRuntimeConfig } from '../shared/runtime-config.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    json: false,
    days: 7,
    limit: 200,
    sync: false,
    markets: ['crypto'],
    requirePositionSync: false,
    includeDustCoverage: false,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--sync') args.sync = true;
    else if (raw === '--require-position-sync') args.requirePositionSync = true;
    else if (raw === '--include-dust-coverage') args.includeDustCoverage = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 7));
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 200));
    else if (raw.startsWith('--markets=')) {
      const value = raw.split('=').slice(1).join('=') || 'crypto';
      args.markets = value.includes('all')
        ? ['domestic', 'overseas', 'crypto']
        : value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return args;
}

async function fetchLifecycleEvents(days = 7, limit = 5000) {
  return db.query(
    `SELECT *
       FROM investment.position_lifecycle_events
      WHERE created_at >= now() - ($1::int * INTERVAL '1 day')
      ORDER BY created_at DESC
      LIMIT $2`,
    [Math.max(1, Number(days || 7)), Math.max(1, Number(limit || 5000))],
  ).catch(() => []);
}

async function runPositionSync(markets = ['crypto']) {
  const results = await Promise.all(markets.map(async (market) => (
    syncPositionsAtMarketOpen(market).catch((error) => ({
      market,
      ok: false,
      error: error?.message || String(error),
    }))
  )));
  return summarizeLifecyclePositionSync(results);
}

export async function runPositionLifecycleOperationalReadiness(args = {}) {
  const flags = resolvePositionLifecycleFlags();
  const [runtimeReport, dispatchPreview, activeProfiles, livePositions, lifecycleEvents, signalRefresh, positionSyncSummary] = await Promise.all([
    runPositionRuntimeReport({ exchange: args.exchange || null, limit: args.limit || 200, json: true }),
    runPositionRuntimeDispatch({ exchange: args.exchange || null, limit: 20, phase6: true, json: true }),
    db.getActivePositionStrategyProfiles({ exchange: args.exchange || null, limit: args.limit || 200 }).catch(() => []),
    db.getAllPositions(args.exchange || null, false).catch(() => []),
    fetchLifecycleEvents(args.days || 7),
    refreshPositionSignals({
      exchange: args.exchange || null,
      source: 'position_lifecycle_readiness',
      limit: args.limit || 200,
    }).catch((error) => ({
      ok: false,
      enabled: true,
      count: 0,
      error: error?.message || String(error),
    })),
    args.sync ? runPositionSync(args.markets || ['crypto']) : Promise.resolve(null),
  ]);

  const syncRuntime = getInvestmentSyncRuntimeConfig();
  const coverageProfiles = filterLifecycleCoverageProfiles({
    activeProfiles,
    livePositions,
    dustThresholdUsdt: Number(syncRuntime?.cryptoMinNotionalUsdt || 10),
    includeDust: args.includeDustCoverage === true,
  });
  const coverageSummary = summarizeLifecycleStageCoverage({
    events: lifecycleEvents,
    activeProfiles: coverageProfiles.included,
  });
  const readiness = buildLifecycleExecutionReadiness({
    flags,
    runtimeReport,
    dispatchPreview,
    signalRefresh,
    positionSyncSummary,
    coverageSummary,
    requirePositionSync: args.requirePositionSync === true,
  });

  return {
    ok: readiness.ok,
    status: readiness.status,
    args,
    flags: {
      mode: flags.mode,
      phaseD: flags.phaseD.enabled,
      phaseE: flags.phaseE.enabled,
      phaseF: flags.phaseF.enabled,
      phaseG: flags.phaseG.enabled,
      phaseH: flags.phaseH.enabled,
    },
    readiness,
    runtimeDecision: runtimeReport.decision,
    dispatchStatus: dispatchPreview.status,
    signalRefresh: {
      ok: signalRefresh.ok !== false,
      enabled: signalRefresh.enabled === true,
      count: Number(signalRefresh.count || 0),
      error: signalRefresh.error || null,
    },
    positionSyncSummary,
    coverageSummary: {
      ok: coverageSummary.ok,
      activePositions: coverageSummary.activePositions,
      coveragePct: coverageSummary.coveragePct,
      missingByStage: coverageSummary.missingByStage,
      universe: coverageProfiles.meta,
      rows: coverageSummary.rows.slice(0, 20),
    },
  };
}

function renderText(payload = {}) {
  const lines = [
    '🧭 Luna Position Lifecycle Operational Readiness',
    `status: ${payload.status || 'unknown'}`,
    `mode: ${payload.flags?.mode || 'unknown'}`,
    `readiness: ${payload.readiness?.ok === true ? 'ok' : 'blocked'}`,
    `runtime: ${payload.runtimeDecision?.headline || 'n/a'}`,
    `dispatch: ${payload.dispatchStatus || 'unknown'}`,
    `signalRefresh: ${payload.signalRefresh?.enabled ? payload.signalRefresh.count : 'disabled'}`,
    `coverage: ${payload.coverageSummary?.coveragePct ?? 'n/a'}%`,
    `coverageUniverse: included=${payload.coverageSummary?.universe?.includedProfileCount ?? 'n/a'} / activeProfiles=${payload.coverageSummary?.universe?.activeProfileCount ?? 'n/a'} / orphanExcluded=${payload.coverageSummary?.universe?.excludedOrphanProfileCount ?? 'n/a'} / dustExcluded=${payload.coverageSummary?.universe?.excludedDustProfileCount ?? 'n/a'}`,
  ];
  for (const blocker of payload.readiness?.blockers || []) lines.push(`- blocker: ${blocker}`);
  for (const warning of payload.readiness?.warnings || []) lines.push(`- warning: ${warning}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionLifecycleOperationalReadiness(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-lifecycle-operational-readiness 오류:',
  });
}
