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
import { buildTradeDataAnalysisReport } from '../shared/trade-data-analysis-report.ts';

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

function isAgentBusQueryFailed(value) {
  return String(value || '') === 'agent_message_bus_hygiene:query_failed';
}

function getAgentBusClassification(blockerPack = {}) {
  return blockerPack.evidence?.busHygiene?.classification
    || blockerPack.evidence?.busHygiene
    || {};
}

function normalizeOperationalHardBlockers(blockerPack = {}) {
  return compactList(blockerPack.hardBlockers || []).filter((item) => {
    if (!isAgentBusQueryFailed(item)) return true;
    return false;
  });
}

function buildOperationalWarnings(blockerPack = {}) {
  const warnings = [];
  const rawHardBlockers = compactList(blockerPack.hardBlockers || []);
  const normalizedHardBlockers = normalizeOperationalHardBlockers(blockerPack);
  const classification = getAgentBusClassification(blockerPack);
  if (
    rawHardBlockers.some(isAgentBusQueryFailed)
    && !normalizedHardBlockers.some(isAgentBusQueryFailed)
  ) {
    warnings.push('agent_message_bus_hygiene_query_failed_unconfirmed');
  }
  if (Number(classification.reviewRequired || 0) > 0) {
    warnings.push(`agent_message_bus_hygiene_review_required:${Number(classification.reviewRequired || 0)}`);
  }
  if (Number(classification.safeExpire || 0) > 0) {
    warnings.push(`agent_message_bus_hygiene_safe_expire_available:${Number(classification.safeExpire || 0)}`);
  }
  return warnings;
}

function marketsWithDiscoveryBottleneck(discovery = {}, pattern) {
  return (discovery.markets || [])
    .filter((market) => (market.bottlenecks || []).some((code) => pattern.test(String(code || ''))))
    .map((market) => market.market)
    .filter(Boolean);
}

function marketsWithPreopenGap(discovery = {}, pattern) {
  return compactList([
    ...(discovery.preopenGaps || []).map((item) => {
      const [market, ...rest] = String(item || '').split(':');
      return pattern.test(rest.join(':')) ? market : null;
    }),
    ...(discovery.markets || []).flatMap((market) => {
      const pending = [
        ...(market.preopenReadiness?.pending || []),
        ...(market.observations || []),
      ];
      return pending.some((code) => pattern.test(String(code || ''))) ? market.market : [];
    }),
  ]).filter((market) => market === 'domestic' || market === 'overseas');
}

function findNamedBucket(buckets = [], names = []) {
  const wanted = new Set((names || []).map((name) => String(name || '').toLowerCase()));
  return (buckets || []).find((bucket) => wanted.has(String(bucket?.name || '').toLowerCase()));
}

function buildTradeDataBottlenecks(tradeData = {}) {
  const bottlenecks = [];
  if (!tradeData || tradeData.status !== 'needs_attention') return bottlenecks;
  const crypto = findNamedBucket(tradeData.journal?.markets, ['crypto', 'binance']);
  const trendFollowing = findNamedBucket(tradeData.journal?.strategyFamily?.buckets, ['trend_following']);
  const meanReversion = findNamedBucket(tradeData.journal?.strategyFamily?.buckets, ['mean_reversion']);
  const trendingBull = findNamedBucket(tradeData.journal?.marketRegime?.buckets, ['trending_bull']);
  if (crypto && Number(crypto.pnlSum) < 0) {
    bottlenecks.push('crypto_performance_needs_attention');
  }
  if (trendFollowing && Number(trendFollowing.pnlSum) < 0 && Number(trendFollowing.winRate) <= 0.3) {
    bottlenecks.push('crypto_trend_following_underperforming');
  }
  if (meanReversion && Number(meanReversion.pnlSum) < 0 && Number(meanReversion.winRate) <= 0.3) {
    bottlenecks.push('crypto_mean_reversion_underperforming');
  }
  if (trendingBull && Number(trendingBull.pnlSum) < 0 && Number(trendingBull.winRate) <= 0.3) {
    bottlenecks.push('crypto_trending_bull_loss_pressure');
  }
  return bottlenecks;
}

