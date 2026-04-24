#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPositionStrategyHygieneRemediationPlan,
  runPositionStrategyHygiene,
} from './runtime-position-strategy-hygiene.ts';
import { normalizeDuplicateStrategyProfiles } from './normalize-duplicate-strategy-profiles.ts';
import { retireOrphanStrategyProfiles } from './retire-orphan-strategy-profiles.ts';
import {
  DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
  readPositionStrategyRemediationHistory,
} from './runtime-position-strategy-remediation-history-store.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const historyFileArg = argv.find((arg) => arg.startsWith('--history-file='));
  const stableCyclesArg = argv.find((arg) => arg.startsWith('--stable-cycles='));
  return {
    json: argv.includes('--json'),
    historyFile: historyFileArg?.split('=').slice(1).join('=') || DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
    autonomousApply: argv.includes('--autonomous-apply'),
    stableCycles: Math.max(1, Number(stableCyclesArg?.split('=').slice(1).join('=') || 3)),
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

export function buildPositionStrategyRemediationFlat({
  remediationSummary = null,
  remediationTrend = null,
  remediationRefreshState = null,
  remediationActions = null,
  decision = null,
} = {}) {
  return {
    status: remediationSummary?.status || decision?.status || null,
    headline: remediationSummary?.headline || decision?.headline || null,
    counts: remediationSummary?.counts || null,
    recommendedExchange: remediationSummary?.recommendedExchange || null,
    duplicateManaged: remediationSummary?.counts?.duplicateManaged ?? null,
    orphanProfiles: remediationSummary?.counts?.orphanProfiles ?? null,
    unmatchedManaged: remediationSummary?.counts?.unmatchedManaged ?? null,
    nextCommand: remediationSummary?.nextCommand || remediationActions?.nextCommand || null,
    nextCommandChanged: remediationTrend?.nextCommandChanged ?? null,
    nextCommandPrevious: remediationTrend?.nextCommandTransition?.previous || null,
    nextCommandCurrent: remediationTrend?.nextCommandTransition?.current || null,
    nextCommandTransition: remediationTrend?.nextCommandTransition || null,
    trend: remediationTrend || null,
    trendHistoryCount: remediationTrend?.historyCount ?? null,
    trendChanged: remediationTrend?.statusChanged ?? null,
    trendNextChanged: remediationTrend?.nextCommandChanged ?? null,
    trendAgeMinutes: remediationTrend?.ageMinutes ?? null,
    trendStale: remediationTrend?.stale ?? null,
    trendLastRecordedAt: remediationTrend?.lastRecordedAt || null,
    trendDuplicateDelta: remediationTrend?.duplicateDelta ?? null,
    trendOrphanDelta: remediationTrend?.orphanDelta ?? null,
    trendUnmatchedDelta: remediationTrend?.unmatchedDelta ?? null,
    refresh: remediationRefreshState || null,
    refreshNeeded: remediationRefreshState?.needed ?? null,
    refreshStale: remediationRefreshState?.stale ?? null,
    refreshReason: remediationRefreshState?.reason || null,
    refreshCommand: remediationRefreshState?.command || null,
    actionReportCommand: remediationActions?.reportCommand || null,
    actionHistoryCommand: remediationActions?.historyCommand || null,
    actionRefreshCommand: remediationActions?.refreshCommand || null,
    actionHygieneCommand: remediationActions?.hygieneCommand || null,
    actionNormalizeDryRunCommand: remediationActions?.normalizeDryRunCommand || null,
    actionNormalizeApplyCommand: remediationActions?.normalizeApplyCommand || null,
    actionRetireDryRunCommand: remediationActions?.retireDryRunCommand || null,
    actionRetireApplyCommand: remediationActions?.retireApplyCommand || null,
    actions: remediationActions ? {
      reportCommand: remediationActions.reportCommand || null,
      historyCommand: remediationActions.historyCommand || null,
      refreshCommand: remediationActions.refreshCommand || null,
      hygieneCommand: remediationActions.hygieneCommand || null,
      normalizeDryRunCommand: remediationActions.normalizeDryRunCommand || null,
      normalizeApplyCommand: remediationActions.normalizeApplyCommand || null,
      retireDryRunCommand: remediationActions.retireDryRunCommand || null,
      retireApplyCommand: remediationActions.retireApplyCommand || null,
    } : null,
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
  };
}

function buildPositionStrategyRemediationAliases(remediationFlat = null, remediationPlan = null) {
  return {
    remediationStatus: remediationFlat?.status || null,
    remediationHeadline: remediationFlat?.headline || null,
    remediationCounts: remediationFlat?.counts || null,
    remediationRecommendedExchange: remediationFlat?.recommendedExchange || remediationPlan?.recommendedExchange || null,
    remediationDuplicateManaged: remediationFlat?.duplicateManaged ?? null,
    remediationOrphanProfiles: remediationFlat?.orphanProfiles ?? null,
    remediationUnmatchedManaged: remediationFlat?.unmatchedManaged ?? null,
    remediationNextCommandTransition: remediationFlat?.nextCommandTransition || null,
    remediationNextCommandChanged: remediationFlat?.nextCommandChanged ?? null,
    remediationNextCommandPrevious: remediationFlat?.nextCommandPrevious || null,
    remediationNextCommandCurrent: remediationFlat?.nextCommandCurrent || null,
    remediationNextCommand: remediationFlat?.nextCommand || null,
    remediationRefreshState: remediationFlat?.refresh || null,
    remediationRefreshNeeded: remediationFlat?.refreshNeeded ?? null,
    remediationRefreshStale: remediationFlat?.refreshStale ?? null,
    remediationRefreshReason: remediationFlat?.refreshReason || null,
    remediationRefreshCommand: remediationFlat?.refreshCommand || null,
    remediationActions: remediationFlat?.actions || null,
    remediationCommands: remediationFlat?.commands || null,
    remediationActionReportCommand: remediationFlat?.actionReportCommand || null,
    remediationActionHistoryCommand: remediationFlat?.actionHistoryCommand || null,
    remediationActionRefreshCommand: remediationFlat?.actionRefreshCommand || null,
    remediationActionHygieneCommand: remediationFlat?.actionHygieneCommand || null,
    remediationActionNormalizeDryRunCommand: remediationFlat?.actionNormalizeDryRunCommand || null,
    remediationActionNormalizeApplyCommand: remediationFlat?.actionNormalizeApplyCommand || null,
    remediationActionRetireDryRunCommand: remediationFlat?.actionRetireDryRunCommand || null,
    remediationActionRetireApplyCommand: remediationFlat?.actionRetireApplyCommand || null,
  };
}

function buildAutonomousRemediationContext({
  remediationPlan = null,
  remediationHistory = null,
  hygiene = null,
  stableCycles = 3,
} = {}) {
  const historyCount = Number(remediationHistory?.historyCount || 0);
  const historyStable = Boolean(remediationHistory?.current) && remediationHistory?.stale !== true;
  const stableEnough = historyStable && historyCount >= Math.max(1, Number(stableCycles || 3));
  const duplicateSafe = hygiene?.duplicateNormalization?.decision?.safeToApply === true;
  const orphanSafe = hygiene?.orphanRetirement?.decision?.safeToApply === true;
  const targetExchange = remediationPlan?.recommendedExchange || null;
  return {
    stableCycles: Math.max(1, Number(stableCycles || 3)),
    historyCount,
    historyStable,
    stableEnough,
    duplicateSafe,
    orphanSafe,
    targetExchange,
    shouldApply: stableEnough && (duplicateSafe || orphanSafe),
  };
}

async function runAutonomousRemediationApply({
  context = null,
  beforeHygiene = null,
} = {}) {
  if (!context) {
    return {
      enabled: true,
      status: 'autonomous_action_blocked_by_safety',
      reason: 'remediation_context_missing',
      context: null,
      applied: {
        duplicate: null,
        orphan: null,
      },
      verify: null,
    };
  }

  if (!context.stableEnough) {
    return {
      enabled: true,
      status: 'autonomous_action_blocked_by_safety',
      reason: context.historyStable
        ? `history_not_enough_cycles:${context.historyCount}/${context.stableCycles}`
        : 'history_stale_or_missing',
      context,
      applied: {
        duplicate: null,
        orphan: null,
      },
      verify: null,
    };
  }

  if (!context.duplicateSafe && !context.orphanSafe) {
    return {
      enabled: true,
      status: 'autonomous_action_blocked_by_safety',
      reason: 'safe_to_apply_false',
      context,
      applied: {
        duplicate: null,
        orphan: null,
      },
      verify: null,
    };
  }

  const exchange = context.targetExchange || null;
  const duplicateApplied = context.duplicateSafe
    ? await normalizeDuplicateStrategyProfiles({ apply: true, exchange }).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
      retired: 0,
    }))
    : null;
  const orphanApplied = context.orphanSafe
    ? await retireOrphanStrategyProfiles({ apply: true, exchange }).catch((error) => ({
      ok: false,
      error: error?.message || String(error),
      retired: 0,
    }))
    : null;

  const afterHygiene = await runPositionStrategyHygiene({ json: true }).catch(() => null);
  const beforeAudit = beforeHygiene?.audit || {};
  const afterAudit = afterHygiene?.audit || {};
  const beforeDuplicate = Number(beforeAudit?.duplicateManagedProfileScopes || 0);
  const beforeOrphan = Number(beforeAudit?.orphanProfiles || 0);
  const beforeUnmatched = Number(beforeAudit?.unmatchedManagedPositions || 0);
  const afterDuplicate = Number(afterAudit?.duplicateManagedProfileScopes || 0);
  const afterOrphan = Number(afterAudit?.orphanProfiles || 0);
  const afterUnmatched = Number(afterAudit?.unmatchedManagedPositions || 0);
  const verified = afterHygiene != null
    && afterDuplicate <= beforeDuplicate
    && afterOrphan <= beforeOrphan
    && afterUnmatched <= beforeUnmatched;
  return {
    enabled: true,
    status: verified ? 'autonomous_action_executed' : 'autonomous_action_failed',
    reason: verified ? 'auto_apply_verified' : 'post_apply_verification_failed',
    context,
    applied: {
      duplicate: duplicateApplied,
      orphan: orphanApplied,
    },
    verify: {
      ok: verified,
      before: {
        duplicateManaged: beforeDuplicate,
        orphanProfiles: beforeOrphan,
        unmatchedManaged: beforeUnmatched,
      },
      after: {
        duplicateManaged: afterDuplicate,
        orphanProfiles: afterOrphan,
        unmatchedManaged: afterUnmatched,
      },
      afterHygiene: afterHygiene?.decision || null,
    },
  };
}

