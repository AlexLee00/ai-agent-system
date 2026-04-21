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

function buildTargetQueue(payload, preferredLabel = '') {
  const runPlan = Array.isArray(payload?.runPlan) ? payload.runPlan : [];
  if (!preferredLabel) return runPlan;
  const preferred = runPlan.find((item) => String(item?.label || '') === preferredLabel);
  const rest = runPlan.filter((item) => String(item?.label || '') !== preferredLabel);
  return preferred ? [preferred, ...rest] : runPlan;
}

function looksIdleOutput(output = '') {
  const text = String(output || '');
  return (
    /detected=0\b/.test(text)
    && /pending=0\b/.test(text)
    && (
      /replied=0\b/.test(text)
      || /posted=0\b/.test(text)
      || /liked=0\b/.test(text)
    )
    && /failed=0\b/.test(text)
  );
}

function executeTargetCommand(command = '') {
  const output = execFileSync('zsh', ['-lc', command], {
    cwd: BLOG_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(output);
  return output;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = runDoctor();
  const targetQueue = buildTargetQueue(payload, args.label);
  const target = targetQueue[0] || null;

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

  let executedTarget = null;
  let nextEscalated = false;

  for (const candidate of targetQueue) {
    const output = executeTargetCommand(candidate.command);
    executedTarget = candidate;
    if (!looksIdleOutput(output)) {
      break;
    }
    if (candidate !== targetQueue[targetQueue.length - 1]) {
      nextEscalated = true;
      console.log(`[blog engagement gap runner] ${candidate.label} currently idle, escalate to next gap...`);
    }
  }

  result.label = executedTarget?.label || result.label;
  result.summary = executedTarget?.summary || result.summary;
  result.command = executedTarget?.command || result.command;
  result.escalated = nextEscalated;

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log('[blog engagement gap runner]');
  console.log(`target: ${result.label} ${result.summary}`);
  console.log(`command: ${result.command}`);
  if (result.escalated) {
    console.log('note: earlier gap target had no immediate workload, so the runner escalated to the next gap.');
  }
}

main();
