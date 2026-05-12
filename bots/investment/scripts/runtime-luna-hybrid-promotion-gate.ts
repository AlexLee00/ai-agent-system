#!/usr/bin/env node

import { query as defaultQuery } from '../shared/db.ts';
import { buildLunaHybridPromotionGateReport } from '../shared/luna-hybrid-promotion-gate.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    noDb: argv.includes('--no-db'),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
  };
}

export async function runLunaHybridPromotionGate(options = parseArgs(), deps = {}) {
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

  const queryFn = options.noDb ? null : deps.queryFn || defaultQuery;
  return buildLunaHybridPromotionGateReport({
    queryFn,
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
  console.log(`${report.status} contractReady=${report.contractReady === true} dataReady=${report.dataReady === true}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna hybrid promotion gate failed:',
  });
}

export default { runLunaHybridPromotionGate };