function buildPositionStrategyRemediationDecisionActionItems(
  remediationPlan,
  historyActionItem,
  historyRefreshActionItem,
  { includeCounts = false, includeNormalize = false, includeRetire = false } = {},
) {
  return [
    ...(includeCounts
      ? [`duplicate managed ${remediationPlan.duplicateManagedScopes || 0} / orphan ${remediationPlan.orphanProfiles || 0} / unmatched managed ${remediationPlan.unmatchedManaged || 0}`]
      : []),
    ...(historyActionItem ? [historyActionItem] : []),
    ...(historyRefreshActionItem ? [historyRefreshActionItem] : []),
    `remediation report: ${remediationPlan.remediationReportCommand}`,
    `remediation history: ${remediationPlan.remediationHistoryCommand}`,
    `hygiene report: ${remediationPlan.hygieneReportCommand}`,
    ...(includeNormalize ? [`normalize dry-run: ${remediationPlan.normalizeDryRunCommand}`] : []),
    ...(includeRetire ? [`retire dry-run: ${remediationPlan.retireDryRunCommand}`] : []),
  ];
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
      actionItems: buildPositionStrategyRemediationDecisionActionItems(
        remediationPlan,
        historyActionItem,
        historyRefreshActionItem,
        { includeCounts: true, includeNormalize: true, includeRetire: true },
      ),
    };
  }

  return {
    status: 'position_strategy_remediation_clear',
    headline: `현재 추가 remediation 없이 포지션 전략 위생 상태가 안정적입니다.${remediationHistory?.stale ? ' / history stale' : ''}${!remediationHistory?.current ? ' / history unavailable' : ''}`,
    actionItems: buildPositionStrategyRemediationDecisionActionItems(
      remediationPlan,
      historyActionItem,
      historyRefreshActionItem,
    ),
  };
}