function compactTradeDataEvidence(tradeData = {}) {
  const crypto = findNamedBucket(tradeData.journal?.markets, ['crypto', 'binance']);
  const trendFollowing = findNamedBucket(tradeData.journal?.strategyFamily?.buckets, ['trend_following']);
  const meanReversion = findNamedBucket(tradeData.journal?.strategyFamily?.buckets, ['mean_reversion']);
  const trendingBull = findNamedBucket(tradeData.journal?.marketRegime?.buckets, ['trending_bull']);
  return {
    status: tradeData.status || null,
    warnings: tradeData.warnings || [],
    nextActions: tradeData.nextActions || [],
    signals: {
      total: tradeData.signals?.total || 0,
      failureRate: tradeData.signals?.failureRate ?? null,
      executionRate: tradeData.signals?.executionRate ?? null,
    },
    crypto: crypto ? {
      closed: crypto.closed,
      winRate: crypto.winRate,
      pnlSum: crypto.pnlSum,
      avgPnlPercent: crypto.avgPnlPercent,
    } : null,
    strategyPressure: {
      trendFollowing: trendFollowing ? {
        closed: trendFollowing.closed,
        winRate: trendFollowing.winRate,
        pnlSum: trendFollowing.pnlSum,
        avgPnlPercent: trendFollowing.avgPnlPercent,
      } : null,
      meanReversion: meanReversion ? {
        closed: meanReversion.closed,
        winRate: meanReversion.winRate,
        pnlSum: meanReversion.pnlSum,
        avgPnlPercent: meanReversion.avgPnlPercent,
      } : null,
      trendingBull: trendingBull ? {
        closed: trendingBull.closed,
        winRate: trendingBull.winRate,
        pnlSum: trendingBull.pnlSum,
        avgPnlPercent: trendingBull.avgPnlPercent,
      } : null,
    },
  };
}

