#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionStrategyRemediation } from './runtime-position-strategy-remediation.ts';
import {
  appendPositionStrategyRemediationHistory,
  DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
  readPositionStrategyRemediationHistory,
} from './runtime-position-strategy-remediation-history-store.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    file: fileArg?.split('=').slice(1).join('=') || DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE,
    json: argv.includes('--json'),
  };
}

function renderText(payload) {
  const currentFlat = payload.current.flat || null;
  return [
    '🗂️ Position Strategy Remediation History',
    `저장 파일: ${payload.file}`,
    `누적 스냅샷: ${payload.historyCount}건`,
    '',
    `현재 상태: ${currentFlat?.status || payload.current.status}`,
    `이전 상태: ${payload.previous?.status || '없음'}`,
    `상태 변화: ${payload.statusChanged ? `${payload.previous?.status || 'none'} -> ${currentFlat?.status || payload.current.status}` : '유지'}`,
    `focus 변화: ${payload.previous?.recommendedExchange || 'none'} -> ${currentFlat?.recommendedExchange || payload.current.recommendedExchange || 'none'}`,
    `next command: ${currentFlat?.nextCommand || payload.current.nextCommand || 'n/a'}`,
    `next command 변화: ${payload.nextCommandChanged ? `${payload.nextCommandTransition?.previous || 'none'} -> ${payload.nextCommandTransition?.current || 'none'}` : '유지'}`,
    `duplicate 변화: ${payload.delta.duplicateManaged >= 0 ? '+' : ''}${payload.delta.duplicateManaged}`,
    `orphan 변화: ${payload.delta.orphanProfiles >= 0 ? '+' : ''}${payload.delta.orphanProfiles}`,
    `unmatched 변화: ${payload.delta.unmatchedManaged >= 0 ? '+' : ''}${payload.delta.unmatchedManaged}`,
    '',
    `요약: ${currentFlat?.headline || payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

function buildCurrentRemediationSnapshot(report) {
  const plan = report.remediationPlan || {};
  const flat = report.remediationFlat || null;
  return {
    recordedAt: new Date().toISOString(),
    status: report.remediationStatus || flat?.status || report.decision?.status || 'unknown',
    headline: report.remediationHeadline || flat?.headline || report.decision?.headline || 'n/a',
    recommendedExchange: report.remediationRecommendedExchange || flat?.recommendedExchange || plan.recommendedExchange || null,
    nextCommand: report.remediationNextCommand || flat?.nextCommand || null,
    refreshCommand: report.remediationActionRefreshCommand || flat?.actionRefreshCommand || report.remediationRefreshCommand || flat?.refreshCommand || null,
    reportCommand: report.remediationActionReportCommand || flat?.actionReportCommand || report.remediationReportCommand || flat?.commands?.report || null,
    autonomousStatus: report.remediationAutonomousStatus || null,
    autonomousReason: report.remediationAutonomousReason || null,
    autonomousVerify: report.remediationAutonomousVerify || null,
    duplicateManaged: Number(report.remediationDuplicateManaged ?? flat?.duplicateManaged ?? plan.duplicateManagedScopes ?? 0),
    orphanProfiles: Number(report.remediationOrphanProfiles ?? flat?.orphanProfiles ?? plan.orphanProfiles ?? 0),
    unmatchedManaged: Number(report.remediationUnmatchedManaged ?? flat?.unmatchedManaged ?? plan.unmatchedManaged ?? 0),
    actionItems: report.decision?.actionItems || [],
    flat,
  };
}

export async function buildPositionStrategyRemediationHistory({ file = DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE, json = false } = {}) {
  const report = await runPositionStrategyRemediation({ json: true });
  const current = buildCurrentRemediationSnapshot(report);
  const previousSnapshot = readPositionStrategyRemediationHistory(file);
  appendPositionStrategyRemediationHistory(file, current);

  const payload = {
    ok: true,
    file,
    historyCount: previousSnapshot.historyCount + 1,
    current,
    previous: previousSnapshot.current,
    lastRecordedAt: current.recordedAt,
    ageMinutes: 0,
    stale: false,
    statusChanged: previousSnapshot.current ? previousSnapshot.current.status !== current.status : false,
    nextCommandChanged: previousSnapshot.current ? String(previousSnapshot.current.nextCommand || '') !== String(current.nextCommand || '') : false,
    nextCommandTransition: {
      previous: previousSnapshot.current?.nextCommand || null,
      current: current.nextCommand || null,
    },
    delta: {
      duplicateManaged: previousSnapshot.current ? current.duplicateManaged - Number(previousSnapshot.current.duplicateManaged || 0) : 0,
      orphanProfiles: previousSnapshot.current ? current.orphanProfiles - Number(previousSnapshot.current.orphanProfiles || 0) : 0,
      unmatchedManaged: previousSnapshot.current ? current.unmatchedManaged - Number(previousSnapshot.current.unmatchedManaged || 0) : 0,
    },
  };

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildPositionStrategyRemediationHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-remediation-history 오류:',
  });
}
