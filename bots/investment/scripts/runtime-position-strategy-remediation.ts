#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPositionStrategyHygieneRemediationPlan,
  runPositionStrategyHygiene,
} from './runtime-position-strategy-hygiene.ts';
import {
  DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
  readPositionStrategyRemediationHistory,
} from './runtime-position-strategy-remediation-history-store.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const historyFileArg = argv.find((arg) => arg.startsWith('--history-file='));
  return {
    json: argv.includes('--json'),
    historyFile: historyFileArg?.split('=').slice(1).join('=') || DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
  };
}

function buildHistoryActionItem(remediationHistory = null) {
  if (!remediationHistory?.current) return null;
  return `history count ${remediationHistory.historyCount || 0} / changed ${remediationHistory.statusChanged ? 'yes' : 'no'} / duplicate delta ${remediationHistory.delta?.duplicateManaged >= 0 ? '+' : ''}${remediationHistory.delta?.duplicateManaged || 0} / orphan delta ${remediationHistory.delta?.orphanProfiles >= 0 ? '+' : ''}${remediationHistory.delta?.orphanProfiles || 0} / unmatched delta ${remediationHistory.delta?.unmatchedManaged >= 0 ? '+' : ''}${remediationHistory.delta?.unmatchedManaged || 0}`;
}

export function buildPositionStrategyRemediationDecision(remediationPlan = null, remediationHistory = null) {
  const historyActionItem = buildHistoryActionItem(remediationHistory);
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
        ...(historyActionItem ? [historyActionItem] : []),
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
        ...(historyActionItem ? [historyActionItem] : []),
        `remediation report: ${remediationPlan.remediationReportCommand}`,
        `remediation history: ${remediationPlan.remediationHistoryCommand}`,
        `hygiene report: ${remediationPlan.hygieneReportCommand}`,
      ],
    };
}

export async function runPositionStrategyRemediation({ json = false, historyFile = DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE } = {}) {
  const hygiene = await runPositionStrategyHygiene({ json: true });
  const remediationPlan = hygiene?.remediationPlan
    || buildPositionStrategyHygieneRemediationPlan(hygiene);
  const remediationHistory = readPositionStrategyRemediationHistory(historyFile);
  const result = {
    ok: true,
    hygieneStatus: hygiene?.decision?.status || 'unknown',
    recommendedExchange: remediationPlan?.recommendedExchange || null,
    remediationPlan,
    remediationHistory,
    decision: buildPositionStrategyRemediationDecision(remediationPlan, remediationHistory),
  };
  if (json) return result;
  return JSON.stringify(result, null, 2);
}

async function main() {
  const args = parseArgs();
  const result = await runPositionStrategyRemediation({ json: true, historyFile: args.historyFile });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-remediation 오류:',
  });
}
