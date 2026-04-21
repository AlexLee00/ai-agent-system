#!/usr/bin/env node
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const DOCTOR_COMMAND = `npm --prefix ${BLOG_ROOT} run doctor:engagement -- --json`;

function parseArgs(argv = []) {
  const args = {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
    label: '',
  };

  for (const arg of argv) {
    if (arg.startsWith('--label=')) {
      args.label = arg.slice('--label='.length).trim();
    }
  }

  return args;
}

function runDoctor() {
  const output = execFileSync('zsh', ['-lc', DOCTOR_COMMAND], {
    cwd: BLOG_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const jsonStart = output.indexOf('{');
  const candidate = jsonStart >= 0 ? output.slice(jsonStart) : output;
  return JSON.parse(candidate || '{}');
}

function pickRunTarget(payload, preferredLabel = '') {
  const runPlan = Array.isArray(payload?.runPlan) ? payload.runPlan : [];
  if (!preferredLabel) return runPlan[0] || null;
  return runPlan.find((item) => String(item?.label || '') === preferredLabel) || null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = runDoctor();
  const target = pickRunTarget(payload, args.label);

  if (!target?.command) {
    const result = {
      ok: false,
      reason: '실행 가능한 engagement gap target이 없습니다.',
      primary: payload?.primary || null,
      runPlan: payload?.runPlan || [],
    };
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('[blog engagement gap runner]');
    console.log('실행 가능한 target이 없습니다.');
    return;
  }

  const result = {
    ok: true,
    label: target.label,
    summary: target.summary,
    command: target.command,
    primary: payload?.primary || null,
    dryRun: args.dryRun,
  };

  if (args.dryRun) {
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log('[blog engagement gap runner]');
    console.log(`target: ${target.label} ${target.summary}`);
    console.log(`command: ${target.command}`);
    return;
  }

  execFileSync('zsh', ['-lc', target.command], {
    cwd: BLOG_ROOT,
    stdio: 'inherit',
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('[blog engagement gap runner]');
  console.log(`target: ${target.label} ${target.summary}`);
  console.log(`command: ${target.command}`);
}

main();
