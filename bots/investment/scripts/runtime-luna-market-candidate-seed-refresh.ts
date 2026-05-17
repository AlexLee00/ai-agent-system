#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_MARKET_CANDIDATE_SEED_SOURCE,
  buildLunaMarketCandidateSeedPlan,
  fetchLunaMarketCandidateSeedEvents,
  fixtureLunaMarketCandidateSeedEvents,
} from '../shared/luna-market-candidate-seed-refresh.ts';
import {
  ensureCandidateUniverseTable,
  upsertCandidateSignals,
} from '../team/discovery/discovery-store.ts';

export const CONFIRM = 'luna-market-candidate-seed-refresh';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function splitCsv(value: any, fallback = 'domestic,overseas') {
  return String(value || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function applySignals(plan: any = {}, options: any = {}) {
  const ttlHours = Math.max(1, Number(options.ttlHours || 24));
  const results = {};
  await db.initSchema();
  await ensureCandidateUniverseTable();
  for (const market of plan.markets || []) {
    const signals = market.signals || [];
    if (signals.length === 0) {
      results[market.market] = { inserted: 0, updated: 0, skipped: true };
      continue;
    }
    results[market.market] = await upsertCandidateSignals(
      signals,
      market.market,
      LUNA_MARKET_CANDIDATE_SEED_SOURCE,
      2,
      ttlHours,
    );
  }
  return results;
}

export async function runLunaMarketCandidateSeedRefresh(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const confirm = String(options.confirm || '');
  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-market-candidate-seed-refresh cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-market-candidate-seed-refresh apply requires --confirm=${CONFIRM}`);
  }

  const markets = splitCsv(options.markets || options.market);
  const events = options.fixture === true
    ? fixtureLunaMarketCandidateSeedEvents()
    : deps.fetchEvents
      ? await deps.fetchEvents(options)
      : await fetchLunaMarketCandidateSeedEvents({
        hours: Number(options.hours || 24),
        markets,
        eventLimit: Number(options.eventLimit || 500),
      });
  const plan = buildLunaMarketCandidateSeedPlan({
    events,
    markets,
    limit: Number(options.limit || 5),
    minEvents: Number(options.minEvents || 3),
    minUniqueSources: Number(options.minUniqueSources || 1),
  });

  const writeResult = apply && !dryRun
    ? deps.applySignals
      ? await deps.applySignals(plan, options)
      : await applySignals(plan, options)
    : {};

  return {
    ...plan,
    status: apply ? 'market_candidate_seed_written' : 'market_candidate_seed_planned',
    dryRun,
    apply,
    writeMode: apply ? 'shadow-upsert' : 'plan-only',
    sourceTier: 2,
    confirmToken: CONFIRM,
    ttlHours: Math.max(1, Number(options.ttlHours || 24)),
    writeResult,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaMarketCandidateSeedRefresh({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      confirm: argValue('confirm', ''),
      market: argValue('market', argValue('markets', 'domestic,overseas')),
      hours: Number(argValue('hours', 24)),
      limit: Number(argValue('limit', 5)),
      eventLimit: Number(argValue('event-limit', 500)),
      ttlHours: Number(argValue('ttl-hours', 24)),
      minEvents: Number(argValue('min-events', 3)),
      minUniqueSources: Number(argValue('min-unique-sources', 1)),
    }),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`[luna-market-candidate-seed] status=${result.status} planned=${result.summary.plannedSignals} pass=${result.summary.passMarkets}/${result.summary.markets}`);
      }
    },
    errorPrefix: 'runtime-luna-market-candidate-seed-refresh error:',
  });
}
