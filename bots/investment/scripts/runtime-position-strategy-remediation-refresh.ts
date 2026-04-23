#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPositionStrategyRemediationHistory } from './runtime-position-strategy-remediation-history.ts';
import {
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

function renderText(result) {
  return [
    '♻️ Position Strategy Remediation Refresh',
    `저장 파일: ${result.file}`,
    `before count: ${result.before.historyCount || 0}`,
    `after count: ${result.after.historyCount || 0}`,
    `status: ${result.after.current?.status || 'unknown'}`,
    `headline: ${result.after.current?.headline || 'n/a'}`,
    `refresh needed: ${result.refreshState?.needed ? 'yes' : 'no'}`,
    `refresh stale: ${result.refreshState?.stale ? 'yes' : 'no'}`,
    `refresh command: ${result.refreshState?.command || 'n/a'}`,
    `delta duplicate: ${result.after.delta?.duplicateManaged >= 0 ? '+' : ''}${result.after.delta?.duplicateManaged || 0}`,
    `delta orphan: ${result.after.delta?.orphanProfiles >= 0 ? '+' : ''}${result.after.delta?.orphanProfiles || 0}`,
    `delta unmatched: ${result.after.delta?.unmatchedManaged >= 0 ? '+' : ''}${result.after.delta?.unmatchedManaged || 0}`,
  ].join('\n');
}

export async function runPositionStrategyRemediationRefresh({ file = DEFAULT_POSITION_STRATEGY_REMEDIATION_HISTORY_FILE, json = false } = {}) {
  const before = readPositionStrategyRemediationHistory(file);
  const after = await buildPositionStrategyRemediationHistory({ file, json: true });
  const result = {
    ok: true,
    file,
    before,
    after,
    refreshState: {
      needed: false,
      stale: false,
      reason: 'history refresh executed',
      command: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation-refresh -- --json',
    },
  };
  if (json) return result;
  return renderText(result);
}

async function main() {
  const args = parseArgs();
  const result = await runPositionStrategyRemediationRefresh(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-remediation-refresh 오류:',
  });
}
