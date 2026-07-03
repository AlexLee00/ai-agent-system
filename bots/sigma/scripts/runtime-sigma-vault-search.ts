#!/usr/bin/env node
// @ts-nocheck

import { searchVault } from '../vault/vault-search.ts';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string | null = null): string | null {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  if (found) return found.slice(prefix.length);

  const flagIndex = args.indexOf(`--${name}`);
  if (flagIndex >= 0) {
    const value = args[flagIndex + 1];
    if (value && !value.startsWith('--')) return value;
  }
  return fallback;
}

function collectValues(name: string): string[] {
  const values: string[] = [];
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
      continue;
    }
    if (arg === `--${name}`) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) values.push(next);
      i += 1;
    }
  }
  return values
    .flatMap((item) => item.split(','))
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
  const layerSearchEnabled = hasFlag('layer') || process.env.SIGMA_LAYER_SEARCH_ENABLED === 'true';
  const intent = argValue('intent', null);

  const search = await searchVault(query, {
    topK,
    sourceKinds,
    paraCategory: paraCategory || undefined,
    minSimilarity,
    layerSearchEnabled,
    intent: intent || undefined,
    includeRoutingDebug: hasFlag('routing-debug') || layerSearchEnabled,
  });

  return {
    ...search,
    query,
    filters: {
      topK,
      sourceKinds,
      paraCategory: paraCategory || null,
      minSimilarity: minSimilarity ?? null,
      layerSearchEnabled,
      intent: intent || null,
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
