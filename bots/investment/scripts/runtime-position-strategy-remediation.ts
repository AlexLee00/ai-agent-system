#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPositionStrategyHygieneRemediationPlan,
  runPositionStrategyHygiene,
} from './runtime-position-strategy-hygiene.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
  };
}

export function buildPositionStrategyRemediationDecision(remediationPlan = null) {
  if (!remediationPlan) {
    return {
      status: 'position_strategy_remediation_unavailable',
      headline: '포지션 전략 remediation plan을 계산할 수 없습니다.',
      actionItems: [
        'runtime:position-strategy-hygiene 실행 상태를 먼저 확인합니다.',
      ],
    };
  }

  if (remediationPlan.status === 'position_strategy_hygiene_attention') {
    return {
      status: 'position_strategy_remediation_ready',
      headline: `포지션 전략 remediation plan이 준비되었습니다.${remediationPlan.recommendedExchange ? ` / focus ${remediationPlan.recommendedExchange}` : ''}`,
      actionItems: [
        `duplicate managed ${remediationPlan.duplicateManagedScopes || 0} / orphan ${remediationPlan.orphanProfiles || 0} / unmatched managed ${remediationPlan.unmatchedManaged || 0}`,
        `remediation report: ${remediationPlan.remediationReportCommand}`,
        `remediation history: ${remediationPlan.remediationHistoryCommand}`,
        `hygiene report: ${remediationPlan.hygieneReportCommand}`,
        `normalize dry-run: ${remediationPlan.normalizeDryRunCommand}`,
        `retire dry-run: ${remediationPlan.retireDryRunCommand}`,
      ],
    };
  }

    return {
      status: 'position_strategy_remediation_clear',
      headline: '현재 추가 remediation 없이 포지션 전략 위생 상태가 안정적입니다.',
      actionItems: [
        `remediation report: ${remediationPlan.remediationReportCommand}`,
        `remediation history: ${remediationPlan.remediationHistoryCommand}`,
        `hygiene report: ${remediationPlan.hygieneReportCommand}`,
      ],
    };
}

export async function runPositionStrategyRemediation({ json = false } = {}) {
  const hygiene = await runPositionStrategyHygiene({ json: true });
  const remediationPlan = hygiene?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(hygiene);
  const result = {
    ok: true,
    hygieneStatus: hygiene?.decision?.status || 'unknown',
    recommendedExchange: remediationPlan?.recommendedExchange || null,
    remediationPlan,
    decision: buildPositionStrategyRemediationDecision(remediationPlan),
  };
  if (json) return result;
  return JSON.stringify(result, null, 2);
}

async function main() {
  const args = parseArgs();
  const result = await runPositionStrategyRemediation({ json: true });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-remediation 오류:',
  });
}
