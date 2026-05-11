#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaSourceHealthAudit } from '../shared/luna-source-health-audit.ts';
import { publishLunaBottleneckEvent } from '../shared/luna-bottleneck-events.ts';
import { runLunaLlmHotPathAudit } from './runtime-luna-llm-hotpath-audit.ts';
import { buildLunaDiscoveryFunnelReport } from './runtime-luna-discovery-funnel-report.ts';
import { buildMarketdataRealtimeConnectivityReport } from './runtime-marketdata-realtime-connectivity.ts';
import { buildLunaOperationalBlockerPack } from './runtime-luna-operational-blocker-pack.ts';
import { buildLunaOperationalActionBoardFromPack } from './runtime-luna-operational-action-board.ts';
import { buildLunaLiveFireFinalGate } from './luna-live-fire-final-gate.ts';
import { buildLunaPostLiveFireVerification } from './luna-post-live-fire-verify.ts';

const DEFAULT_HOURS = 6;
const PROTECTED_6 = [
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
  'ai.elixir.supervisor',
  'ai.luna.marketdata-mcp',
  'ai.claude.auto-dev.autonomous',
  'ai.hub.resource-api',
];

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function capture(name, fn) {
  try {
    const value = await fn();
    return { ok: true, name, value };
  } catch (error) {
    return { ok: false, name, error: error?.message || String(error) };
  }
}

function compactList(values = []) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function prefixList(prefix, values = []) {
  return compactList(values).map((value) => `${prefix}:${value}`);
}

function buildSafeFixCandidates({ discovery, llm, marketdata, actionBoard } = {}) {
  const candidates = [];
  const discoveryBottlenecks = discovery?.bottlenecks || [];
  const recommendations = discovery?.recommendations || [];
  if (recommendations.includes('all_markets_discovery_candidate_empty')) {
    candidates.push({
      id: 'refresh_discovery_candidates_dry_run',
      type: 'diagnostic',
      risk: 'low',
      applyMode: 'dry_run_only',
      reason: 'candidate universe is empty',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-active-candidate-analysis-refresh -- --market=crypto --hours=24 --limit=20 --json',
    });
  }
  if (recommendations.includes('candidate_to_entry_trigger_funnel_needs_review')) {
    candidates.push({
      id: 'inspect_entry_filter_thresholds',
      type: 'code_or_config_review',
      risk: 'medium',
      applyMode: 'codex_patch_required',
      reason: 'candidates exist but no actionable entry path is forming',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-decision-filter -- --json',
    });
  }
  if (discoveryBottlenecks.some((item) => /sentiment|onchain|market_flow/.test(item))) {
    candidates.push({
      id: 'targeted_top_n_enrichment',
      type: 'runtime_operator',
      risk: 'medium',
      applyMode: 'confirm_required',
      reason: 'candidate evidence is missing for top-N enrichment path',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-active-candidate-analysis-refresh -- --apply --confirm=luna-active-candidate-analysis-refresh --market=crypto --hours=24 --limit=20 --max-symbols=2 --max-enrichment-symbols=1 --targeted-global-cooldown --json',
    });
  }
  if ((llm?.warnings || []).includes('unexpected_llm_enrichment_path_detected')) {
    candidates.push({
      id: 'repair_llm_hotpath_plan',
      type: 'code_review',
      risk: 'medium',
      applyMode: 'codex_patch_required',
      reason: 'unexpected LLM enrichment path detected',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-llm-hotpath-audit -- --hours=6 --json',
    });
  }
  if ((llm?.nonBlockingWarnings || []).includes('stale_active_candidate_refresh_sessions_detected')) {
    candidates.push({
      id: 'close_stale_active_refresh_sessions',
      type: 'runtime_operator',
      risk: 'low',
      applyMode: 'confirm_required',
      reason: 'historical stale active refresh sessions can distort hot-path accounting',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-active-refresh-stale-close -- --apply --confirm=luna-active-candidate-analysis-refresh-stale-close --json',
    });
  }
  if ((marketdata?.blockers || []).length > 0) {
    candidates.push({
      id: 'inspect_marketdata_connectivity',
      type: 'diagnostic',
      risk: 'low',
      applyMode: 'read_only',
      reason: 'marketdata realtime connectivity has blockers',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:marketdata-realtime-connectivity -- --json --no-fail',
    });
  }
  if (actionBoard?.agentBusHygiene?.applyAllowedNow === true) {
    candidates.push({
      id: 'agent_bus_hygiene_safe_expire',
      type: 'runtime_operator',
      risk: 'low',
      applyMode: 'confirm_required',
      reason: 'only safe-expire agent bus messages are pending',
      command: actionBoard.commands?.busHygieneApply,
    });
  }
  return candidates.filter((item) => item.command);
}

