// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kisClientUrl = pathToFileURL(path.join(__dirname, '../shared/kis-client.ts')).href;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kis-mcp-bridge-routing-'));
const bridgeScript = path.join(tempRoot, 'kis-provider-rate-limit.py');

fs.writeFileSync(
  bridgeScript,
  [
    '#!/usr/bin/env python3',
    'import json',
    'print(json.dumps({"status":"error","message":"KIS API 오류 [EGW00201]: 초당 거래건수를 초과하였습니다."}, ensure_ascii=False))',
    'raise SystemExit(1)',
    '',
  ].join('\n'),
  { mode: 0o700 },
);

const previousEnv = {
  KIS_USE_MCP: process.env.KIS_USE_MCP,
  KIS_MCP_BRIDGE: process.env.KIS_MCP_BRIDGE,
  KIS_MCP_SERVER_PATH: process.env.KIS_MCP_SERVER_PATH,
  KIS_MCP_NON_MUTATING_FAILURE_COOLDOWN_MS: process.env.KIS_MCP_NON_MUTATING_FAILURE_COOLDOWN_MS,
  KIS_APP_KEY: process.env.KIS_APP_KEY,
  KIS_APP_SECRET: process.env.KIS_APP_SECRET,
  IS_OPS: process.env.IS_OPS,
};

try {
  process.env.KIS_USE_MCP = 'true';
  delete process.env.KIS_MCP_BRIDGE;
  process.env.KIS_MCP_SERVER_PATH = bridgeScript;
  process.env.KIS_MCP_NON_MUTATING_FAILURE_COOLDOWN_MS = '12345';
  process.env.KIS_APP_KEY = 'smoke-kis-app-key';
  process.env.KIS_APP_SECRET = 'smoke-kis-app-secret';
  process.env.IS_OPS = '1';

  globalThis.fetch = async () => {
    throw new Error('direct fallback should not run after provider rate limit');
  };

  const kis = await import(`${kisClientUrl}?smoke=${Date.now()}`);

  assert.deepEqual(kis.resolveKisOverseasExchangeCodes('PDD'), {
    symbol: 'PDD',
    priceExcd: 'NAS',
    orderExcd: 'NASD',
  });
  assert.deepEqual(kis.resolveKisOverseasExchangeCodes('QBTS'), {
    symbol: 'QBTS',
    priceExcd: 'NYS',
    orderExcd: 'NYSE',
  });

  let caught = null;
  try {
    await kis.getDomesticQuoteSnapshot('005930', false);
  } catch (error) {
    caught = error;
  }

  assert.equal(caught?.code, 'kis_provider_rate_limited');
  assert.match(caught?.message || '', /direct fallback suppressed/);

  console.log(JSON.stringify({
    ok: true,
    smoke: 'kis-mcp-bridge-routing',
    providerRateLimitFailFast: true,
    mappedSymbolsChecked: ['PDD', 'QBTS'],
  }, null, 2));
} finally {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
