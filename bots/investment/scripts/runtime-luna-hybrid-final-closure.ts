#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { query as defaultQuery } from '../shared/db.ts';
import {
  buildLunaHybridFinalClosureReport,
  LUNA_HYBRID_PHASE12,
  LUNA_PROTECTED_6,
} from '../shared/luna-hybrid-final-closure.ts';
import { runLunaHybridPromotionReview } from './runtime-luna-hybrid-promotion-review.ts';
import { buildLunaBottleneckAutonomyReport } from './runtime-luna-bottleneck-autonomy-operator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type FinalClosureOptions = {
  apply?: boolean;
  json?: boolean;
  strict?: boolean;
  noDb?: boolean;
  noExec?: boolean;
  hours: number;
};

type FinalClosureDeps = {
  phase11Report?: unknown;
  queryFn?: unknown;
  investmentRoot?: string;
  bottleneckReport?: unknown;
  protectedPidStatus?: unknown;
};

function argValue(name: string, fallback: string | number | null = null, argv: string[] = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(argv: string[] = process.argv.slice(2)): FinalClosureOptions {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    noDb: argv.includes('--no-db'),
    noExec: argv.includes('--no-exec'),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
  };
}

export function getProtectedPidStatus() {
  let output = '';
  try {
    output = execFileSync('launchctl', ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    return {
      source: 'launchctl_list_failed',
      visibleLabels: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    source: 'launchctl_list',
    visibleLabels: LUNA_PROTECTED_6.filter((label) => output.includes(label)),
  };
}

export async function runLunaHybridFinalClosure(options: FinalClosureOptions = parseArgs(), deps: FinalClosureDeps = {}) {
  if (options.apply) {
    return {
      ok: false,
      phase: LUNA_HYBRID_PHASE12,
      status: 'luna_hybrid_final_closure_apply_blocked',
      shadowMode: true,
      finalClosureReady: false,
      masterApprovalRequired: true,
      promotionReady: false,
      liveMutation: false,
      protectedPidMutation: false,
      blockers: [{
        type: 'safety',
        name: 'apply_not_supported',
        detail: 'Phase 12 final closure is read-only; live promotion requires a separate explicit master approval path.',
      }],
    };
  }

  const phase11Report = deps.phase11Report || await runLunaHybridPromotionReview({
    json: true,
    strict: false,
    noDb: options.noDb || options.noExec,
    hours: options.hours,
  } as any, { queryFn: deps.queryFn || defaultQuery } as any);

  if (options.noExec) {
    return buildLunaHybridFinalClosureReport({
      noExec: true,
      phase11Report,
      investmentRoot: deps.investmentRoot,
    });
  }

  const bottleneckReport = deps.bottleneckReport || await buildLunaBottleneckAutonomyReport({
    hours: Math.min(options.hours, 24),
    includeRealtime: true,
    includeFinalGate: true,
    includePostLive: true,
  });
  const protectedPidStatus = deps.protectedPidStatus || getProtectedPidStatus();
  return buildLunaHybridFinalClosureReport({
    noExec: false,
    phase11Report,
    bottleneckReport,
    protectedPidStatus,
    investmentRoot: deps.investmentRoot,
  });
}

async function main() {
  const options = parseArgs();
  const report = await runLunaHybridFinalClosure(options);
  if (options.strict && !report.ok) {
    process.exitCode = 1;
  }
  if (options.apply) {
    process.exitCode = 2;
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.status} finalClosureReady=${report.finalClosureReady === true} promotionReady=${report.promotionReady === true}`);
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna hybrid final closure failed:',
  });
}

export default { runLunaHybridFinalClosure };