function buildReportFromEvidence({
  generatedAt = new Date().toISOString(),
  hours = DEFAULT_HOURS,
  sourceHealth = {},
  llm = {},
  discovery = {},
  marketdata = {},
  blockerPack = {},
  actionBoard = {},
  finalGate = {},
  postLive = {},
  collectionErrors = [],
} = {}) {
  const hardBlockers = compactList([
    ...collectionErrors.map((item) => `collection:${item.name}:${item.error}`),
    ...prefixList('source_health', sourceHealth.blockers || []),
    ...prefixList('operational', blockerPack.hardBlockers || []),
    ...prefixList('live_fire_final_gate', finalGate.blockers || []),
  ]);
  const bottlenecks = compactList([
    ...prefixList('llm_hotpath', llm.warnings || []),
    ...prefixList('discovery', discovery.bottlenecks || []),
    ...prefixList('marketdata', marketdata.blockers || []),
    ...prefixList('post_live', postLive.blockers || []),
  ]);
  const warnings = compactList([
    ...prefixList('llm_hotpath', llm.nonBlockingWarnings || []),
    ...prefixList('discovery', discovery.recommendations || []),
    ...prefixList('marketdata', marketdata.crypto?.decision?.warnings || []),
    ...prefixList('marketdata', marketdata.domestic?.decision?.warnings || []),
    ...prefixList('marketdata', marketdata.overseas?.decision?.warnings || []),
  ]);
  const safeFixCandidates = buildSafeFixCandidates({ discovery, llm, marketdata, actionBoard });
  const status = hardBlockers.length > 0
    ? 'luna_bottleneck_hard_blocked'
    : bottlenecks.length > 0
      ? 'luna_bottleneck_attention'
      : warnings.length > 0
        ? 'luna_bottleneck_clear_with_warnings'
        : 'luna_bottleneck_clear';
  return {
    ok: hardBlockers.length === 0,
    status,
    generatedAt,
    hours,
    protected6: {
      labels: PROTECTED_6,
      policy: 'never unload/restart/kill from this operator',
    },
    hardBlockers,
    bottlenecks,
    warnings,
    safeFixCandidates,
    nextActions: safeFixCandidates.length > 0
      ? safeFixCandidates.map((item) => `${item.id}: ${item.command}`)
      : ['continue 30-minute observation loop'],
    evidenceSummary: {
      sourceHealth: sourceHealth.status || (sourceHealth.ok ? 'ok' : 'unknown'),
      llmHotPath: llm.status || null,
      discoveryFunnel: discovery.status || null,
      marketdata: marketdata.status || null,
      operationalBlockerPack: blockerPack.status || null,
      finalGate: finalGate.status || null,
      postLive: postLive.status || null,
      manualTasks: actionBoard.manualReconcile?.count || 0,
      exchangeLookupRetry: actionBoard.exchangeLookupRetry?.count || 0,
    },
    evidence: {
      sourceHealth,
      llm,
      discovery,
      marketdata,
      blockerPack: {
        status: blockerPack.status,
        hardBlockers: blockerPack.hardBlockers || [],
        pendingObservation: blockerPack.pendingObservation || [],
      },
      actionBoard,
      finalGate: {
        ok: finalGate.ok,
        status: finalGate.status,
        blockers: finalGate.blockers || [],
        nextCommands: finalGate.nextCommands || [],
      },
      postLive,
      collectionErrors,
    },
    commands: {
      rerun: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-bottleneck-autonomy -- --json --publish-events',
      smoke: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s check:luna-bottleneck-autonomy',
      liveFireRollback: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-watchdog -- --apply --force-stop --confirm=rollback-luna-live-fire --json',
    },
  };
}

