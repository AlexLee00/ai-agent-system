#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { checkReflexionBeforeEntry } from '../shared/reflexion-guard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function seedFailureReflexion() {
  const avoidPattern = JSON.stringify({
    symbol_pattern: 'BTC',
    avoid_action: 'LONG',
    reason: 'smoke avoid',
  });
  for (let i = 0; i < 3; i++) {
    await db.run(
      `INSERT INTO investment.luna_failure_reflexions(trade_id, five_why, stage_attribution, hindsight, avoid_pattern)
       VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        880000 + i,
        JSON.stringify([]),
        JSON.stringify({}),
        'smoke hindsight',
        avoidPattern,
      ],
    ).catch(() => {});
  }
}

async function runSmoke() {
  await db.initSchema();
  const old = process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID;

  process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID = 'false';
  const disabled = await checkReflexionBeforeEntry('BTC/USDT', 'binance', 'LONG');
  assert.equal(disabled.blockedByReflexion, false, 'disabled => no block');

  process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID = 'true';
  await seedFailureReflexion();
  const enabled = await checkReflexionBeforeEntry('BTC/USDT', 'binance', 'LONG');
  assert.equal(enabled.blockedByReflexion, true, 'enabled => blocked when repeated failures');
  assert.ok(Number(enabled.confidenceDelta) < 0, 'confidence delta reduced');
  assert.ok((enabled.relevantFailures || []).length >= 1, 'failures linked');

  if (old === undefined) delete process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID;
  else process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID = old;

  return {
    ok: true,
    disabled,
    enabled: {
      blockedByReflexion: enabled.blockedByReflexion,
      confidenceDelta: enabled.confidenceDelta,
      failureCount: enabled.relevantFailures.length,
    },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('reflexion-entry-gate-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ reflexion-entry-gate-smoke 실패:',
  });
}

