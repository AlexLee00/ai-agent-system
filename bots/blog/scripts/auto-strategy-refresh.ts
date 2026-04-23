#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('../../../packages/core/lib/env');

const BLOG_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'blog');
const OPS_DIR = path.join(BLOG_ROOT, 'output', 'ops');
const RESULT_PATH = path.join(OPS_DIR, 'marketing-strategy-refresh.json');

function parseArgs(argv = []) {
  return {
    json: argv.includes('--json'),
    dryRun: argv.includes('--dry-run'),
  };
}

function ensureOpsDir() {
  if (!fs.existsSync(OPS_DIR)) fs.mkdirSync(OPS_DIR, { recursive: true });
}

function runStep(label, command) {
  const startedAt = new Date().toISOString();
  try {
    const output = execFileSync('zsh', ['-lc', command], {
      cwd: BLOG_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return {
      label,
      command,
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      output,
    };
  } catch (error) {
    return {
      label,
      command,
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      output: String(error?.stdout || '').trim(),
      error: String(error?.stderr || error?.message || error).trim(),
    };
  }
}

function persistResult(payload) {
  ensureOpsDir();
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const steps = [
    {
      label: 'marketing_experiments',
      command: `node ${path.join(BLOG_ROOT, 'scripts/refresh-marketing-experiments.ts')} --json${args.dryRun ? ' --dry-run' : ''}`,
    },
    {
      label: 'channel_insights',
      command: `node ${path.join(BLOG_ROOT, 'scripts/channel-insights-collector.ts')} --json${args.dryRun ? ' --dry-run' : ''}`,
    },
    {
      label: 'marketing_snapshot',
      command: `node ${path.join(BLOG_ROOT, 'scripts/marketing-snapshot.ts')} --json${args.dryRun ? ' --dry-run' : ''}`,
    },
    {
      label: 'revenue_strategy',
      command: `node ${path.join(BLOG_ROOT, 'scripts/revenue-strategy-updater.ts')} --json${args.dryRun ? ' --dry-run' : ''}`,
    },
  ];

  const startedAt = new Date().toISOString();
  const results = steps.map((step) => runStep(step.label, step.command));
  const failedStep = results.find((item) => !item.ok) || null;
  const payload = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    ok: !failedStep,
    failedStep: failedStep?.label || null,
    strategyPath: path.join(BLOG_ROOT, 'output', 'strategy', 'latest-strategy.json'),
    experimentPlaybookPath: path.join(BLOG_ROOT, 'output', 'ops', 'marketing-experiment-playbook.json'),
    steps: results.map((item) => ({
      label: item.label,
      command: item.command,
      ok: item.ok,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      error: item.error || '',
    })),
  };

  if (!args.dryRun) {
    persistResult(payload);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(payload.ok ? 0 : 1);
  }

  console.log(`[blog auto-strategy-refresh] dryRun=${args.dryRun} ok=${payload.ok} failedStep=${payload.failedStep || 'none'}`);
  process.exit(payload.ok ? 0 : 1);
}

main().catch((error) => {
  const payload = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun: process.argv.includes('--dry-run'),
    ok: false,
    failedStep: 'bootstrap',
    strategyPath: path.join(BLOG_ROOT, 'output', 'strategy', 'latest-strategy.json'),
    steps: [],
    error: String(error?.message || error),
  };
  if (!payload.dryRun) persistResult(payload);
  console.error('[blog auto-strategy-refresh] 실패:', payload.error);
  process.exit(1);
});
