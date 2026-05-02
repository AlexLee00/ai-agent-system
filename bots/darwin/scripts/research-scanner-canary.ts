#!/usr/bin/env tsx
// @ts-nocheck
'use strict';

const scanner = require('../lib/research-scanner');

interface CanaryArgs {
  json?: boolean;
  smoke?: boolean;
  maxDomains?: number;
  maxEvaluations?: number;
}

function parseArgs(argv: string[]): CanaryArgs {
  const out: CanaryArgs = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') out.json = true;
    else if (arg === '--smoke') out.smoke = true;
    else if (arg === '--max-domains') {
      out.maxDomains = Number.parseInt(String(argv[++index] || ''), 10);
    } else if (arg.startsWith('--max-domains=')) {
      out.maxDomains = Number.parseInt(arg.split('=').slice(1).join('='), 10);
    } else if (arg === '--max-evaluations') {
      out.maxEvaluations = Number.parseInt(String(argv[++index] || ''), 10);
    } else if (arg.startsWith('--max-evaluations=')) {
      out.maxEvaluations = Number.parseInt(arg.split('=').slice(1).join('='), 10);
    }
  }
  return out;
}

function safePositive(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function summarize(result: any, startedAt: number, smoke = false) {
  return {
    ok: Boolean(result?.dryRun && Number(result?.total || 0) >= 0 && Number(result?.evaluated || 0) >= 0),
    mode: smoke ? 'smoke_fixture' : 'dry_run_canary',
    dryRun: Boolean(result?.dryRun),
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    scanner: {
      totalRaw: Number(result?.totalRaw || 0),
      total: Number(result?.total || 0),
      evaluated: Number(result?.evaluated || 0),
      stored: Number(result?.stored || 0),
      alarmSent: Boolean(result?.alarmSent),
      highRelevance: Number(result?.highRelevance || 0),
      evaluationFailures: Number(result?.evaluationFailures || 0),
      searchers: Array.isArray(result?.searchers) ? result.searchers.length : 0,
    },
    safety: {
      dbWritesExpected: false,
      telegramExpected: false,
      proposalApplyExpected: false,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  const maxDomains = safePositive(args.maxDomains, 1, 3);
  const maxEvaluations = safePositive(args.maxEvaluations, 2, 5);
  const result = args.smoke
    ? {
        dryRun: true,
        totalRaw: 2,
        total: 2,
        evaluated: 2,
        stored: 0,
        alarmSent: false,
        highRelevance: 1,
        evaluationFailures: 0,
        searchers: [{ name: 'fixture', domain: 'agents', score: 0, hired: false }],
      }
    : await scanner.run({ dryRun: true, maxDomains, maxEvaluations });
  const report = summarize(result, startedAt, Boolean(args.smoke));
  if (args.json || process.env.DARWIN_RESEARCH_CANARY_JSON === '1') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[darwin research canary] ${report.ok ? 'ok' : 'not-ok'} mode=${report.mode} evaluated=${report.scanner.evaluated} total=${report.scanner.total}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[research-scanner-canary] failed:', error?.message || error);
  process.exitCode = 1;
});
