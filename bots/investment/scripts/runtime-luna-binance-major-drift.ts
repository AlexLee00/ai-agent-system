#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { parseBinanceMajorWhitelist } from '../shared/binance-top-volume-universe.ts';
import { runBinanceMajorUniverseDrift } from '../shared/binance-major-universe-drift.ts';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function runLunaBinanceMajorDrift(options = {}) {
  const current = parseBinanceMajorWhitelist({ env: options.env || process.env });
  if (!current.valid) throw new Error(`major20_current_whitelist_invalid:${current.reason}`);
  return runBinanceMajorUniverseDrift({
    currentSymbols: current.symbols,
    writeSnapshot: options.writeSnapshot !== false,
    notify: options.notify !== false,
    ...options,
  });
}

async function main() {
  const dryRun = hasFlag('dry-run');
  const result = await runLunaBinanceMajorDrift({
    writeSnapshot: !dryRun && !hasFlag('no-write-snapshot'),
    notify: !dryRun && !hasFlag('no-notify'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-binance-major-drift] changes=${result.proposal.hasChanges} additions=${result.proposal.additions.length} removals=${result.proposal.removals.length}`);
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-binance-major-drift error:' });
}
