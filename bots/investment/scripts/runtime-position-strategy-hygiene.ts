#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimePositionStrategyAudit } from './runtime-position-strategy-audit.ts';
import { normalizeDuplicateStrategyProfiles } from './normalize-duplicate-strategy-profiles.ts';
import { retireOrphanStrategyProfiles } from './retire-orphan-strategy-profiles.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
  };
}

export function buildPositionStrategyHygieneDecision({
  audit = null,
  duplicateNormalization = null,
  orphanRetirement = null,
} = {}) {
  const duplicateScopes = Number(audit?.duplicateManagedProfileScopes || audit?.duplicateActiveProfileScopes || 0);
  const orphanProfiles = Number(audit?.orphanProfiles || 0);
  const unmatchedManaged = Number(audit?.unmatchedManagedPositions || 0);

  if (duplicateScopes > 0 || orphanProfiles > 0 || unmatchedManaged > 0) {
    return {
      status: 'position_strategy_hygiene_attention',
      headline: '포지션 전략 위생 점검에서 정리 후보가 감지되었습니다.',
      actionItems: [
        `duplicate scopes ${duplicateScopes} / orphan profiles ${orphanProfiles} / unmatched managed ${unmatchedManaged}`,
        `duplicate dry-run: ${duplicateNormalization?.decision?.headline || 'n/a'}`,
        `orphan dry-run: ${orphanRetirement?.decision?.headline || 'n/a'}`,
      ],
    };
  }

  return {
    status: 'position_strategy_hygiene_ok',
    headline: '포지션 전략 위생 상태가 안정적입니다.',
    actionItems: [
      'managed 포지션 기준 duplicate/orphan/unmatched 이슈가 없습니다.',
    ],
  };
}

export async function runPositionStrategyHygiene({ json = false } = {}) {
  const [audit, duplicateNormalization, orphanRetirement] = await Promise.all([
    buildRuntimePositionStrategyAudit({ json: true }),
    normalizeDuplicateStrategyProfiles({ apply: false }),
    retireOrphanStrategyProfiles({ apply: false }),
  ]);

  const result = {
    ok: true,
    audit,
    duplicateNormalization,
    orphanRetirement,
    decision: buildPositionStrategyHygieneDecision({
      audit,
      duplicateNormalization,
      orphanRetirement,
    }),
  };

  if (json) return result;
  return JSON.stringify(result, null, 2);
}

async function main() {
  const args = parseArgs();
  const result = await runPositionStrategyHygiene({ json: true });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-hygiene 오류:',
  });
}
