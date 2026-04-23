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

function buildRecommendedExchange({ duplicateNormalization = null, orphanRetirement = null } = {}) {
  const counts = new Map();
  for (const row of duplicateNormalization?.rows || []) {
    const exchange = String(row?.exchange || '').trim();
    if (!exchange) continue;
    counts.set(exchange, (counts.get(exchange) || 0) + Number(row?.retirements?.length || 0));
  }
  for (const row of orphanRetirement?.rows || []) {
    const exchange = String(row?.exchange || '').trim();
    if (!exchange) continue;
    counts.set(exchange, (counts.get(exchange) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([exchange, count]) => ({ exchange, count }))[0] || null;
}

export function buildPositionStrategyHygieneRemediationPlan({
  audit = null,
  duplicateNormalization = null,
  orphanRetirement = null,
  recommendedExchange = null,
  decision = null,
} = {}) {
  const exchange = recommendedExchange?.exchange || null;
  const exchangeSuffix = exchange ? ` --exchange=${exchange}` : '';
  return {
    status: decision?.status || 'unknown',
    recommendedExchange: exchange,
    recommendedExchangeCount: Number(recommendedExchange?.count || 0),
    duplicateManagedScopes: Number(audit?.duplicateManagedProfileScopes || 0),
    orphanProfiles: Number(audit?.orphanProfiles || 0),
    unmatchedManaged: Number(audit?.unmatchedManagedPositions || 0),
    remediationReportCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation -- --json',
    remediationHistoryCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation-history -- --json',
    hygieneReportCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-hygiene -- --json',
    normalizeDryRunCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:normalize-duplicate-strategy-profiles -- --json${exchangeSuffix}`,
    normalizeApplyCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:normalize-duplicate-strategy-profiles -- --apply --json${exchangeSuffix}`,
    retireDryRunCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:retire-orphan-strategy-profiles -- --json${exchangeSuffix}`,
    retireApplyCommand: `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:retire-orphan-strategy-profiles -- --apply --json${exchangeSuffix}`,
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
  const recommendedExchange = buildRecommendedExchange({ duplicateNormalization, orphanRetirement });
  const exchangeHint = recommendedExchange?.exchange
    ? ` / focus ${recommendedExchange.exchange} (${recommendedExchange.count})`
    : '';

  if (duplicateScopes > 0 || orphanProfiles > 0 || unmatchedManaged > 0) {
    return {
      status: 'position_strategy_hygiene_attention',
      headline: `포지션 전략 위생 점검에서 정리 후보가 감지되었습니다.${exchangeHint}`,
      actionItems: [
        `duplicate scopes ${duplicateScopes} / orphan profiles ${orphanProfiles} / unmatched managed ${unmatchedManaged}`,
        recommendedExchange?.exchange ? `추천 범위: exchange=${recommendedExchange.exchange}` : '추천 범위: exchange=all',
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
  const recommendedExchange = buildRecommendedExchange({ duplicateNormalization, orphanRetirement });

  const result = {
    ok: true,
    audit,
    duplicateNormalization,
    orphanRetirement,
    recommendedExchange,
    decision: buildPositionStrategyHygieneDecision({
      audit,
      duplicateNormalization,
      orphanRetirement,
    }),
  };
  result.remediationPlan = buildPositionStrategyHygieneRemediationPlan({
    audit,
    duplicateNormalization,
    orphanRetirement,
    recommendedExchange,
    decision: result.decision,
  });

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
