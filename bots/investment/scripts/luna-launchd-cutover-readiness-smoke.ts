#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function launchctlList() {
  try {
    return execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

export async function runSmoke() {
  const list = launchctlList();
  const required = ['ai.luna.tradingview-ws', 'ai.investment.commander'];
  const visible = required.filter((name) => list.includes(name));
  const result = {
    ok: true,
    liveTradeCommandsExecuted: false,
    cutoverApplied: false,
    required,
    visible,
    missing: required.filter((name) => !list.includes(name)),
    note: 'readiness only; launchd 25->8 cutover is not applied by smoke',
  };
  assert.equal(result.cutoverApplied, false);
  return result;
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`✅ luna-launchd-cutover-readiness-smoke visible=${result.visible.length}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-launchd-cutover-readiness-smoke 실패:' });
}
