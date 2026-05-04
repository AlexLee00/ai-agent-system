#!/usr/bin/env node
// @ts-nocheck

import { runDiscoveryOrchestrator } from '../team/discovery/discovery-orchestrator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const VALID_MARKETS = new Set(['crypto', 'domestic', 'overseas']);

function hasArg(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseMarkets(value = 'crypto,domestic,overseas') {
  const markets = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const invalid = markets.filter((item) => !VALID_MARKETS.has(item));
  if (invalid.length) {
    throw new Error(`invalid_markets:${invalid.join(',')}`);
  }
  return markets.length ? markets : ['crypto', 'domestic', 'overseas'];
}

function summarizeMerged(merged = {}) {
  return Object.fromEntries(
    ['crypto', 'domestic', 'overseas'].map((market) => [
      market,
      {
        count: Number(merged?.[market]?.length || 0),
        top: (merged?.[market] || []).slice(0, 5).map((item) => ({
          symbol: item.symbol,
          score: item.score,
          source: item.source || item.source_id || null,
        })),
      },
    ]),
  );
}

export async function runDiscoveryOrchestratorRefresh({
  markets = ['crypto', 'domestic', 'overseas'],
  dryRun = false,
  skipDbWrite = false,
  limit = 100,
  timeoutMs = 8000,
  ttlHours = 24,
  force = false,
} = {}) {
  const previousEnabled = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  if (force) process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = 'true';
  try {
    const result = await runDiscoveryOrchestrator({
      markets,
      dryRun,
      skipDbWrite,
      limit,
      timeoutMs,
      ttlHours,
      failClosedOnDbError: !dryRun && !skipDbWrite,
    });
    const disabled = result.stats?.totalAdapters === 0 && !dryRun && !force;
    const emptyMarkets = markets.filter((market) => Number(result.merged?.[market]?.length || 0) === 0);
    return {
      ok: !disabled && Number(result.stats?.errorCount || 0) === 0 && emptyMarkets.length === 0,
      status: disabled
        ? 'discovery_orchestrator_disabled'
        : emptyMarkets.length
          ? 'discovery_orchestrator_empty_market'
          : 'discovery_orchestrator_refreshed',
      generatedAt: new Date().toISOString(),
      dryRun,
      skipDbWrite,
      markets,
      ttlHours,
      limit,
      timeoutMs,
      stats: result.stats,
      merged: summarizeMerged(result.merged),
      emptyMarkets,
      errors: result.errors || [],
    };
  } finally {
    if (force) {
      if (previousEnabled == null) delete process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
      else process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = previousEnabled;
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const report = await runDiscoveryOrchestratorRefresh({
    markets: parseMarkets(argValue('markets', 'crypto,domestic,overseas', argv)),
    dryRun: hasArg('dry-run', argv),
    skipDbWrite: hasArg('skip-db-write', argv),
    limit: Math.max(1, Number(argValue('limit', 100, argv)) || 100),
    timeoutMs: Math.max(1000, Number(argValue('timeout-ms', 8000, argv)) || 8000),
    ttlHours: Math.max(1, Number(argValue('ttl-hours', 24, argv)) || 24),
    force: hasArg('force', argv),
  });
  if (hasArg('json', argv)) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`runtime-discovery-orchestrator-refresh ${report.status}`);
    for (const market of report.markets || []) {
      console.log(`${market}: ${report.merged?.[market]?.count || 0} candidates`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-discovery-orchestrator-refresh 실패:',
  });
}
