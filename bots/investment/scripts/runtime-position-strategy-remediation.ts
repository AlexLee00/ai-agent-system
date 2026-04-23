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
  if (!remediationHistory?.current) return 'history unavailable / refresh required';
  return `history count ${remediationHistory.historyCount || 0} / changed ${remediationHistory.statusChanged ? 'yes' : 'no'} / next changed ${remediationHistory.nextCommandChanged ? 'yes' : 'no'}${remediationHistory.nextCommandChanged ? ` (${remediationHistory.nextCommandTransition?.previous || 'none'} -> ${remediationHistory.nextCommandTransition?.current || 'none'})` : ''} / age ${remediationHistory.ageMinutes ?? 'n/a'}m / stale ${remediationHistory.stale ? 'yes' : 'no'} / duplicate delta ${remediationHistory.delta?.duplicateManaged >= 0 ? '+' : ''}${remediationHistory.delta?.duplicateManaged || 0} / orphan delta ${remediationHistory.delta?.orphanProfiles >= 0 ? '+' : ''}${remediationHistory.delta?.orphanProfiles || 0} / unmatched delta ${remediationHistory.delta?.unmatchedManaged >= 0 ? '+' : ''}${remediationHistory.delta?.unmatchedManaged || 0}`;
}

function buildHistoryRefreshActionItem(remediationPlan = null, remediationHistory = null) {
  if (!remediationPlan?.remediationHistoryCommand) return null;
  const refreshCommand = remediationPlan?.remediationRefreshCommand || remediationPlan.remediationHistoryCommand;
  if (!remediationHistory?.current) return `history refresh required: ${refreshCommand}`;
  if (remediationHistory.stale) return `history refresh recommended: ${refreshCommand}`;
  return null;
}

export function buildPositionStrategyRemediationTrend(remediationHistory = null) {
  if (!remediationHistory) return null;
  return {
    historyCount: remediationHistory.historyCount || 0,
    statusChanged: Boolean(remediationHistory.statusChanged),
    nextCommandChanged: Boolean(remediationHistory.nextCommandChanged),
    nextCommandTransition: remediationHistory.nextCommandTransition || null,
    ageMinutes: remediationHistory.ageMinutes ?? null,
    stale: Boolean(remediationHistory.stale),
    lastRecordedAt: remediationHistory.lastRecordedAt || null,
    duplicateDelta: remediationHistory.delta?.duplicateManaged || 0,
    orphanDelta: remediationHistory.delta?.orphanProfiles || 0,
    unmatchedDelta: remediationHistory.delta?.unmatchedManaged || 0,
  };
}

export function buildPositionStrategyRemediationRefreshState(remediationPlan = null, remediationHistory = null) {
  const reason = buildHistoryRefreshActionItem(remediationPlan, remediationHistory);
  return {
    needed: Boolean(reason),
    stale: Boolean(remediationHistory?.stale),
    reason,
    command: reason?.split(':').slice(1).join(':').trim() || null,
  };
}

export function buildPositionStrategyRemediationActions(remediationPlan = null, remediationRefreshState = null) {
  if (!remediationPlan) {
    return {
      reportCommand: null,
      historyCommand: null,
      refreshCommand: remediationRefreshState?.command || null,
      hygieneCommand: null,
      normalizeDryRunCommand: null,
      normalizeApplyCommand: null,
      retireDryRunCommand: null,
      retireApplyCommand: null,
      nextCommand: remediationRefreshState?.command || null,
    };
  }

  const refreshCommand = remediationRefreshState?.command
    || remediationPlan?.remediationRefreshCommand
    || remediationPlan?.remediationHistoryCommand
    || null;
  const reportCommand = remediationPlan?.remediationReportCommand || null;
  const historyCommand = remediationPlan?.remediationHistoryCommand || null;
  const hygieneCommand = remediationPlan?.hygieneReportCommand || null;
  const normalizeDryRunCommand = remediationPlan?.normalizeDryRunCommand || null;
  const normalizeApplyCommand = remediationPlan?.normalizeApplyCommand || null;
  const retireDryRunCommand = remediationPlan?.retireDryRunCommand || null;
  const retireApplyCommand = remediationPlan?.retireApplyCommand || null;

  let nextCommand = reportCommand;
  if (remediationRefreshState?.needed) nextCommand = refreshCommand || historyCommand || reportCommand;
  else if (remediationPlan.status === 'position_strategy_hygiene_attention') nextCommand = reportCommand || normalizeDryRunCommand || retireDryRunCommand || hygieneCommand;
  else nextCommand = hygieneCommand || reportCommand;

  return {
    reportCommand,
    historyCommand,
    refreshCommand,
    hygieneCommand,
    normalizeDryRunCommand,
    normalizeApplyCommand,
    retireDryRunCommand,
    retireApplyCommand,
    nextCommand,
  };
}