export async function runPositionStrategyRemediation({
  json = false,
  historyFile = DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
  autonomousApply = false,
  stableCycles = 3,
} = {}) {
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
  const remediationFlat = buildPositionStrategyRemediationFlat({
    remediationSummary,
    remediationTrend,
    remediationRefreshState,
    remediationActions,
    decision,
  });
  const remediationAliases = buildPositionStrategyRemediationAliases(remediationFlat, remediationPlan);
  const autonomousContext = buildAutonomousRemediationContext({
    remediationPlan,
    remediationHistory,
    hygiene,
    stableCycles,
  });
  const remediationAutonomous = autonomousApply
    ? await runAutonomousRemediationApply({
      context: autonomousContext,
      beforeHygiene: hygiene,
    })
    : {
      enabled: false,
      status: 'autonomous_action_blocked_by_safety',
      reason: 'autonomous_apply_disabled',
      context: autonomousContext,
      applied: {
        duplicate: null,
        orphan: null,
      },
      verify: null,
    };
  const result = {
    ok: true,
    hygieneStatus: hygiene?.decision?.status || 'unknown',
    recommendedExchange: remediationPlan?.recommendedExchange || null,
    remediationPlan,
    remediationHistory,
    remediationTrend,
    remediationTrendHistoryCount: remediationTrend?.historyCount ?? null,
    remediationTrendChanged: remediationTrend?.statusChanged ?? null,
    remediationTrendNextChanged: remediationTrend?.nextCommandChanged ?? null,
    remediationTrendAgeMinutes: remediationTrend?.ageMinutes ?? null,
    remediationTrendStale: remediationTrend?.stale ?? null,
    remediationTrendLastRecordedAt: remediationTrend?.lastRecordedAt || null,
    remediationTrendDuplicateDelta: remediationTrend?.duplicateDelta ?? null,
    remediationTrendOrphanDelta: remediationTrend?.orphanDelta ?? null,
    remediationTrendUnmatchedDelta: remediationTrend?.unmatchedDelta ?? null,
    remediationSummary,
    remediationFlat,
    remediationAutonomous,
    remediationAutonomousStatus: remediationAutonomous?.status || null,
    remediationAutonomousReason: remediationAutonomous?.reason || null,
    remediationAutonomousContext: remediationAutonomous?.context || autonomousContext,
    remediationAutonomousVerify: remediationAutonomous?.verify || null,
    remediationAutonomousApplied: remediationAutonomous?.applied || null,
    ...remediationAliases,
    decision,
  };
  if (json) return result;
  return JSON.stringify(result, null, 2);
}

async function main() {
  const args = parseArgs();
  const result = await runPositionStrategyRemediation({
    json: true,
    historyFile: args.historyFile,
    autonomousApply: args.autonomousApply,
    stableCycles: args.stableCycles,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(JSON.stringify(result, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-remediation 오류:',
  });
}
