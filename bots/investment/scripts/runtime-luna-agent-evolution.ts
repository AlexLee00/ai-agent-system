#!/usr/bin/env node
// @ts-nocheck

import { runLunaAgentEvolution } from '../shared/luna-agent-evolution.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const json = process.argv.includes('--json');
  if (maybeSkipForMemory('luna.agent-evolution', { json })) return;
  const write = process.argv.includes('--write');
  const noDryRun = process.argv.includes('--no-dry-run');
  const result = await runLunaAgentEvolution({
    market: argValue('market', 'all') || 'all',
    lookbackDays: Math.max(1, Number(argValue('lookback-days', '14')) || 14),
    dryRun: !noDryRun,
    write,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-agent-evolution] ${result.evolutionSummary}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
