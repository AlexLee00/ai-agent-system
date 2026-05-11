#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildRateLimitedPayload,
  isBinanceRateLimited,
  parseBinanceRetryAt,
} from './runtime-position-parity-report.ts';

const retryAtMs = 1778493295080;
const ccxtError = {
  status: 418,
  message: `binance 418 I'm a teapot {"code":-1003,"msg":"Way too much request weight used; IP banned until ${retryAtMs}. Please use WebSocket Streams for live updates to avoid bans."}`,
};

assert.equal(isBinanceRateLimited(ccxtError), true);
assert.equal(parseBinanceRetryAt(ccxtError), retryAtMs);

const payload = buildRateLimitedPayload({
  guard: {
    retryAt: new Date(retryAtMs).toISOString(),
    retryAtMs,
    message: ccxtError.message,
  },
  cached: {
    cache: { hit: true, stale: true, ageMinutes: 12.5 },
  },
});

assert.equal(payload.ok, false);
assert.equal(payload.status, 'binance_rest_rate_limited');
assert.equal(payload.rateLimit.guarded, true);
assert.equal(payload.rateLimit.retryAtMs, retryAtMs);
assert.equal(payload.cache.stale, true);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: true, smoke: 'runtime-position-parity-cache' }, null, 2));
} else {
  console.log('runtime-position-parity-cache-smoke ok');
}
