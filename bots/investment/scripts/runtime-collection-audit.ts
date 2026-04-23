#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveManagedPositionUniverse } from '../shared/universe-fallback.ts';

const MARKETS = ['binance', 'kis', 'kis_overseas'];

function parseArgs(argv = []) {
  const args = {
    markets: MARKETS,
    hours: 24,
    json: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--markets=')) {
      args.markets = raw.split('=').slice(1).join('=').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (raw.startsWith('--hours=')) {
      args.hours = Math.max(1, Number(raw.split('=').slice(1).join('=') || 24));
    }
  }

  return args;
}

function hasCollectNode(market, nodeId) {
  if (market === 'binance') return ['L06', 'L02', 'L03', 'L05'].includes(nodeId);
  if (market === 'kis' || market === 'kis_overseas') return ['L06', 'L02', 'L03', 'L04'].includes(nodeId);
  return false;
}

async function loadLatestRun(market, hours = 24) {
  const rows = await db.query(`
    SELECT session_id, status, started_at, finished_at, duration_ms, meta
      FROM pipeline_runs
     WHERE market = ?
       AND started_at >= ?
     ORDER BY started_at DESC
     LIMIT 1
  `, [market, Date.now() - (hours * 3600 * 1000)]);
  return rows[0] || null;
}

async function loadLatestModeRun(market, collectMode, hours = 24) {
  const rows = await db.query(`
    SELECT session_id, status, started_at, finished_at, duration_ms, meta
      FROM pipeline_runs
     WHERE market = ?
       AND started_at >= ?
     ORDER BY started_at DESC
  `, [market, Date.now() - (hours * 3600 * 1000)]);

  return rows.find((row) => String(row?.meta?.collect_mode || '') === String(collectMode)) || null;
}

async function loadNodeCoverage(sessionId, market) {
  if (!sessionId) return { nodeIds: [], counts: {}, total: 0 };
  const rows = await db.query(`
    SELECT node_id, COUNT(*)::int AS count
      FROM pipeline_node_runs
     WHERE session_id = ?
     GROUP BY node_id
  `, [sessionId]);
  const filtered = rows.filter((row) => hasCollectNode(market, row.node_id));
  return {
    nodeIds: filtered.map((row) => row.node_id),
    counts: Object.fromEntries(filtered.map((row) => [row.node_id, Number(row.count || 0)])),
    total: filtered.reduce((sum, row) => sum + Number(row.count || 0), 0),
  };
}

function stageStatus(value, details = null) {
  return { implemented: Boolean(value), details };
}

export function inferObservedCollectQuality({ explicitQuality = null, nodeCoverage = {}, market = 'unknown' } = {}) {
  if (explicitQuality && explicitQuality.status) {
    return {
      quality: explicitQuality,
      source: 'explicit_meta',
    };
  }

  const nodeIds = new Set(Array.isArray(nodeCoverage?.nodeIds) ? nodeCoverage.nodeIds : []);
  const hasGateway = nodeIds.has('L06');
  const hasCore = nodeIds.has('L02') && nodeIds.has('L03');
  const hasMarketEnrichment = market === 'binance' ? nodeIds.has('L05') : nodeIds.has('L04');
  const hasMeaningfulCoverage = Number(nodeCoverage?.total || 0) > 0 && hasGateway && hasCore;

  if (hasMeaningfulCoverage) {
    return {
      quality: {
        status: 'ready',
        reasons: ['observed_node_coverage_without_quality_meta'],
        collectMode: hasMarketEnrichment ? 'observed_screening' : 'observed_core',
        readinessScore: hasMarketEnrichment ? 0.95 : 0.85,
        observed: true,
      },
      source: 'observed_node_coverage',
    };
  }

  return {
    quality: { status: 'unknown', readinessScore: 0 },
    source: 'missing_meta',
  };
}