export function buildPositionStrategyRemediationSummary({
  remediationPlan = null,
  remediationTrend = null,
  remediationRefreshState = null,
  remediationActions = null,
  decision = null,
} = {}) {
  if (!remediationPlan && !decision) return null;
  return {
    status: decision?.status || null,
    headline: decision?.headline || null,
    recommendedExchange: remediationPlan?.recommendedExchange || null,
    counts: remediationPlan ? {
      duplicateManaged: remediationPlan.duplicateManagedScopes || 0,
      orphanProfiles: remediationPlan.orphanProfiles || 0,
      unmatchedManaged: remediationPlan.unmatchedManaged || 0,
    } : null,
    trend: remediationTrend || null,
    refreshState: remediationRefreshState || null,
    actions: remediationActions || null,
    commands: remediationActions ? {
      report: remediationActions.reportCommand || null,
      history: remediationActions.historyCommand || null,
      refresh: remediationActions.refreshCommand || null,
      hygiene: remediationActions.hygieneCommand || null,
      normalizeDryRun: remediationActions.normalizeDryRunCommand || null,
      normalizeApply: remediationActions.normalizeApplyCommand || null,
      retireDryRun: remediationActions.retireDryRunCommand || null,
      retireApply: remediationActions.retireApplyCommand || null,
    } : null,
    nextCommand: remediationActions?.nextCommand || null,
    nextCommandTransition: remediationTrend?.nextCommandTransition || null,
  };
}

export function buildPositionStrategyRemediationDecision(remediationPlan = null, remediationHistory = null) {
  const historyActionItem = buildHistoryActionItem(remediationHistory);
  const refreshState = buildPositionStrategyRemediationRefreshState(remediationPlan, remediationHistory);
  const historyRefreshActionItem = refreshState.reason;
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
      headline: `포지션 전략 remediation plan이 준비되었습니다.${remediationPlan.recommendedExchange ? ` / focus ${remediationPlan.recommendedExchange}` : ''}${remediationHistory?.stale ? ' / history stale' : ''}${!remediationHistory?.current ? ' / history unavailable' : ''}`,
      actionItems: [
        `duplicate managed ${remediationPlan.duplicateManagedScopes || 0} / orphan ${remediationPlan.orphanProfiles || 0} / unmatched managed ${remediationPlan.unmatchedManaged || 0}`,
        ...(historyActionItem ? [historyActionItem] : []),
        ...(historyRefreshActionItem ? [historyRefreshActionItem] : []),
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
      headline: `현재 추가 remediation 없이 포지션 전략 위생 상태가 안정적입니다.${remediationHistory?.stale ? ' / history stale' : ''}${!remediationHistory?.current ? ' / history unavailable' : ''}`,
      actionItems: [
        ...(historyActionItem ? [historyActionItem] : []),
        ...(historyRefreshActionItem ? [historyRefreshActionItem] : []),
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
  const remediationTrend = buildPositionStrategyRemediationTrend(remediationHistory);
  const remediationRefreshState = buildPositionStrategyRemediationRefreshState(remediationPlan, remediationHistory);
  const remediationActions = buildPositionStrategyRemediationActions(remediationPlan, remediationRefreshState);
  const decision = buildPositionStrategyRemediationDecision(remediationPlan, remediationHistory);
  const remediationSummary = buildPositionStrategyRemediationSummary({
    remediationPlan,
    remediationTrend,
    remediationRefreshState,
    remediationActions,
    decision,
  });
  const result = {
    ok: true,
    hygieneStatus: hygiene?.decision?.status || 'unknown',
    recommendedExchange: remediationPlan?.recommendedExchange || null,
    remediationPlan,
    remediationHistory,
    remediationTrend,
    remediationSummary,
    remediationNextCommandTransition: remediationHistory?.nextCommandTransition || null,
    remediationRefreshState,
    remediationActions,
    decision,
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
