#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const execFileAsync = promisify(execFile);

function parseJsonFromStdout(stdout = '') {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // continue
      }
    }
  }
  return null;
}

async function runBridgeAction(action, payload = {}) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const investmentRoot = path.resolve(scriptDir, '..');
  const { stdout } = await execFileAsync(
    'python3',
    [
      'scripts/binance-market-mcp-server.py',
      '--bridge-action',
      String(action || ''),
      '--payload-json',
      JSON.stringify(payload || {}),
      '--json',
    ],
    {
      cwd: investmentRoot,
      env: {
        ...process.env,
        BINANCE_MCP_SMOKE_CAPTURE: '1',
        NODE_ENV: 'test',
      },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const parsed = parseJsonFromStdout(stdout);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`bridge_action_parse_failed:${action}`);
  }
  return parsed;
}

export async function runBinanceMcpClientOrderIdSmoke() {
  const buyCid = `smoke_buy_${Date.now()}`;
  const sellCid = `smoke_sell_${Date.now()}`;

  const buyResult = await runBridgeAction('market_buy', {
    symbol: 'BTC/USDT',
    amountUsdt: 12.34,
    clientOrderId: buyCid,
  });
  assert.equal(String(buyResult?.status || ''), 'ok');
  assert.equal(String(buyResult?.action || ''), 'market_buy');
  assert.equal(String(buyResult?.clientOrderId || ''), buyCid);
  assert.equal(String(buyResult?.order?.clientOrderId || ''), buyCid);

  const sellResult = await runBridgeAction('market_sell', {
    symbol: 'BTC/USDT',
    amount: 0.123,
    clientOrderId: sellCid,
  });
  assert.equal(String(sellResult?.status || ''), 'ok');
  assert.equal(String(sellResult?.action || ''), 'market_sell');
  assert.equal(String(sellResult?.clientOrderId || ''), sellCid);
  assert.equal(String(sellResult?.order?.clientOrderId || ''), sellCid);

  return {
    ok: true,
    marketBuyClientOrderId: buyResult?.order?.clientOrderId || null,
    marketSellClientOrderId: sellResult?.order?.clientOrderId || null,
  };
}

async function main() {
  const result = await runBinanceMcpClientOrderIdSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('runtime binance mcp clientOrderId smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime binance mcp clientOrderId smoke 실패:',
  });
}
