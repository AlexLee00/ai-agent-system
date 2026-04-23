#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolveManagedPositionUniverse } from '../shared/universe-fallback.ts';

const MARKETS = ['binance', 'kis', 'kis_overseas'];
const MARKET_COMMANDS = {
  binance: {
    run: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run crypto -- --force',
    research: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run crypto -- --force --research-only',
    maintenance: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:maintenance-collect -- --markets=binance --json',
  },
  kis: {
    run: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run domestic -- --force',
    research: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run domestic -- --force --research-only',
    maintenance: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:maintenance-collect -- --markets=kis --json',
  },
  kis_overseas: {
    run: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run overseas -- --force',
    research: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run overseas -- --force --research-only',
    maintenance: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:maintenance-collect -- --markets=kis_overseas --json',
  },
};

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

export function applyCollectionUniverseCompletenessGate({
  quality = null,
  source = 'unknown',
  market = 'unknown',
  screeningUniverseCount = 0,
  maintenanceUniverseCount = 0,
  maintenanceProfiledCount = 0,
} = {}) {
  const current = quality || { status: 'unknown', readinessScore: 0 };
  if (current.status !== 'ready') return current;
  if (source !== 'observed_node_coverage') return current;

  const hasUniverse =
    Number(screeningUniverseCount || 0) > 0
    || Number(maintenanceUniverseCount || 0) > 0
    || Number(maintenanceProfiledCount || 0) > 0;
  if (hasUniverse) return current;

  return {
    ...current,
    status: 'degraded',
    readinessScore: Math.min(Number(current.readinessScore || 0.5), 0.65),
    reasons: [
      ...(Array.isArray(current.reasons) ? current.reasons : []),
      'missing_collection_universe_meta',
    ],
    observed: true,
    universeGate: {
      market,
      screeningUniverseCount: Number(screeningUniverseCount || 0),
      maintenanceUniverseCount: Number(maintenanceUniverseCount || 0),
      maintenanceProfiledCount: Number(maintenanceProfiledCount || 0),
    },
  };
}

export function buildCollectionAuditRemediation({
  market = 'unknown',
  quality = null,
  screeningUniverseCount = 0,
  maintenanceUniverseCount = 0,
  maintenanceProfiledCount = 0,
  collectQualitySource = 'unknown',
} = {}) {
  const status = String(quality?.status || 'unknown');
  const reasons = Array.isArray(quality?.reasons) ? quality.reasons : [];
  const commands = MARKET_COMMANDS[market] || {};
  const missingUniverse =
    reasons.includes('missing_collection_universe_meta')
    || (
      status === 'degraded'
      && Number(screeningUniverseCount || 0) === 0
      && Number(maintenanceUniverseCount || 0) === 0
      && Number(maintenanceProfiledCount || 0) === 0
    );

  if (status === 'ready') {
    return {
      status: 'none',
      reason: 'collection_ready',
      commands: {
        audit: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:collection-audit -- --json',
      },
    };
  }

  if (missingUniverse) {
    return {
      status: 'needs_universe_refresh',
      reason: collectQualitySource === 'observed_node_coverage'
        ? 'node coverage exists but screening/maintenance universe meta is empty'
        : 'screening/maintenance universe meta is empty',
      commands: {
        research: commands.research || null,
        run: commands.run || null,
        maintenance: commands.maintenance || null,
        audit: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:collection-audit -- --json',
      },
    };
  }

  return {
    status: status === 'insufficient' ? 'needs_collect_repair' : 'needs_monitoring',
    reason: reasons.join(', ') || `collection quality ${status}`,
    commands: {
      maintenance: commands.maintenance || null,
      audit: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:collection-audit -- --json',
    },
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
  const screeningUniverseCount = Number(
    collectMetrics.screeningSymbolCount
    || screeningMetrics.screeningSymbolCount
    || 0,
  );
  const maintenanceUniverseCount = Number(
    collectMetrics.maintenanceSymbolCount
    || maintenanceMetrics.maintenanceSymbolCount
    || maintenanceUniverse.managedCount
    || 0,
  );
  const maintenanceProfiledCount = Number(
    collectMetrics.maintenanceProfiledCount
    || maintenanceMetrics.maintenanceProfiledCount
    || maintenanceUniverse.profiledCount
    || 0,
  );
  const effectiveQuality = applyCollectionUniverseCompletenessGate({
    quality: qualityInference.quality,
    source: qualityInference.source,
    market,
    screeningUniverseCount,
    maintenanceUniverseCount,
    maintenanceProfiledCount,
  });

  const audit = {
    market,
    latestSessionId: latestRun?.session_id || null,
    latestStartedAt: latestRun?.started_at ? new Date(Number(latestRun.started_at)).toISOString() : null,
    latestStatus: latestRun?.status || null,
    screeningUniverseCount,
    maintenanceUniverseCount,
    maintenanceProfiledCount,
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
  audit.remediation = buildCollectionAuditRemediation({
    market,
    quality: effectiveQuality,
    screeningUniverseCount: audit.screeningUniverseCount,
    maintenanceUniverseCount: audit.maintenanceUniverseCount,
    maintenanceProfiledCount: audit.maintenanceProfiledCount,
    collectQualitySource: audit.collectQualitySource,
  });

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

  const qualityInsufficient = marketsAudit.filter((item) => item.collectQuality?.status === 'insufficient').length;
  const qualityDegraded = marketsAudit.filter((item) => item.collectQuality?.status === 'degraded').length;
  const qualityReady = marketsAudit.filter((item) => item.collectQuality?.status === 'ready').length;

  return {
    status: qualityInsufficient > 0
      ? 'collection_audit_insufficient'
      : qualityDegraded > 0
        ? 'collection_audit_degraded'
        : 'collection_audit_ready',
    hours,
    markets: marketsAudit,
    summary: {
      markets: normalizedMarkets.length,
      withRecentRuns: marketsAudit.filter((item) => item.latestSessionId).length,
      maintenanceEnabled: marketsAudit.filter((item) => item.stages.maintenanceCollect.implemented).length,
      qualityReady,
      qualityDegraded,
      qualityInsufficient,
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