function buildSafeFixCandidates({ discovery, llm, marketdata, blockerPack, actionBoard, tradeData } = {}) {
  const candidates = [];
  const discoveryBottlenecks = discovery?.bottlenecks || [];
  const recommendations = discovery?.recommendations || [];
  if (buildTradeDataBottlenecks(tradeData).length > 0) {
    candidates.push({
      id: 'inspect_crypto_trade_quality',
      type: 'diagnostic',
      risk: 'low',
      applyMode: 'read_only',
      reason: 'current operating epoch crypto PnL, win rate, or strategy bucket pressure needs review before relaxing entries',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-trade-data-analysis-report -- --json --limit=5000',
    });
    candidates.push({
      id: 'repair_crypto_selection_quality',
      type: 'code_review',
      risk: 'medium',
      applyMode: 'codex_patch_required',
      reason: 'crypto symbol selection and defensive/trend route evidence are underperforming; review data-derived guards, strategy route evidence, and backtest alignment',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-discovery-funnel -- --market=crypto --candidate-limit=40 --json',
    });
  }
  if (compactList(blockerPack?.hardBlockers || []).some(isAgentBusQueryFailed)) {
    candidates.push({
      id: 'inspect_agent_bus_hygiene',
      type: 'diagnostic',
      risk: 'low',
      applyMode: 'read_only',
      reason: 'agent bus hygiene query failed in the aggregated operator path',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:agent-message-bus-hygiene -- --json',
    });
  }
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
  if (discoveryBottlenecks.some((item) => /candidates_filtered_before_entry_trigger|analysis_completed_no_actionable_signal/.test(item))) {
    const markets = marketsWithDiscoveryBottleneck(discovery, /candidates_filtered_before_entry_trigger|analysis_completed_no_actionable_signal/);
    for (const market of markets.length > 0 ? markets : ['all']) {
      const marketArg = market === 'all' ? 'all' : market;
      candidates.push({
        id: `inspect_entry_prefilter_block_${market}`,
        type: 'diagnostic',
        risk: 'low',
        applyMode: 'read_only',
        reason: `${market} candidates are being filtered before entry trigger; inspect per-symbol reasons before changing thresholds`,
        command: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-decision-filter -- --market=${marketArg === 'all' ? 'crypto' : marketArg} --hours=24 --limit=20 --active-candidates --json`,
      });
      if (marketArg === 'overseas') {
        candidates.push({
          id: 'inspect_kis_overseas_funnel_trace',
          type: 'diagnostic',
          risk: 'low',
          applyMode: 'read_only',
          reason: 'overseas candidates need symbol-level funnel trace with signal, agent activity, and LLM route health',
          command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:kis-overseas-funnel-trace -- --hours=168 --limit=20 --json',
        });
      }
      candidates.push({
        id: `repair_entry_prefilter_block_${market}`,
        type: 'code_review',
        risk: 'medium',
        applyMode: 'codex_patch_required',
        reason: `${market} has analyzed candidates but no entry-trigger path; inspect discovery context, market-flow, and technical prefilter wiring`,
        command: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-decision-filter -- --market=${marketArg === 'all' ? 'crypto' : marketArg} --hours=24 --limit=20 --active-candidates --json`,
      });
      if (marketArg !== 'all') {
        candidates.push({
          id: `refresh_entry_prefilter_evidence_${market}`,
          type: 'runtime_operator',
          risk: 'medium',
          applyMode: 'confirm_required',
          reason: `${market} has candidate evidence but no entry-trigger path; refresh top-N missing or stale confirmation nodes without executing decisions`,
          command: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-active-candidate-analysis-refresh -- --apply --confirm=luna-active-candidate-analysis-refresh --market=${marketArg} --hours=24 --limit=20 --max-symbols=2 --max-enrichment-symbols=1 --targeted-global-cooldown --json`,
        });
      }
    }
  }
  if (recommendations.includes('preopen_market_preparation_pending')) {
    const markets = marketsWithPreopenGap(discovery, /market_flow|technical|sentiment|onchain/);
    for (const market of markets) {
      candidates.push({
        id: `preopen_targeted_analysis_refresh_${market}`,
        type: 'runtime_operator',
        risk: 'medium',
        applyMode: 'confirm_required',
        reason: `${market} has preopen candidate evidence gaps before the next session`,
        command: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-active-candidate-analysis-refresh -- --apply --confirm=luna-active-candidate-analysis-refresh --market=${market} --hours=${DEFAULT_HOURS} --limit=20 --max-symbols=5 --max-enrichment-symbols=2 --targeted-global-cooldown --json`,
      });
    }
  }
  if (
    discoveryBottlenecks.some((item) => /actionable_candidate_waiting_signal_persistence/.test(item))
    || recommendations.includes('actionable_candidates_waiting_market_cycle_or_signal_persistence')
  ) {
    const markets = marketsWithDiscoveryBottleneck(discovery, /actionable_candidate_waiting_signal_persistence/);
    for (const market of markets.length > 0 ? markets : ['all']) {
      const marketArg = market === 'all' ? 'crypto' : market;
      candidates.push({
        id: `inspect_signal_persistence_gap_${market}`,
        type: 'diagnostic',
        risk: 'low',
        applyMode: 'read_only',
        reason: `${market} has actionable candidates that did not become persisted BUY signals`,
        command: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-decision-filter -- --market=${marketArg} --hours=24 --limit=12 --active-candidates --json`,
      });
      candidates.push({
        id: `repair_signal_persistence_gap_${market}`,
        type: 'code_review',
        risk: 'medium',
        applyMode: 'codex_patch_required',
        reason: `${market} has likely actionable candidates but no BUY signal persistence; inspect and patch the discovery-to-signal persistence runtime path`,
        command: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-decision-filter -- --market=${marketArg} --hours=24 --limit=12 --active-candidates --json`,
      });
    }
  }
  if (discoveryBottlenecks.some((item) => /technical|sentiment|onchain|market_flow/.test(item))) {
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
  tradeData = {},
  blockerPack = {},
  actionBoard = {},
  finalGate = {},
  postLive = {},
  collectionErrors = [],
} = {}) {
  const operationalHardBlockers = normalizeOperationalHardBlockers(blockerPack);
  const operationalWarnings = buildOperationalWarnings(blockerPack);
  const tradeDataBottlenecks = buildTradeDataBottlenecks(tradeData);
  const hardBlockers = compactList([
    ...collectionErrors.map((item) => `collection:${item.name}:${item.error}`),
    ...prefixList('source_health', sourceHealth.blockers || []),
    ...prefixList('operational', operationalHardBlockers),
    ...prefixList('live_fire_final_gate', finalGate.blockers || []),
  ]);
  const bottlenecks = compactList([
    ...prefixList('llm_hotpath', llm.warnings || []),
    ...prefixList('discovery', discovery.bottlenecks || []),
    ...prefixList('trade_data', tradeDataBottlenecks),
    ...prefixList('marketdata', marketdata.blockers || []),
    ...prefixList('post_live', postLive.blockers || []),
  ]);
  const warnings = compactList([
    ...prefixList('llm_hotpath', llm.nonBlockingWarnings || []),
    ...prefixList('discovery', discovery.recommendations || []),
    ...prefixList('trade_data', tradeData.warnings || []),
    ...prefixList('operational', operationalWarnings),
    ...prefixList('marketdata', marketdata.crypto?.decision?.warnings || []),
    ...prefixList('marketdata', marketdata.domestic?.decision?.warnings || []),
    ...prefixList('marketdata', marketdata.overseas?.decision?.warnings || []),
  ]);
  const safeFixCandidates = buildSafeFixCandidates({ discovery, llm, marketdata, blockerPack, actionBoard, tradeData });
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
      tradeData: tradeData.status || null,
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
      tradeData: compactTradeDataEvidence(tradeData),
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
    () => capture('sourceHealth', () => buildLunaSourceHealthAudit()),
    () => capture('llm', () => runLunaLlmHotPathAudit({ hours, limit: 30 })),
    () => capture('discovery', () => buildLunaDiscoveryFunnelReport({ hours, market: 'all' })),
    () => capture('tradeData', () => buildTradeDataAnalysisReport({ limit: 5000 })),
    () => capture('blockerPack', () => buildLunaOperationalBlockerPack({ hours, days: 7 })),
  ];
  if (includeRealtime) {
    tasks.push(() => capture('marketdata', () => buildMarketdataRealtimeConnectivityReport({
      timeoutMs: 2500,
      realtimeWaitMs: 2500,
      realtimePollMs: 750,
    })));
  }
  if (includeFinalGate) tasks.push(() => capture('finalGate', () => buildLunaLiveFireFinalGate({ hours })));
  if (includePostLive) tasks.push(() => capture('postLive', () => buildLunaPostLiveFireVerification({ hours })));
  const collected = [];
  // These reports share Hub, KIS, and marketdata clients; serial collection avoids transient AggregateError storms.
  for (const task of tasks) {
    collected.push(await task());
  }
  const byName = Object.fromEntries(collected.map((item) => [item.name, item]));
  const blockerPack = byName.blockerPack?.value || {};
  const actionBoard = blockerPack ? buildLunaOperationalActionBoardFromPack(blockerPack) : {};
  return buildReportFromEvidence({
    hours,
    sourceHealth: byName.sourceHealth?.value || {},
    llm: byName.llm?.value || {},
    discovery: byName.discovery?.value || {},
    marketdata: byName.marketdata?.value || {},
    tradeData: byName.tradeData?.value || {},
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

function markFixtureScenario(report = {}, name = 'fixture_scenario') {
  return {
    ...report,
    current: false,
    fixture: true,
    fixtureScenario: name,
    note: 'regression fixture only; do not treat as live operator state',
  };
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

  const transientBusReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: { status: 'luna_discovery_funnel_clear', bottlenecks: [], recommendations: [] },
    blockerPack: {
      status: 'operational_warning',
      hardBlockers: ['agent_message_bus_hygiene:query_failed'],
      evidence: {
        busHygiene: {
          classification: { ok: true, safeExpire: 0, reviewRequired: 2, blocked: 0 },
        },
      },
    },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.equal(transientBusReport.hardBlockers.includes('operational:agent_message_bus_hygiene:query_failed'), false);
  assert.ok(transientBusReport.warnings.includes('operational:agent_message_bus_hygiene_query_failed_unconfirmed'));
  assert.ok(transientBusReport.warnings.includes('operational:agent_message_bus_hygiene_review_required:2'));

  const failedBusReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: { status: 'luna_discovery_funnel_clear', bottlenecks: [], recommendations: [] },
    blockerPack: {
      status: 'operational_blocked',
      hardBlockers: ['agent_message_bus_hygiene:query_failed'],
      evidence: {
        busHygiene: {
          status: 'agent_message_bus_hygiene_failed',
          classification: { ok: false, safeExpire: 0, reviewRequired: 0, blocked: 0 },
        },
      },
    },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.equal(failedBusReport.hardBlockers.includes('operational:agent_message_bus_hygiene:query_failed'), false);
  assert.ok(failedBusReport.warnings.includes('operational:agent_message_bus_hygiene_query_failed_unconfirmed'));
  assert.ok(failedBusReport.safeFixCandidates.some((item) =>
    item.id === 'inspect_agent_bus_hygiene' && item.applyMode === 'read_only'));

  const signalPersistenceReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: {
      status: 'luna_discovery_funnel_attention',
      bottlenecks: ['domestic:actionable_candidate_waiting_signal_persistence'],
      recommendations: ['actionable_candidates_waiting_market_cycle_or_signal_persistence'],
      markets: [
        { market: 'domestic', bottlenecks: ['actionable_candidate_waiting_signal_persistence'] },
      ],
    },
    blockerPack: { status: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.ok(signalPersistenceReport.safeFixCandidates.some((item) =>
    item.id === 'inspect_signal_persistence_gap_domestic'
    && item.applyMode === 'read_only'
    && item.command.includes('--market=domestic')));
  assert.ok(signalPersistenceReport.safeFixCandidates.some((item) =>
    item.id === 'repair_signal_persistence_gap_domestic'
    && item.applyMode === 'codex_patch_required'
    && item.command.includes('--market=domestic')));

  const entryPrefilterReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: {
      status: 'luna_discovery_funnel_attention',
      bottlenecks: [
        'overseas:analysis_completed_no_actionable_signal',
        'overseas:candidates_filtered_before_entry_trigger',
      ],
      recommendations: [],
      markets: [
        { market: 'overseas', bottlenecks: ['analysis_completed_no_actionable_signal', 'candidates_filtered_before_entry_trigger'] },
      ],
    },
    blockerPack: { status: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.ok(entryPrefilterReport.safeFixCandidates.some((item) =>
    item.id === 'inspect_entry_prefilter_block_overseas'
    && item.applyMode === 'read_only'
    && item.command.includes('--market=overseas')));
  assert.ok(entryPrefilterReport.safeFixCandidates.some((item) =>
    item.id === 'inspect_kis_overseas_funnel_trace'
    && item.applyMode === 'read_only'
    && item.command.includes('runtime:kis-overseas-funnel-trace')));
  assert.ok(entryPrefilterReport.safeFixCandidates.some((item) =>
    item.id === 'repair_entry_prefilter_block_overseas'
    && item.applyMode === 'codex_patch_required'
    && item.command.includes('--market=overseas')));

  const technicalRefreshReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: {
      status: 'luna_discovery_funnel_attention',
      bottlenecks: ['crypto:technical_analysis_missing_for_candidates'],
      recommendations: [],
    },
    blockerPack: { status: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.ok(technicalRefreshReport.safeFixCandidates.some((item) =>
    item.id === 'targeted_top_n_enrichment'
    && item.applyMode === 'confirm_required'
    && item.command.includes('luna-active-candidate-analysis-refresh')));

  const preopenRefreshReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: {
      status: 'luna_discovery_funnel_preopen_pending',
      bottlenecks: [],
      preopenGaps: [
        'domestic:preopen_market_flow_analysis_missing_for_candidates',
        'overseas:preopen_market_flow_analysis_missing_for_candidates',
      ],
      recommendations: ['preopen_market_preparation_pending'],
      markets: [
        {
          market: 'domestic',
          preopenReadiness: { pending: ['preopen_market_flow_analysis_missing_for_candidates'] },
          observations: ['preopen_market_flow_analysis_missing_for_candidates'],
        },
        {
          market: 'overseas',
          preopenReadiness: { pending: ['preopen_market_flow_analysis_missing_for_candidates'] },
          observations: ['preopen_market_flow_analysis_missing_for_candidates'],
        },
      ],
    },
    blockerPack: { status: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.ok(preopenRefreshReport.safeFixCandidates.some((item) =>
    item.id === 'preopen_targeted_analysis_refresh_domestic'
    && item.applyMode === 'confirm_required'
    && item.command.includes('--market=domestic')
    && item.command.includes(`--hours=${DEFAULT_HOURS}`)));
  assert.ok(preopenRefreshReport.safeFixCandidates.some((item) =>
    item.id === 'preopen_targeted_analysis_refresh_overseas'
    && item.applyMode === 'confirm_required'
    && item.command.includes('--market=overseas')
    && item.command.includes(`--hours=${DEFAULT_HOURS}`)));
  const cryptoTradeDataPressureReport = buildReportFromEvidence({
    sourceHealth: { ok: true, status: 'source_health_clear', blockers: [] },
    discovery: { status: 'luna_discovery_funnel_clear', bottlenecks: [], recommendations: [] },
    tradeData: {
      status: 'needs_attention',
      warnings: ['trade_analytics_needs_attention'],
      journal: {
        markets: [
          { name: 'crypto', closed: 17, winRate: 0.4118, pnlSum: -13.0543, avgPnlPercent: -0.7679 },
        ],
        strategyFamily: {
          buckets: [
            { name: 'trend_following', closed: 2, winRate: 0, pnlSum: -7.4649, avgPnlPercent: -3.7325 },
            { name: 'mean_reversion', closed: 4, winRate: 0.25, pnlSum: -8.5501, avgPnlPercent: -2.1375 },
          ],
        },
        marketRegime: {
          buckets: [
            { name: 'trending_bull', closed: 9, winRate: 0.2222, pnlSum: -10.8977, avgPnlPercent: -1.2109 },
          ],
        },
      },
    },
    blockerPack: { status: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    postLive: { status: 'post_live_fire_verified', blockers: [] },
  });
  assert.equal(cryptoTradeDataPressureReport.status, 'luna_bottleneck_attention');
  assert.ok(cryptoTradeDataPressureReport.bottlenecks.includes('trade_data:crypto_performance_needs_attention'));
  assert.ok(cryptoTradeDataPressureReport.bottlenecks.includes('trade_data:crypto_trend_following_underperforming'));
  assert.ok(cryptoTradeDataPressureReport.bottlenecks.includes('trade_data:crypto_mean_reversion_underperforming'));
  assert.ok(cryptoTradeDataPressureReport.bottlenecks.includes('trade_data:crypto_trending_bull_loss_pressure'));
  assert.ok(cryptoTradeDataPressureReport.safeFixCandidates.some((item) =>
    item.id === 'inspect_crypto_trade_quality'
    && item.applyMode === 'read_only'));
  assert.ok(cryptoTradeDataPressureReport.safeFixCandidates.some((item) =>
    item.id === 'repair_crypto_selection_quality'
    && item.applyMode === 'codex_patch_required'));
  return {
    ok: true,
    fixtureReport: markFixtureScenario(report, 'hard_blocked_regression'),
    transientBusReport: markFixtureScenario(transientBusReport, 'transient_bus_warning_regression'),
    signalPersistenceReport: markFixtureScenario(signalPersistenceReport, 'signal_persistence_gap_regression'),
    entryPrefilterReport: markFixtureScenario(entryPrefilterReport, 'entry_prefilter_gap_regression'),
    technicalRefreshReport: markFixtureScenario(technicalRefreshReport, 'technical_refresh_gap_regression'),
    cryptoTradeDataPressureReport: markFixtureScenario(cryptoTradeDataPressureReport, 'crypto_trade_data_pressure_regression'),
  };
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
