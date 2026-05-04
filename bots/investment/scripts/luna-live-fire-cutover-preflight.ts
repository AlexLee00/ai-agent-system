#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaReconcileResolutionPlan } from './luna-reconcile-resolution-plan.ts';
import { buildLunaPostLiveFireVerification } from './luna-post-live-fire-verify.ts';
import { buildLunaLiveFireReadinessGate } from './luna-live-fire-readiness-gate.ts';
import { publishAlert } from '../shared/alert-publisher.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function runJsonCommand(command, args = []) {
  const proc = spawnSync(command, args, { cwd: INVESTMENT_DIR, encoding: 'utf8' });
  let json = null;
  try {
    const firstJson = String(proc.stdout || '').slice(String(proc.stdout || '').indexOf('{'));
    json = firstJson ? JSON.parse(firstJson) : null;
  } catch {
    json = null;
  }
  return {
    ok: proc.status === 0,
    status: proc.status,
    command: [command, ...args].join(' '),
    json,
    stdoutTail: String(proc.stdout || '').split('\n').slice(-8).join('\n'),
    stderrTail: String(proc.stderr || '').split('\n').slice(-8).join('\n'),
  };
}

function parityClear(parityResult = null) {
  if (!parityResult) return null;
  const summary = parityResult.json?.summary || {};
  // walletOnlyDust/walletJournalDust are non-blocking exchange dust classes.
  // Meaningful wallet-only holdings remain blockers through summary.walletOnly.
  const problemCount = Number(summary.quantityMismatch || 0)
    + Number(summary.pnlMismatch || 0)
    + Number(summary.walletOnly || 0)
    + Number(summary.walletJournalOnly || 0)
    + Number(summary.dbOnly || 0);
  return problemCount === 0;
}

export async function buildLunaLiveFireCutoverPreflight({
  exchange = 'binance',
  hours = 6,
  withPositionParity = true,
} = {}) {
  const [resolution, postVerify, readiness] = await Promise.all([
    buildLunaReconcileResolutionPlan({ exchange, hours }),
    buildLunaPostLiveFireVerification({ exchange, hours }),
    buildLunaLiveFireReadinessGate({ hours }),
  ]);
  const parity = withPositionParity
    ? runJsonCommand('node', ['scripts/runtime-position-parity-report.ts', '--json'])
    : null;
  const parityOk = parityClear(parity);
  const blockers = [
    ...(resolution.ok ? [] : [`reconcile_resolution_required:${resolution.summary?.liveFireBlocking || 0}`]),
    ...(postVerify.ok ? [] : [`post_live_fire_attention:${(postVerify.blockers || []).length}`]),
    ...(readiness.ok ? [] : [`live_fire_readiness_blocked:${(readiness.blockers || []).length}`]),
    ...(withPositionParity && parityOk !== true ? ['position_parity_not_clear'] : []),
  ];
  const alreadyEnabled = readiness?.status === 'live_fire_already_enabled';
  return {
    ok: blockers.length === 0,
    checkedAt: new Date().toISOString(),
    status: blockers.length === 0 ? 'live_fire_cutover_ready' : 'live_fire_cutover_blocked',
    exchange,
    hours,
    withPositionParity,
    blockers,
    resolution: {
      status: resolution.status,
      summary: resolution.summary,
      liveFireBlockingItems: resolution.liveFireBlockingItems || [],
    },
    postVerify: {
      status: postVerify.status,
      blockers: postVerify.blockers || [],
      entryTrigger: postVerify.entryTrigger || {},
      tradeGate: postVerify.tradeGate || {},
    },
    readiness,
    parity: parity ? {
      ok: parity.ok,
      clear: parityOk,
      summary: parity.json?.summary || null,
      command: parity.command,
      status: parity.status,
      stderrTail: parity.stderrTail,
    } : {
      ok: null,
      clear: null,
      skipped: true,
      reason: 'position parity check explicitly skipped; live-fire cutover should normally keep this enabled',
    },
    commands: blockers.length === 0
      ? (alreadyEnabled
        ? ['npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-watchdog']
        : [
            'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-cutover -- --apply --confirm=enable-luna-live-fire',
            'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:luna-live-fire-watchdog',
          ])
      : [],
  };
}

export function renderLunaLiveFireCutoverPreflight(report = {}) {
  return [
    '🚦 Luna live-fire cutover preflight',
    `status: ${report.status || 'unknown'} / exchange=${report.exchange || 'n/a'} / ${report.hours || 6}h`,
    `blockers: ${(report.blockers || []).length ? report.blockers.join(' / ') : 'none'}`,
    `reconcile=${report.resolution?.status || 'unknown'} blocking=${report.resolution?.summary?.liveFireBlocking ?? 'n/a'}`,
    `postVerify=${report.postVerify?.status || 'unknown'} / readiness=${report.readiness?.status || 'unknown'} / parity=${report.parity?.skipped ? 'skipped' : report.parity?.clear}`,
    `next: ${(report.commands || []).length ? report.commands[0] : 'resolve blockers first'}`,
  ].join('\n');
}

export async function publishLunaLiveFireCutoverPreflight(report = {}) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.ok ? 1 : 2,
    message: renderLunaLiveFireCutoverPreflight(report),
    payload: {
      checkedAt: report.checkedAt,
      status: report.status,
      blockers: report.blockers || [],
      resolution: report.resolution,
      postVerify: report.postVerify,
      parity: report.parity,
    },
  });
}

export async function runLunaLiveFireCutoverPreflightSmoke() {
  assert.equal(parityClear({ json: { summary: { ok: 3 } } }), true);
  assert.equal(parityClear({ json: { summary: { quantityMismatch: 1 } } }), false);
  return { ok: true };
}

async function main() {
  const json = hasFlag('--json');
  const smoke = hasFlag('--smoke');
  const telegram = hasFlag('--telegram');
  const withPositionParity = !hasFlag('--skip-position-parity');
  const exchange = argValue('--exchange', 'binance');
  const hours = Number(argValue('--hours', 6));
  const report = smoke ? await runLunaLiveFireCutoverPreflightSmoke() : await buildLunaLiveFireCutoverPreflight({ exchange, hours, withPositionParity });
  if (telegram && !smoke) await publishLunaLiveFireCutoverPreflight(report);
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(smoke ? 'luna live-fire cutover preflight smoke ok' : renderLunaLiveFireCutoverPreflight(report));
  if (!smoke && hasFlag('--fail-on-blocked') && report.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna live-fire cutover preflight 실패:',
  });
}
