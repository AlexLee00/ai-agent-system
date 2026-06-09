#!/usr/bin/env node

import { query as defaultQuery } from '../shared/db.ts';
import { buildLunaHybridPromotionGateReport } from '../shared/luna-hybrid-promotion-gate.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

type PromotionGateOptions = {
  apply: boolean;
  json: boolean;
  strict: boolean;
  noDb: boolean;
  hours: number;
};
type PromotionGateDeps = {
  queryFn?: (sql: string, params?: unknown[]) => Promise<unknown> | unknown;
  investmentRoot?: string;
  projectRoot?: string;
};

type PromotionGateQueryFn = (sql: string, params?: unknown[]) => Promise<unknown> | unknown;

function argValue(name: string, fallback: string | number | null = null, argv: string[] = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(argv: string[] = process.argv.slice(2)): PromotionGateOptions {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    noDb: argv.includes('--no-db'),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
  };
}

export async function runLunaHybridPromotionGate(options: PromotionGateOptions = parseArgs(), deps: PromotionGateDeps = {}) {
  if (options.apply) {
    return {
      ok: false,
      phase: 'phase10_hybrid_promotion_gate',
      status: 'luna_hybrid_promotion_gate_apply_blocked',
      shadowMode: true,
      liveMutation: false,
      promotionReady: false,
      blockers: [{
        type: 'safety',
        name: 'apply_not_supported',
        detail: 'Phase 10 gate is read-only; promotion requires separate master-approved runbook.',
      }],
    };
  }

  const queryFn = options.noDb ? undefined : deps.queryFn || (defaultQuery as PromotionGateQueryFn);
  return buildLunaHybridPromotionGateReport({
    queryFn,
    dataRequired: !options.noDb,
    hours: options.hours,
    investmentRoot: deps.investmentRoot,
    projectRoot: deps.projectRoot,
  });
}

async function main() {
  const options = parseArgs();
  const report = await runLunaHybridPromotionGate(options);
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
  const typedReport = report as any;
  console.log(`${typedReport.status} contractReady=${typedReport.contractReady === true} dataReady=${typedReport.dataReady === true}`);
}

if (isDirectExecution(import.meta.url)) {
  await (runCliMain as any)({
    run: main,
    errorPrefix: 'luna hybrid promotion gate failed:',
  });
}

export default { runLunaHybridPromotionGate };
