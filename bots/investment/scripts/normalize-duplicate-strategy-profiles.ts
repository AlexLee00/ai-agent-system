#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildDuplicateActiveProfileScopes } from './runtime-position-strategy-audit.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    exchange: (argv.find((arg) => arg.startsWith('--exchange=')) || '').split('=').slice(1).join('=') || null,
  };
}

export function buildDuplicateStrategyProfileRetirementPlan({ activeProfiles = [], managedScopeKeys = null } = {}) {
  const duplicates = buildDuplicateActiveProfileScopes(activeProfiles);
  return duplicates
    .filter((scope) => !managedScopeKeys || managedScopeKeys.has(scope.key))
    .map((scope) => ({
      key: scope.key,
      exchange: scope.exchange,
      symbol: scope.symbol,
      keeperProfileId: scope.keeperProfileId,
      retirements: scope.duplicateProfileIds.map((profileId) => {
        const profile = activeProfiles.find((row) => row.id === profileId) || null;
        return {
          profileId,
          tradeMode: profile?.trade_mode || 'normal',
          signalId: profile?.signal_id || null,
          setupType: profile?.setup_type || null,
          lifecycleStatus: profile?.strategy_state?.lifecycleStatus || 'unknown',
        };
      }),
    }))
    .filter((scope) => scope.retirements.length > 0);
}

export async function normalizeDuplicateStrategyProfiles({ apply = false, exchange = null } = {}) {
  await db.initSchema();
  const [activeProfiles, livePositions] = await Promise.all([
    db.getActivePositionStrategyProfiles({ exchange, status: 'active', limit: 1000 }),
    db.getAllPositions(exchange, false),
  ]);
  const managedScopeKeys = new Set(
    livePositions.map((position) => `${String(position.exchange || '').trim()}:${String(position.symbol || '').trim()}`),
  );
  const scopes = buildDuplicateStrategyProfileRetirementPlan({ activeProfiles, managedScopeKeys });
  const retired = [];

  if (apply) {
    for (const scope of scopes) {
      for (const item of scope.retirements) {
        const closed = await db.closePositionStrategyProfile(scope.symbol, {
          exchange: scope.exchange,
          tradeMode: item.tradeMode,
          signalId: item.signalId || null,
        }).catch(() => null);
        if (closed) {
          retired.push({
            key: scope.key,
            exchange: scope.exchange,
            symbol: scope.symbol,
            profileId: item.profileId,
            tradeMode: item.tradeMode,
          });
        }
      }
    }
  }

  return {
    ok: true,
    apply,
    exchange,
    managedScopes: managedScopeKeys.size,
    duplicateScopes: scopes.length,
    duplicateProfiles: scopes.reduce((sum, scope) => sum + scope.retirements.length, 0),
    retired: retired.length,
    scopes,
    rows: apply ? retired : scopes,
  };
}

async function main() {
  const args = parseArgs();
  const result = await normalizeDuplicateStrategyProfiles({
    apply: args.apply,
    exchange: args.exchange,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ normalize-duplicate-strategy-profiles 오류:',
  });
}
