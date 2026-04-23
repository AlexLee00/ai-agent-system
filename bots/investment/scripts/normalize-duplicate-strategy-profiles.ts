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

export function summarizeDuplicateStrategyProfilePlan(scopes = [], { apply = false, managedScopes = 0 } = {}) {
  return {
    managedScopes: Number(managedScopes || 0),
    duplicateScopes: scopes.length,
    duplicateProfiles: scopes.reduce((sum, scope) => sum + scope.retirements.length, 0),
    keeperScopes: scopes.filter((scope) => scope.keeperProfileId).length,
    retirements: apply ? scopes.reduce((sum, scope) => sum + scope.retirements.length, 0) : 0,
  };
}

export function buildDuplicateStrategyProfileDecision(summary = {}, { apply = false, exchange = null } = {}) {
  const scope = exchange ? `exchange=${exchange}` : 'exchange=all';
  if (!apply && summary.duplicateScopes > 0) {
    return {
      status: 'duplicate_strategy_profiles_candidates',
      headline: `동일 종목 active strategy profile 정규화 후보 ${summary.duplicateScopes}개 scope가 있습니다.`,
      safeToApply: summary.duplicateProfiles > 0,
      actionItems: [
        `범위: ${scope} / managedScopes ${summary.managedScopes || 0} / duplicateProfiles ${summary.duplicateProfiles || 0}`,
        'dry-run rows에서 keeper/retirement 대상을 확인한 뒤 동일 인자로 --apply를 붙여 정규화합니다.',
        '적용 후 runtime:position-strategy-audit와 health-report로 duplicate scope 감소를 재확인합니다.',
      ],
    };
  }
  if (apply && summary.retirements > 0) {
    return {
      status: 'duplicate_strategy_profiles_normalized',
      headline: `중복 active strategy profile ${summary.retirements}건을 정리했습니다.`,
      safeToApply: false,
      actionItems: [
        `범위: ${scope}`,
        '적용 후 runtime:position-strategy-audit로 duplicate managed scope가 0에 가까워졌는지 확인합니다.',
      ],
    };
  }
  return {
    status: 'duplicate_strategy_profiles_clear',
    headline: '현재 관리 중인 포지션 기준 중복 active strategy profile이 없습니다.',
    safeToApply: false,
    actionItems: [
      `범위: ${scope}`,
      '추가 조치 없이 health/feedback 관찰을 유지합니다.',
    ],
  };
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

  const summary = summarizeDuplicateStrategyProfilePlan(scopes, {
    apply,
    managedScopes: managedScopeKeys.size,
  });
  return {
    ok: true,
    apply,
    exchange,
    managedScopes: managedScopeKeys.size,
    duplicateScopes: scopes.length,
    duplicateProfiles: scopes.reduce((sum, scope) => sum + scope.retirements.length, 0),
    retired: retired.length,
    summary: {
      ...summary,
      retirements: apply ? retired.length : 0,
    },
    decision: buildDuplicateStrategyProfileDecision({
      ...summary,
      retirements: apply ? retired.length : 0,
    }, { apply, exchange }),
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
