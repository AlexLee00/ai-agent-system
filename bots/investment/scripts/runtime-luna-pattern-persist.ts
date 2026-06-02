#!/usr/bin/env node
// @ts-nocheck
// loss/win 패턴만 persist. curriculum(agent_curriculum_state)은 건드리지 않음.

import { extractLossPatterns } from '../shared/loss-pattern-extractor.ts';
import { extractWinPatterns } from '../shared/win-pattern-extractor.ts';
import { maybeSkipForMemory } from '../shared/memory-pressure-guard.ts';

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function main() {
  const json = process.argv.includes('--json');
  if (maybeSkipForMemory('luna.pattern-persist', { json })) return;
  const write = process.argv.includes('--write');
  const noDryRun = process.argv.includes('--no-dry-run');
  const effectiveDryRun = !noDryRun || !write;
  const market = argValue('market', 'all') || 'all';
  const lookbackDays = Math.max(1, Number(argValue('lookback-days', '30')) || 30);

  const [lossPatterns, winPatterns] = await Promise.all([
    extractLossPatterns({ market, lookbackDays, minTradeCount: 2, persist: !effectiveDryRun }),
    extractWinPatterns({ market, lookbackDays, minTradeCount: 2, persist: !effectiveDryRun }),
  ]);

  const result = {
    ok: true,
    dryRun: effectiveDryRun,
    lossPatterns: lossPatterns.length,
    winPatterns: winPatterns.length,
    persisted: !effectiveDryRun,
    curriculumTouched: false,
    executedAt: new Date().toISOString(),
  };

  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-pattern-persist] loss=${lossPatterns.length} win=${winPatterns.length} dryRun=${effectiveDryRun} persisted=${!effectiveDryRun}`);
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
