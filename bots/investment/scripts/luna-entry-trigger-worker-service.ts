#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaEntryTriggerWorkerReadiness } from './luna-entry-trigger-worker-readiness.ts';

const require = createRequire(import.meta.url);
const { getServiceOwnership, isRetiredService } = require('../../../packages/core/lib/service-ownership');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const LABEL = 'ai.investment.luna-entry-trigger-worker';
const REPO_PLIST = path.join(INVESTMENT_DIR, 'launchd', `${LABEL}.plist`);
const INSTALLED_PLIST = path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `${LABEL}.plist`);

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    install: argv.includes('--install'),
    unload: argv.includes('--unload'),
    status: argv.includes('--status') || (!argv.includes('--install') && !argv.includes('--unload')),
  };
}

function run(command, args = []) {
  const proc = spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: proc.status === 0,
    status: proc.status,
    command: [command, ...args].join(' '),
    stdout: String(proc.stdout || '').trim(),
    stderr: String(proc.stderr || '').trim(),
  };
}

export async function buildLunaEntryTriggerWorkerServicePlan({ install = false, unload = false } = {}) {
  const readiness = await buildLunaEntryTriggerWorkerReadiness();
  const retired = isRetiredService(LABEL);
  const ownership = getServiceOwnership(LABEL);
  const action = install ? 'install' : unload ? 'unload' : 'status';
  const commands = [];
  if (install && retired) {
    commands.push(`retired: ${LABEL} -> ${ownership?.replacement || 'luna.skills.entry_trigger'}`);
  } else if (install) {
    commands.push(`mkdir -p ${path.dirname(INSTALLED_PLIST)}`);
    commands.push(`cp ${REPO_PLIST} ${INSTALLED_PLIST}`);
    commands.push(`launchctl bootstrap gui/$(id -u) ${INSTALLED_PLIST}`);
  } else if (unload) {
    commands.push(`launchctl bootout gui/$(id -u) ${INSTALLED_PLIST}`);
  } else {
    commands.push(`launchctl print gui/$(id -u)/${LABEL}`);
  }
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    action,
    dryRun: true,
    label: LABEL,
    retired,
    replacement: retired ? (ownership?.replacement || 'luna.skills.entry_trigger') : null,
    repoPlist: REPO_PLIST,
    installedPlist: INSTALLED_PLIST,
    commands,
    readiness,
  };
}

export async function runLunaEntryTriggerWorkerService({ install = false, unload = false, apply = false } = {}) {
  const plan = await buildLunaEntryTriggerWorkerServicePlan({ install, unload });
  if (!apply) return plan;
  if (plan.retired && install) {
    return {
      ...plan,
      ok: false,
      applied: false,
      status: 'entry_trigger_worker_retired_install_blocked',
    };
  }
  const results = [];
  if (install) {
    fs.mkdirSync(path.dirname(INSTALLED_PLIST), { recursive: true });
    fs.copyFileSync(REPO_PLIST, INSTALLED_PLIST);
    results.push({ ok: true, command: `cp ${REPO_PLIST} ${INSTALLED_PLIST}` });
    results.push(run('launchctl', ['bootstrap', `gui/${process.getuid?.() || 501}`, INSTALLED_PLIST]));
  } else if (unload) {
    results.push(run('launchctl', ['bootout', `gui/${process.getuid?.() || 501}`, INSTALLED_PLIST]));
  } else {
    results.push(run('launchctl', ['print', `gui/${process.getuid?.() || 501}/${LABEL}`]));
  }
  return {
    ...plan,
    dryRun: false,
    applied: results.every((item) => item.ok),
    results,
  };
}

export async function runLunaEntryTriggerWorkerServiceSmoke() {
  const install = await buildLunaEntryTriggerWorkerServicePlan({ install: true });
  assert.equal(install.action, 'install');
  assert.ok(install.commands.some((command) => command.includes('launchctl bootstrap')));
  const unload = await buildLunaEntryTriggerWorkerServicePlan({ unload: true });
  assert.equal(unload.action, 'unload');
  assert.ok(unload.commands.some((command) => command.includes('launchctl bootout')));
  return { ok: true, install, unload };
}

async function main() {
  const args = parseArgs();
  const result = await runLunaEntryTriggerWorkerService(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`luna entry-trigger worker service — ${result.action} (${result.dryRun ? 'dry-run' : 'apply'})`);
    for (const command of result.commands || []) console.log(`- ${command}`);
    if (result.applied != null) console.log(`applied: ${result.applied}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger worker service 실패:',
  });
}
