#!/usr/bin/env node
// @ts-nocheck

import { searchVault } from '../vault/vault-search.ts';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function collectValues(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.slice(2)
    .filter((arg) => arg.startsWith(prefix))
    .flatMap((arg) => arg.slice(prefix.length).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

export async function runSigmaVaultSearch() {
  const query = argValue('query', '') || '';
  const topK = Math.floor(boundedNumber(argValue('top-k', '5'), 5, 1, 50));
  const sourceKinds = collectValues('source');
  const paraCategory = argValue('para', null);
  const minSimilarityArg = argValue('min-sim', null);
  const minSimilarity = minSimilarityArg == null
    ? undefined
    : boundedNumber(minSimilarityArg, 0, -1, 1);

  const search = await searchVault(query, {
    topK,
    sourceKinds,
    paraCategory: paraCategory || undefined,
    minSimilarity,
  });

  return {
    ...search,
    query,
    filters: {
      topK,
      sourceKinds,
      paraCategory: paraCategory || null,
      minSimilarity: minSimilarity ?? null,
    },
    safety: {
      readOnly: true,
      schema: 'sigma',
      table: 'sigma.vault_entries',
      liveTradeImpact: false,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function main() {
  const result = await runSigmaVaultSearch();
  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (!result.ok) {
    console.log(`[sigma-vault-search] ok=false warning=${result.warning || 'unknown'}`);
  } else {
    console.log(`[sigma-vault-search] ok=true query="${result.query}" results=${result.results.length}`);
    for (const item of result.results) {
      console.log(`- ${item.similarity.toFixed(6)} ${item.source || 'unknown'} ${item.title}`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
