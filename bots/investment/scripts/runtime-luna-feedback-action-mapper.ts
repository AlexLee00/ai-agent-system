#!/usr/bin/env node
// @ts-nocheck

import { runFeedbackActionMapper } from '../shared/feedback-action-mapper.ts';
import fs from 'node:fs';
import path from 'node:path';

const STATE_PATH = new URL('../output/ops/luna-feedback-action-mapper-state.json', import.meta.url).pathname;

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const json = process.argv.includes('--json');
  const write = process.argv.includes('--write');
  const noDryRun = process.argv.includes('--no-dry-run');
  const result = await runFeedbackActionMapper({
    market: argValue('market', 'all') || 'all',
    days: Math.max(1, Number(argValue('days', '30')) || 30),
    limit: Math.max(1, Number(argValue('limit', '50')) || 50),
    dryRun: !noDryRun,
    write,
  });
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    ...result,
    stateWrittenAt: new Date().toISOString(),
  }, null, 2));
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-feedback-action-mapper] mapped=${result.mapped} dryRun=${result.dryRun}`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
