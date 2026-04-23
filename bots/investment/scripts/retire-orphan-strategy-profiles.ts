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

export function summarizeOrphanStrategyProfiles(candidates = [], {
  apply = false,
  activeProfiles = 0,
  livePositions = 0,
} = {}) {
  return {
    activeProfiles: Number(activeProfiles || 0),
    livePositions: Number(livePositions || 0),
    orphanProfiles: candidates.length,
    orphanExchanges: [...new Set(candidates.map((row) => row.exchange).filter(Boolean))].length,
    orphanSymbols: [...new Set(candidates.map((row) => `${row.exchange}:${row.symbol}`).filter(Boolean))].length,
    retirements: apply ? candidates.length : 0,
  };
}

export function buildOrphanStrategyProfileDecision(summary = {}, { apply = false } = {}) {
  if (!apply && summary.orphanProfiles > 0) {
    return {
      status: 'orphan_strategy_profiles_candidates',
      headline: `live 포지션이 없는 active strategy profile ${summary.orphanProfiles}건이 있습니다.`,
      safeToApply: summary.orphanProfiles > 0,
      actionItems: [
        `activeProfiles ${summary.activeProfiles || 0} / livePositions ${summary.livePositions || 0} / orphanSymbols ${summary.orphanSymbols || 0}`,
        'dry-run rows를 확인한 뒤 --apply로 orphan active profile을 정리합니다.',
        '적용 후 runtime:position-strategy-audit와 health-report에서 orphan profile 감소를 재확인합니다.',
      ],
    };
  }
  if (apply && summary.retirements > 0) {
    return {
      status: 'orphan_strategy_profiles_retired',
      headline: `orphan strategy profile ${summary.retirements}건을 정리했습니다.`,
      safeToApply: false,
      actionItems: [
        '적용 후 runtime:position-strategy-audit로 orphan profile이 줄었는지 확인합니다.',
      ],
    };
  }
  return {
    status: 'orphan_strategy_profiles_clear',
    headline: '현재 orphan active strategy profile이 없습니다.',
    safeToApply: false,
    actionItems: [
      '추가 조치 없이 health/feedback 관찰을 유지합니다.',
    ],
  };
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

  const summary = summarizeOrphanStrategyProfiles(candidates, {
    apply,
    activeProfiles: activeProfiles.length,
    livePositions: livePositions.length,
  });

  return {
    ok: true,
    apply,
    activeProfiles: activeProfiles.length,
    livePositions: livePositions.length,
    candidates: candidates.length,
    retired: retired.length,
    summary: {
      ...summary,
      retirements: apply ? retired.length : 0,
    },
    decision: buildOrphanStrategyProfileDecision({
      ...summary,
      retirements: apply ? retired.length : 0,
    }, { apply }),
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