export async function buildLunaBottleneckAutonomyReport({
  hours = DEFAULT_HOURS,
  includeRealtime = true,
  includeFinalGate = true,
  includePostLive = true,
} = {}) {
  const tasks = [
    capture('sourceHealth', () => buildLunaSourceHealthAudit()),
    capture('llm', () => runLunaLlmHotPathAudit({ hours, limit: 30 })),
    capture('discovery', () => buildLunaDiscoveryFunnelReport({ hours, market: 'all' })),
    capture('blockerPack', () => buildLunaOperationalBlockerPack({ hours, days: 7 })),
  ];
  if (includeRealtime) {
    tasks.push(capture('marketdata', () => buildMarketdataRealtimeConnectivityReport({
      timeoutMs: 2500,
      realtimeWaitMs: 2500,
      realtimePollMs: 750,
    })));
  }
  if (includeFinalGate) tasks.push(capture('finalGate', () => buildLunaLiveFireFinalGate({ hours })));
  if (includePostLive) tasks.push(capture('postLive', () => buildLunaPostLiveFireVerification({ hours })));
  const collected = await Promise.all(tasks);
  const byName = Object.fromEntries(collected.map((item) => [item.name, item]));
  const blockerPack = byName.blockerPack?.value || {};
  const actionBoard = blockerPack ? buildLunaOperationalActionBoardFromPack(blockerPack) : {};
  return buildReportFromEvidence({
    hours,
    sourceHealth: byName.sourceHealth?.value || {},
    llm: byName.llm?.value || {},
    discovery: byName.discovery?.value || {},
    marketdata: byName.marketdata?.value || {},
    blockerPack,
    actionBoard,
    finalGate: byName.finalGate?.value || {},
    postLive: byName.postLive?.value || {},
    collectionErrors: collected.filter((item) => !item.ok).map((item) => ({ name: item.name, error: item.error })),
  });
}

export function buildLunaBottleneckAutonomyFixtureReport() {
  return buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    llm: {
      status: 'luna_llm_hotpath_attention',
      warnings: ['unexpected_llm_enrichment_path_detected'],
      nonBlockingWarnings: ['stale_active_candidate_refresh_sessions_detected'],
    },
    discovery: {
      status: 'luna_discovery_funnel_attention',
      bottlenecks: ['crypto:sentiment_analysis_missing_for_candidates'],
      recommendations: ['candidate_to_entry_trigger_funnel_needs_review'],
    },
    marketdata: {
      status: 'marketdata_realtime_connectivity_attention',
      blockers: ['tradingview_ws_disconnected'],
    },
    blockerPack: {
      status: 'operational_blocked',
      hardBlockers: ['reconcile:LUNC/USDT:manual_reconcile_required'],
      pendingObservation: ['7day_observation_pending'],
    },
    actionBoard: {
      manualReconcile: { count: 1 },
      exchangeLookupRetry: { count: 0 },
      agentBusHygiene: { applyAllowedNow: false },
    },
    finalGate: {
      status: 'luna_live_fire_final_gate_blocked',
      blockers: ['manual_reconcile_required'],
    },
    postLive: {
      status: 'luna_post_live_fire_verified',
      blockers: [],
    },
  });
}

export async function runLunaBottleneckAutonomyOperatorSmoke() {
  const report = buildLunaBottleneckAutonomyFixtureReport();
  assert.equal(report.ok, false);
  assert.equal(report.status, 'luna_bottleneck_hard_blocked');
  assert.ok(report.hardBlockers.includes('operational:reconcile:LUNC/USDT:manual_reconcile_required'));
  assert.ok(report.bottlenecks.includes('llm_hotpath:unexpected_llm_enrichment_path_detected'));
  assert.ok(report.safeFixCandidates.some((item) => item.id === 'repair_llm_hotpath_plan'));
  assert.equal(report.protected6.labels.includes('ai.hub.resource-api'), true);
  assert.match(report.commands.liveFireRollback, /rollback-luna-live-fire/);
  return { ok: true, report };
}

async function main() {
  const argv = process.argv.slice(2);
  const smoke = hasFlag('smoke', argv);
  const json = hasFlag('json', argv);
  const publishEvents = hasFlag('publish-events', argv);
  const result = smoke
    ? await runLunaBottleneckAutonomyOperatorSmoke()
    : await buildLunaBottleneckAutonomyReport({
        hours: Math.max(1, Number(argValue('hours', DEFAULT_HOURS, argv)) || DEFAULT_HOURS),
        includeRealtime: !hasFlag('skip-realtime', argv),
        includeFinalGate: !hasFlag('skip-final-gate', argv),
        includePostLive: !hasFlag('skip-post-live', argv),
      });
  if (!smoke && publishEvents) result.eventPublish = await publishLunaBottleneckEvent(result);
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna bottleneck autonomy operator smoke ok');
  else {
    console.log(`${result.status} hard=${result.hardBlockers.length} bottlenecks=${result.bottlenecks.length} safeFixes=${result.safeFixCandidates.length}`);
  }
  if (!smoke && result.hardBlockers?.length > 0 && !hasFlag('no-fail', argv)) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-bottleneck-autonomy-operator 실패:' });
}
