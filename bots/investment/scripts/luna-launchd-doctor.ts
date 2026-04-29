#!/usr/bin/env node
// @ts-nocheck

import { inspectLaunchdList, inspectLaunchdPrint } from '../shared/launchd-service.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_LABELS = [
  { label: 'ai.investment.daily-feedback', expected: 'loaded', critical: true, note: 'daily feedback loop' },
  { label: 'ai.investment.crypto', expected: 'loaded', critical: true, note: 'crypto market cycle' },
  { label: 'ai.investment.crypto.validation', expected: 'loaded', critical: false, note: 'crypto validation cycle' },
  { label: 'ai.investment.runtime-autopilot', expected: 'loaded', critical: true, note: 'runtime autopilot' },
  { label: 'ai.luna.tradingview-ws', expected: 'running', critical: true, note: 'TradingView websocket' },
  { label: 'ai.investment.commander', expected: 'running_or_loaded', critical: false, note: 'operator command bridge' },
  { label: 'ai.investment.posttrade-feedback-worker', expected: 'loaded', critical: false, note: 'posttrade feedback worker' },
];

function parseArgs(argv = process.argv.slice(2)) {
  const labelsArg = argv.find((arg) => arg.startsWith('--labels='))?.split('=')[1] || '';
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    labels: labelsArg
      ? labelsArg.split(',').map((label) => ({ label: label.trim(), expected: 'loaded', critical: true, note: 'custom' })).filter((item) => item.label)
      : DEFAULT_LABELS,
  };
}

function classifyService(spec, listStatus, printStatus) {
  const warnings = [];
  const blockers = [];
  const loaded = listStatus.loaded === true || printStatus.loaded === true;
  const hasPid = (value) => value != null && Number.isFinite(Number(value)) && Number(value) > 0;
  const running = hasPid(listStatus.pid) || hasPid(printStatus.pid);
  const lastExit = listStatus.lastExitStatus ?? printStatus.lastExitCode ?? null;

  if (!loaded) {
    (spec.critical ? blockers : warnings).push('launchd_not_loaded');
  }
  if (spec.expected === 'running' && !running) {
    (spec.critical ? blockers : warnings).push('launchd_not_running');
  }
  if (lastExit != null && lastExit !== 0) {
    warnings.push(`previous_exit_status_${lastExit}`);
  }
  return {
    label: spec.label,
    expected: spec.expected,
    critical: spec.critical === true,
    note: spec.note || null,
    ok: blockers.length === 0,
    loaded,
    running,
    pid: listStatus.pid ?? printStatus.pid ?? null,
    lastExitStatus: lastExit,
    warnings,
    blockers,
    list: listStatus,
    print: printStatus,
  };
}

export async function buildLunaLaunchdDoctor({ labels = DEFAULT_LABELS, strict = false } = {}) {
  const services = labels.map((spec) => classifyService(
    spec,
    inspectLaunchdList(spec.label),
    inspectLaunchdPrint(spec.label),
  ));
  const blockers = services.flatMap((service) => service.blockers.map((blocker) => `${service.label}:${blocker}`));
  const warnings = services.flatMap((service) => service.warnings.map((warning) => `${service.label}:${warning}`));
  const strictBlockers = strict ? warnings.filter((warning) => warning.includes('previous_exit_status_')) : [];
  return {
    ok: blockers.length === 0 && strictBlockers.length === 0,
    status: blockers.length || strictBlockers.length ? 'luna_launchd_attention' : 'luna_launchd_clear',
    generatedAt: new Date().toISOString(),
    strict,
    summary: {
      total: services.length,
      loaded: services.filter((service) => service.loaded).length,
      running: services.filter((service) => service.running).length,
      warningCount: warnings.length,
      blockerCount: blockers.length + strictBlockers.length,
    },
    blockers: [...blockers, ...strictBlockers],
    warnings,
    services,
    nextAction: blockers.length || strictBlockers.length
      ? 'review_launchd_service_blockers'
      : (warnings.length ? 'monitor_or_kickstart_services_with_previous_exit' : 'luna_launchd_operational'),
  };
}

function render(report = {}) {
  const lines = [
    `Luna launchd doctor: ${report.status}`,
    `loaded=${report.summary?.loaded}/${report.summary?.total} running=${report.summary?.running} warnings=${report.summary?.warningCount} blockers=${report.summary?.blockerCount}`,
  ];
  for (const service of report.services || []) {
    lines.push(`- ${service.label}: loaded=${service.loaded} running=${service.running} pid=${service.pid ?? 'n/a'} lastExit=${service.lastExitStatus ?? 'n/a'} warnings=${service.warnings.join(',') || 'none'} blockers=${service.blockers.join(',') || 'none'}`);
  }
  lines.push(`next: ${report.nextAction}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaLaunchdDoctor(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  if (args.strict && report.ok !== true) process.exitCode = 1;
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-launchd-doctor 실패:',
  });
}
