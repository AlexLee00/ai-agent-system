#!/usr/bin/env node
// @ts-nocheck

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getMarketRegime } from '../shared/market-regime.ts';
import { loadLatestScoutIntel, getScoutSignalForSymbol } from '../shared/scout-intel.ts';

const OUTPUT_PATH = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/market-regime-capture.json';

function parseArgs(argv = process.argv.slice(2)) {
  const marketArg = argv.find((arg) => arg.startsWith('--markets='));
  const markets = marketArg
    ? marketArg.split('=')[1].split(',').map((item) => item.trim()).filter(Boolean)
    : ['binance', 'kis', 'kis_overseas'];
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    markets,
  };
}

function normalizeRegimeMarket(exchange = '') {
  const value = String(exchange || '').toLowerCase();
  if (value === 'binance' || value === 'crypto') return 'crypto';
  if (value === 'kis' || value === 'domestic') return 'domestic';
  if (value === 'kis_overseas' || value === 'overseas') return 'overseas';
  return value || 'unknown';
}

function scoutPayloadForMarket(market, intel) {
  if (market !== 'binance' || !intel) return {};
  const scoutSignal = getScoutSignalForSymbol(intel, 'BTC/USDT');
  if (!scoutSignal) return {};
  return {
    scout: {
      source: scoutSignal.source,
      score: scoutSignal.score,
      aiSignal: scoutSignal.evidence || scoutSignal.label,
    },
  };
}

async function captureMarketRegimes({ dryRun = false, markets = [] } = {}) {
  await db.initSchema();

  const scoutIntel = await loadLatestScoutIntel({ minutes: 24 * 60 }).catch(() => null);
  const rows = [];

  for (const market of markets) {
    const regime = await getMarketRegime(market, scoutPayloadForMarket(market, scoutIntel));
    const row = {
      market,
      normalizedMarket: normalizeRegimeMarket(market),
      regime: regime.regime,
      confidence: regime.confidence,
      reason: regime.reason,
      summary: regime.summary,
      bias: regime.bias,
      tradingStyle: regime.guide?.tradingStyle || null,
      timeframe: regime.guide?.timeframe || null,
      evidence: (regime.snapshots || []).map((item) => ({
        label: item.label,
        symbol: item.symbol,
        source: item.source,
        last: item.last,
        dayChangePct: item.dayChangePct,
        trendPct: item.trendPct,
        fallbackSymbol: item.fallbackSymbol || null,
        fallbackError: item.fallbackError || null,
        error: item.error || null,
      })),
      capturedAt: new Date().toISOString(),
    };

    if (!dryRun) {
      await db.insertMarketRegimeSnapshot({
        market: row.normalizedMarket,
        regime: row.regime,
        confidence: row.confidence,
        indicators: {
          exchange: market,
          reason: row.reason,
          summary: row.summary,
          evidence: row.evidence,
          bias: row.bias,
          guide: regime.guide || null,
        },
      });
    }
    rows.push(row);
  }

  const payload = {
    ok: true,
    checkedAt: new Date().toISOString(),
    dryRun,
    markets,
    rows,
  };

  if (!dryRun) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  }

  return payload;
}

async function main() {
  const args = parseArgs();
  const result = await captureMarketRegimes(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const row of result.rows) {
    console.log(`${row.market} -> ${row.regime} (${row.reason})`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ market regime capture 오류:',
  });
}
