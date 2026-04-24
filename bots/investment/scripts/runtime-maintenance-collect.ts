#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { initHubSecrets } from '../shared/secrets.ts';
import { resolveManagedPositionUniverse } from '../shared/universe-fallback.ts';
import { logMarketPipelineMetrics, runMarketCollectPipeline, summarizeNodeStatuses } from '../shared/pipeline-market-runner.ts';
import { processHanulPendingReconcileQueue } from '../team/hanul.ts';

function parseArgs(argv = []) {
  const args = {
    markets: ['binance', 'kis', 'kis_overseas'],
    json: false,
    noAlert: false,
    limit: 0,
    runKisPendingReconcile: true,
    kisPendingReconcileLimit: 40,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--no-alert') args.noAlert = true;
    else if (raw.startsWith('--markets=')) {
      args.markets = raw.split('=').slice(1).join('=').split(',').map((item) => item.trim()).filter(Boolean);
    } else if (raw.startsWith('--limit=')) {
      args.limit = Math.max(0, Number(raw.split('=').slice(1).join('=') || 0));
    } else if (raw === '--no-kis-reconcile') {
      args.runKisPendingReconcile = false;
    } else if (raw.startsWith('--kis-reconcile-limit=')) {
      args.kisPendingReconcileLimit = Math.max(1, Math.min(200, Number(raw.split('=').slice(1).join('=') || 40)));
    }
  }

  return args;
}

async function collectForMarket(market, { limit = 0 } = {}) {
  const resolved = await resolveManagedPositionUniverse(market).catch(() => ({
    symbols: [],
    managedCount: 0,
    profiledCount: 0,
    dustSymbols: [],
    lifecycleCounts: {},
  }));

  const symbols = Array.isArray(resolved.symbols) && limit > 0
    ? resolved.symbols.slice(0, limit)
    : (resolved.symbols || []);

  if (symbols.length === 0) {
    return {
      market,
      skipped: true,
      reason: 'managed positions 없음',
      maintenanceMeta: {
        managedCount: Number(resolved.managedCount || 0),
        profiledCount: Number(resolved.profiledCount || 0),
        dustSkipped: Array.isArray(resolved.dustSymbols) ? resolved.dustSymbols.length : 0,
        lifecycleCounts: resolved.lifecycleCounts || {},
      },
    };
  }

  const collect = await runMarketCollectPipeline({
    market,
    symbols,
    triggerType: 'maintenance',
    meta: {
      market_script: 'runtime_maintenance_collect',
      collect_mode: 'maintenance',
      no_alert: true,
    },
    universeMeta: {
      screeningSymbolCount: 0,
      heldSymbolCount: symbols.length,
      heldAddedCount: symbols.length,
      maintenanceSymbolCount: Number(resolved.managedCount || symbols.length),
      maintenanceProfiledCount: Number(resolved.profiledCount || 0),
      maintenanceDustSkippedCount: Array.isArray(resolved.dustSymbols) ? resolved.dustSymbols.length : 0,
      maintenanceLifecycleCounts: resolved.lifecycleCounts || {},
    },
  });

  return {
    market,
    skipped: false,
    sessionId: collect.sessionId,
    symbolCount: symbols.length,
    summaries: summarizeNodeStatuses(collect.summaries),
    metrics: collect.metrics,
    maintenanceMeta: {
      managedCount: Number(resolved.managedCount || symbols.length),
      profiledCount: Number(resolved.profiledCount || 0),
      dustSkipped: Array.isArray(resolved.dustSymbols) ? resolved.dustSymbols.length : 0,
      lifecycleCounts: resolved.lifecycleCounts || {},
    },
  };
}

export async function runMaintenanceCollect({
  markets = ['binance', 'kis', 'kis_overseas'],
  limit = 0,
  runKisPendingReconcile = true,
  kisPendingReconcileLimit = 40,
} = {}) {
  await initHubSecrets();
  await db.initSchema();

  const normalizedMarkets = (Array.isArray(markets) ? markets : [markets])
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  let kisPendingReconcile = null;
  if (runKisPendingReconcile) {
    kisPendingReconcile = await processHanulPendingReconcileQueue({
      dryRun: false,
      confirmLive: true,
      limit: kisPendingReconcileLimit,
      includePartialFill: true,
      delayMs: 120,
    }).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
      candidates: 0,
      processed: 0,
    }));
  }

  const results = [];
  for (const market of normalizedMarkets) {
    const result = await collectForMarket(market, { limit });
    results.push(result);
    if (!result.skipped && result.metrics) {
      await logMarketPipelineMetrics(`maintenance ${market}`, result.metrics);
    }
  }

  const summary = {
    status: results.some((item) => !item.skipped) ? 'maintenance_collect_ready' : 'maintenance_collect_empty',
    markets: normalizedMarkets,
    activeMarkets: results.filter((item) => !item.skipped).length,
    skippedMarkets: results.filter((item) => item.skipped).length,
    totalManaged: results.reduce((sum, item) => sum + Number(item.maintenanceMeta?.managedCount || 0), 0),
    totalDustSkipped: results.reduce((sum, item) => sum + Number(item.maintenanceMeta?.dustSkipped || 0), 0),
    totalProfiled: results.reduce((sum, item) => sum + Number(item.maintenanceMeta?.profiledCount || 0), 0),
    kisPendingReconcile,
    results,
  };

  return summary;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {
      await initHubSecrets();
      await db.initSchema();
    },
    run: async () => {
      const args = parseArgs(process.argv.slice(2));
      return runMaintenanceCollect(args);
    },
    onSuccess: async (result) => {
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ maintenance collect 오류:',
  });
}