async function auditMarket(market, hours = 24) {
  const [latestRun, latestScreeningRun, latestMaintenanceRun, maintenanceUniverse] = await Promise.all([
    loadLatestRun(market, hours),
    loadLatestModeRun(market, 'screening', hours),
    loadLatestModeRun(market, 'maintenance', hours),
    resolveManagedPositionUniverse(market).catch(() => ({
      symbols: [],
      managedCount: 0,
      profiledCount: 0,
      dustSymbols: [],
      lifecycleCounts: {},
    })),
  ]);

  const nodeCoverage = await loadNodeCoverage(latestRun?.session_id || null, market);
  const screeningNodeCoverage = await loadNodeCoverage(latestScreeningRun?.session_id || null, market);
  const maintenanceNodeCoverage = await loadNodeCoverage(latestMaintenanceRun?.session_id || null, market);
  const meta = latestRun?.meta || {};
  const collectMetrics = meta.collect_metrics || {};
  const collectQuality = meta.collect_quality || collectMetrics.collectQuality || null;
  const collectWarnings = Array.isArray(meta.collect_warnings) ? meta.collect_warnings : [];
  const screeningMetrics = latestScreeningRun?.meta?.collect_metrics || {};
  const maintenanceMetrics = latestMaintenanceRun?.meta?.collect_metrics || {};
  const explicitQuality =
    collectQuality
    || latestMaintenanceRun?.meta?.collect_quality
    || latestMaintenanceRun?.meta?.collect_metrics?.collectQuality
    || latestScreeningRun?.meta?.collect_quality
    || latestScreeningRun?.meta?.collect_metrics?.collectQuality
    || null;
  const qualityInference = inferObservedCollectQuality({
    explicitQuality,
    nodeCoverage,
    market,
  });
  const effectiveQuality = qualityInference.quality;

  const audit = {
    market,
    latestSessionId: latestRun?.session_id || null,
    latestStartedAt: latestRun?.started_at ? new Date(Number(latestRun.started_at)).toISOString() : null,
    latestStatus: latestRun?.status || null,
    screeningUniverseCount: Number(
      collectMetrics.screeningSymbolCount
      || screeningMetrics.screeningSymbolCount
      || 0,
    ),
    maintenanceUniverseCount: Number(
      collectMetrics.maintenanceSymbolCount
      || maintenanceMetrics.maintenanceSymbolCount
      || maintenanceUniverse.managedCount
      || 0,
    ),
    maintenanceProfiledCount: Number(
      collectMetrics.maintenanceProfiledCount
      || maintenanceMetrics.maintenanceProfiledCount
      || maintenanceUniverse.profiledCount
      || 0,
    ),
    dustSkippedCount: Number(
      collectMetrics.maintenanceDustSkippedCount
      || maintenanceMetrics.maintenanceDustSkippedCount
      || (maintenanceUniverse.dustSymbols || []).length
      || 0,
    ),
    collectQuality: effectiveQuality,
    collectQualitySource: qualityInference.source,
    collectWarnings,
    nodeCoverage,
    screeningSessionId: latestScreeningRun?.session_id || null,
    maintenanceSessionId: latestMaintenanceRun?.session_id || null,
    stages: {
      cycleGate: stageStatus(Boolean(latestRun), latestRun ? 'market runner active' : 'recent pipeline run 없음'),
      universeBuild: stageStatus(
        Boolean(
          Number(screeningMetrics.symbolCount || collectMetrics.symbolCount || 0) > 0
          || Number(maintenanceMetrics.maintenanceSymbolCount || collectMetrics.maintenanceSymbolCount || 0) > 0
          || maintenanceUniverse.managedCount > 0,
        ),
        {
          screening: Number(screeningMetrics.screeningSymbolCount || collectMetrics.screeningSymbolCount || 0),
          maintenance: Number(maintenanceMetrics.maintenanceSymbolCount || collectMetrics.maintenanceSymbolCount || maintenanceUniverse.managedCount || 0),
        },
      ),
      screeningCollect: stageStatus(
        Boolean(latestScreeningRun?.session_id && screeningNodeCoverage.total > 0),
        { nodeIds: screeningNodeCoverage.nodeIds, sessionId: latestScreeningRun?.session_id || null },
      ),
      maintenanceCollect: stageStatus(
        Boolean(
          Number(maintenanceMetrics.maintenanceSymbolCount || collectMetrics.maintenanceSymbolCount || maintenanceUniverse.managedCount || 0) > 0
          || latestMaintenanceRun?.session_id,
        ),
        {
          sessionId: latestMaintenanceRun?.session_id || null,
          managed: Number(maintenanceMetrics.maintenanceSymbolCount || collectMetrics.maintenanceSymbolCount || maintenanceUniverse.managedCount || 0),
          profiled: Number(maintenanceMetrics.maintenanceProfiledCount || collectMetrics.maintenanceProfiledCount || maintenanceUniverse.profiledCount || 0),
          dustSkipped: Number(maintenanceMetrics.maintenanceDustSkippedCount || collectMetrics.maintenanceDustSkippedCount || (maintenanceUniverse.dustSymbols || []).length || 0),
          lifecycleCounts: maintenanceMetrics.maintenanceLifecycleCounts || collectMetrics.maintenanceLifecycleCounts || maintenanceUniverse.lifecycleCounts || {},
        },
      ),
      marketIntelligenceNormalize: stageStatus(
        Boolean(effectiveQuality && effectiveQuality.status && effectiveQuality.status !== 'unknown'),
        { quality: effectiveQuality?.status || 'unknown' },
      ),
      collectQualityGate: stageStatus(
        Boolean(effectiveQuality && effectiveQuality.status),
        effectiveQuality || null,
      ),
      decisionHandoff: stageStatus(
        Boolean(
          qualityInference.source === 'observed_node_coverage'
          ||
          latestScreeningRun?.meta?.collect_quality
          || latestScreeningRun?.meta?.collect_metrics?.collectQuality
          || latestMaintenanceRun?.meta?.collect_quality
          || latestMaintenanceRun?.meta?.collect_metrics?.collectQuality
          || latestRun?.meta?.collect_quality
          || latestRun?.meta?.collect_metrics?.collectQuality,
        ),
        (
          qualityInference.source === 'observed_node_coverage'
          ||
          latestScreeningRun?.meta?.collect_quality
          || latestScreeningRun?.meta?.collect_metrics?.collectQuality
          || latestMaintenanceRun?.meta?.collect_quality
          || latestMaintenanceRun?.meta?.collect_metrics?.collectQuality
          || latestRun?.meta?.collect_quality
          || latestRun?.meta?.collect_metrics?.collectQuality
        ) ? (qualityInference.source === 'observed_node_coverage' ? 'observed node coverage fallback' : 'pipeline meta persisted') : 'collect meta 없음',
      ),
    },
  };

  return audit;
}

export async function runCollectionAudit({ markets = MARKETS, hours = 24 } = {}) {
  await db.initSchema();
  const normalizedMarkets = (Array.isArray(markets) ? markets : [markets])
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const marketsAudit = [];
  for (const market of normalizedMarkets) {
    marketsAudit.push(await auditMarket(market, hours));
  }

  return {
    status: 'collection_audit_ready',
    hours,
    markets: marketsAudit,
    summary: {
      markets: normalizedMarkets.length,
      withRecentRuns: marketsAudit.filter((item) => item.latestSessionId).length,
      maintenanceEnabled: marketsAudit.filter((item) => item.stages.maintenanceCollect.implemented).length,
      qualityReady: marketsAudit.filter((item) => item.collectQuality?.status === 'ready').length,
      qualityDegraded: marketsAudit.filter((item) => item.collectQuality?.status === 'degraded').length,
      qualityInsufficient: marketsAudit.filter((item) => item.collectQuality?.status === 'insufficient').length,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: async () => {
      const args = parseArgs(process.argv.slice(2));
      return runCollectionAudit(args);
    },
    onSuccess: async (result) => {
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ collection audit 오류:',
  });
}
