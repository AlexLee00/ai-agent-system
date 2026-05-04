#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');
const { readDevelopmentBaseline } = require('../lib/dev-baseline.ts');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots/blog');
const BLOG_OPS_ROOT = path.join(BLOG_ROOT, 'output', 'ops');
const ENGAGEMENT_GAP_RUN_PATH = path.join(BLOG_OPS_ROOT, 'engagement-gap-run.json');
const DOCTOR_COMMAND = `npm --prefix ${BLOG_ROOT} run doctor:engagement -- --json`;
const RUN_REVENUE_STRATEGY_COMMAND = `npm --prefix ${BLOG_ROOT} run revenue:strategy -- --dry-run --json`;

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

function buildLowExposureStrategyTarget(payload = {}) {
  const exposureSignal = payload?.exposureSignal && typeof payload.exposureSignal === 'object'
    ? payload.exposureSignal
    : null;
  const primary = payload?.primary && typeof payload.primary === 'object' ? payload.primary : null;
  const primaryArea = String(primary?.area || '');
  const signalCode = String(exposureSignal?.code || '').trim()
    || (exposureSignal?.needsStrategy || primaryArea === 'engagement.strategy.visibility' ? 'low_exposure_accumulated' : '');
  const needsStrategy = Boolean(exposureSignal?.needsStrategy)
    || signalCode === 'low_exposure_accumulated'
    || primaryArea === 'engagement.strategy.visibility';
  if (!needsStrategy) return null;

  return {
    step: 999,
    label: 'low_exposure_strategy',
    summary: `low_exposure_accumulated strategy fallback: inbound=${Number(exposureSignal?.totalInbound || 0)} / noInboundDays=${Number(exposureSignal?.daysWithNoInbound || 0)}`,
    deficit: Number(exposureSignal?.daysWithNoInbound || 0),
    command: String(primary?.nextCommand || '').trim() || RUN_REVENUE_STRATEGY_COMMAND,
    signalCode: signalCode || 'low_exposure_accumulated',
    source: 'engagement_exposure_signal',
  };
}

function buildTargetQueue(payload, preferredLabel = '') {
  const runPlan = Array.isArray(payload?.runPlan) ? [...payload.runPlan] : [];
  const lowExposureTarget = buildLowExposureStrategyTarget(payload);
  const queue = lowExposureTarget
    ? [
        ...runPlan,
        ...(
          runPlan.some((item) => String(item?.label || '') === lowExposureTarget.label)
            ? []
            : [lowExposureTarget]
        ),
      ]
    : runPlan;
  if (!preferredLabel) return queue;
  const preferred = queue.find((item) =>
    String(item?.label || '') === preferredLabel
    || String(item?.signalCode || '') === preferredLabel
  );
  const rest = queue.filter((item) => item !== preferred);
  return preferred ? [preferred, ...rest] : queue;
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

function persistRunResult(result = {}) {
  try {
    fs.mkdirSync(BLOG_OPS_ROOT, { recursive: true });
    fs.writeFileSync(ENGAGEMENT_GAP_RUN_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`[blog engagement gap runner] failed to persist run result: ${String(error?.message || error)}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = runDoctor();
  const developmentBaseline = readDevelopmentBaseline();
  const targetQueue = buildTargetQueue(payload, args.label);
  const target = targetQueue[0] || null;

  if (!target?.command) {
    const result = {
      ok: false,
      reason: '실행 가능한 engagement gap target이 없습니다.',
      primary: payload?.primary || null,
      exposureSignal: payload?.exposureSignal || null,
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
    signalCode: target.signalCode || null,
    primary: payload?.primary || null,
    exposureSignal: payload?.exposureSignal || null,
    dryRun: args.dryRun,
    attempted: [],
    executedAt: new Date().toISOString(),
    developmentBaseline: developmentBaseline
      ? {
          startedAt: developmentBaseline.startedAtIso,
          source: developmentBaseline.source,
        }
      : null,
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
  let allIdle = true;

  for (const candidate of targetQueue) {
    const output = executeTargetCommand(candidate.command);
    const idle = looksIdleOutput(output);
    result.attempted.push({
      label: candidate.label,
      summary: candidate.summary,
      command: candidate.command,
      signalCode: candidate.signalCode || null,
      idle,
    });
    executedTarget = candidate;
    if (!idle) {
      allIdle = false;
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
  result.signalCode = executedTarget?.signalCode || result.signalCode || null;
  result.escalated = nextEscalated;
  result.allIdle = allIdle;
  if (allIdle) {
    result.idleReason = '모든 engagement gap target에 즉시 처리할 workload가 없습니다.';
  }
  persistRunResult(result);

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
  if (result.allIdle) {
    console.log(`idle: ${result.idleReason}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  buildLowExposureStrategyTarget,
  pickRunTarget,
  buildTargetQueue,
  looksIdleOutput,
};
