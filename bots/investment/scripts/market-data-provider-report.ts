#!/usr/bin/env node
// @ts-nocheck

import { execFile } from 'child_process';
import { promisify } from 'util';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getOHLCV } from '../shared/ohlcv-fetcher.ts';

const execFileAsync = promisify(execFile);
const TRADINGVIEW_MCP_SCRIPT = new URL('./tradingview-mcp-server.py', import.meta.url);

function parseArgs(argv = []) {
  const args = {
    symbol: 'BTC/USDT',
    yahooSymbol: 'BTC-USD',
    timeframe: '1h',
    from: '2026-04-10',
    to: '2026-04-15',
    json: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || args.symbol;
    else if (raw.startsWith('--yahoo-symbol=')) args.yahooSymbol = raw.split('=').slice(1).join('=') || args.yahooSymbol;
    else if (raw.startsWith('--timeframe=')) args.timeframe = raw.split('=').slice(1).join('=') || args.timeframe;
    else if (raw.startsWith('--from=')) args.from = raw.split('=').slice(1).join('=') || args.from;
    else if (raw.startsWith('--to=')) args.to = raw.split('=').slice(1).join('=') || args.to;
  }

  return args;
}

async function runTradingViewScript(args = []) {
  const { stdout } = await execFileAsync('python3', [
    TRADINGVIEW_MCP_SCRIPT.pathname,
    ...args,
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  return JSON.parse(String(stdout || '{}'));
}

function renderText(payload) {
  const lines = [
    '📡 Market Data Provider Report',
    `symbol: ${payload.args.symbol}`,
    `timeframe: ${payload.args.timeframe}`,
    `range: ${payload.args.from} -> ${payload.args.to}`,
    '',
    `Yahoo quote: ${payload.yahooQuote.status}`,
    payload.yahooQuote.close != null ? `- close: ${payload.yahooQuote.close}` : null,
    payload.yahooQuote.timestamp ? `- timestamp: ${payload.yahooQuote.timestamp}` : null,
    payload.yahooQuote.error ? `- error: ${payload.yahooQuote.error}` : null,
    '',
    `Yahoo OHLCV: ${payload.yahooOhlcv.status}`,
    payload.yahooOhlcv.count != null ? `- count: ${payload.yahooOhlcv.count}` : null,
    payload.yahooOhlcv.first ? `- firstTs: ${payload.yahooOhlcv.first[0]}` : null,
    payload.yahooOhlcv.last ? `- lastTs: ${payload.yahooOhlcv.last[0]}` : null,
    payload.yahooOhlcv.error ? `- error: ${payload.yahooOhlcv.error}` : null,
    '',
    `Fetcher: ${payload.fetcher.status}`,
    payload.fetcher.count != null ? `- count: ${payload.fetcher.count}` : null,
    payload.fetcher.first ? `- firstTs: ${payload.fetcher.first[0]}` : null,
    payload.fetcher.last ? `- lastTs: ${payload.fetcher.last[0]}` : null,
    payload.fetcher.error ? `- error: ${payload.fetcher.error}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

export async function buildMarketDataProviderReport(args = {}) {
  const yahooQuote = { status: 'error', error: null, close: null, timestamp: null };
  const yahooOhlcv = { status: 'error', error: null, count: 0, first: null, last: null };
  const fetcher = { status: 'error', error: null, count: 0, first: null, last: null };

  try {
    const result = await runTradingViewScript(['--test', '--json', `--symbol=${args.yahooSymbol}`]);
    yahooQuote.status = String(result?.status || 'unknown');
    yahooQuote.close = result?.quote?.close ?? null;
    yahooQuote.timestamp = result?.quote?.timestamp ?? null;
  } catch (error) {
    yahooQuote.error = String(error?.message || error);
  }

  try {
    const result = await runTradingViewScript([
      '--ohlcv',
      '--json',
      `--symbol=${args.yahooSymbol}`,
      `--interval=${args.timeframe}`,
      `--from-date=${args.from}`,
      `--to-date=${args.to}`,
    ]);
    yahooOhlcv.status = String(result?.status || 'unknown');
    yahooOhlcv.count = Number(result?.count || 0);
    yahooOhlcv.first = result?.rows?.[0] || null;
    yahooOhlcv.last = result?.rows?.[result?.rows?.length - 1] || null;
  } catch (error) {
    yahooOhlcv.error = String(error?.message || error);
  }

  try {
    const rows = await getOHLCV(args.symbol, args.timeframe, args.from, args.to);
    fetcher.status = 'ok';
    fetcher.count = rows.length;
    fetcher.first = rows[0] || null;
    fetcher.last = rows[rows.length - 1] || null;
  } catch (error) {
    fetcher.error = String(error?.message || error);
  }

  const payload = {
    ok: true,
    args,
    yahooQuote,
    yahooOhlcv,
    fetcher,
  };

  if (args.json) return payload;
  return renderText(payload);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = parseArgs(process.argv.slice(2));
      return buildMarketDataProviderReport(args);
    },
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ market-data-provider-report 오류:',
  });
}
