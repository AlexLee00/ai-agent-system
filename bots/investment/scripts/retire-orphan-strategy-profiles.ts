#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
  };
}

function positionKey(row = {}) {
  return `${row.exchange}:${row.symbol}`;
}

export function buildOrphanStrategyProfileCandidates({ activeProfiles = [], livePositions = [] } = {}) {
  const liveKeys = new Set(livePositions.map(positionKey));
  return activeProfiles
    .filter((profile) => !liveKeys.has(positionKey(profile)))
    .map((profile) => ({
      id: profile.id,
      symbol: profile.symbol,
      exchange: profile.exchange,
      tradeMode: profile.trade_mode || 'normal',
      setupType: profile.setup_type || null,
      lifecycleStatus: profile?.strategy_state?.lifecycleStatus || 'unknown',
      updatedAt: profile.updated_at || null,
    }));
}

export async function retireOrphanStrategyProfiles({ apply = false } = {}) {
  await db.initSchema();
  const [livePositions, activeProfiles] = await Promise.all([
    db.getAllPositions(null, false),
    db.getActivePositionStrategyProfiles({ status: 'active', limit: 1000 }),
  ]);
  const candidates = buildOrphanStrategyProfileCandidates({ activeProfiles, livePositions });
  const retired = [];

  if (apply) {
    for (const candidate of candidates) {
      const closed = await db.closePositionStrategyProfile(candidate.symbol, {
        exchange: candidate.exchange,
        tradeMode: candidate.tradeMode,
      }).catch(() => null);
      if (closed) retired.push(candidate);
    }
  }

  return {
    ok: true,
    apply,
    activeProfiles: activeProfiles.length,
    livePositions: livePositions.length,
    candidates: candidates.length,
    retired: retired.length,
    rows: apply ? retired : candidates,
  };
}

async function main() {
  const args = parseArgs();
  const result = await retireOrphanStrategyProfiles({ apply: args.apply });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ retire-orphan-strategy-profiles 오류:',
  });
}
