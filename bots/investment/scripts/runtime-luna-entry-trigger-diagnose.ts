#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaEntryTriggerDiagnose } from './luna-entry-trigger-diagnose.ts';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
    exchange: argValue('--exchange', 'binance'),
    hours: Number(argValue('--hours', '24') || 24),
  };
}

function renderSummary(report = {}) {
  const heartbeat = report.heartbeat || {};
  const blockSummary = report.blockSummary || {};
  const topBlocks = Object.entries(blockSummary)
    .filter(([, count]) => Number(count || 0) > 0)
    .map(([key, count]) => `${key}:${count}`)
    .join(', ') || 'none';
  return [
    '🔍 Luna first close-cycle Z1 entry-trigger diagnose',
    `status: ${report.ok ? 'ready_or_waiting' : 'attention'}`,
    `exchange: ${report.exchange || 'unknown'}`,
    `mode: ${report.mode || 'unknown'} / allowLiveFire=${report.allowLiveFire === true}`,
    `heartbeat: age=${heartbeat.ageMinutes ?? 'n/a'}m checked=${heartbeat.checked ?? 0} fired=${heartbeat.fired ?? 0} readyBlocked=${heartbeat.readyBlocked ?? 0} source=${heartbeat.eventSource || 'unknown'}`,
    `activeTriggers: ${report.activeTriggers?.count ?? 0} (${(report.activeTriggers?.symbols || []).slice(0, 8).join(', ') || 'none'})`,
    `recentFired: ${report.recentFired?.count ?? 0} in ${report.recentFired?.hours ?? 'n/a'}h`,
    `blocks: ${topBlocks}`,
    `issues: ${(report.issues || []).length}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  const report = await runLunaEntryTriggerDiagnose(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderSummary(report));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-entry-trigger-diagnose 실패:',
  });
}

