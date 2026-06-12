#!/usr/bin/env tsx
// @ts-nocheck

import { createRequire } from 'node:module';
import {
  buildHubLlmPromotionApplyBlockedReport,
  buildHubLlmPromotionGateReport,
  type HubLlmPromotionGateQueryFn,
  type HubLlmPromotionGateReport,
  type HubLlmPromotionGateSelector,
} from '../lib/hub-llm-promotion-gate.ts';

const require = createRequire(import.meta.url);

type RuntimeArgs = {
  apply: boolean;
  json: boolean;
  strict: boolean;
  noDb: boolean;
  hours: number;
  gate: HubLlmPromotionGateSelector;
  invalidGate: string | null;
};

type RuntimeDeps = {
  queryFn?: HubLlmPromotionGateQueryFn;
  argv?: string[];
};

const DEFAULT_HOURS = 168;
const VALID_GATES = new Set(['GATE-H', 'GATE-H3', 'all']);

export function parseHubLlmPromotionGateArgs(argv = process.argv.slice(2)): RuntimeArgs {
  let hours = DEFAULT_HOURS;
  let gate: HubLlmPromotionGateSelector = 'GATE-H';
  let invalidGate: string | null = null;
  const args: RuntimeArgs = {
    apply: false,
    json: false,
    strict: false,
    noDb: false,
    hours,
    gate,
    invalidGate,
  };

  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--no-db') args.noDb = true;
    else if (arg.startsWith('--hours=')) {
      const parsed = Math.floor(Number(arg.slice('--hours='.length)));
      if (Number.isFinite(parsed) && parsed > 0) hours = Math.min(parsed, 24 * 31);
    } else if (arg.startsWith('--gate=')) {
      const rawGate = arg.slice('--gate='.length);
      if (VALID_GATES.has(rawGate)) gate = rawGate as HubLlmPromotionGateSelector;
      else invalidGate = rawGate || '(empty)';
    }
  }

  args.hours = hours;
  args.gate = gate;
  args.invalidGate = invalidGate;
  return args;
}

export async function runHubLlmPromotionGateRuntime(deps: RuntimeDeps = {}): Promise<{ report: HubLlmPromotionGateReport; exitCode: number }> {
  const args = parseHubLlmPromotionGateArgs(deps.argv);
  if (args.apply) {
    return {
      report: buildHubLlmPromotionApplyBlockedReport({ hours: args.hours, gate: args.gate }),
      exitCode: 2,
    };
  }

  if (args.invalidGate) {
    const report = buildInvalidGateReport(args);
    return {
      report,
      exitCode: args.strict ? 1 : 0,
    };
  }

  const queryFn = args.noDb ? null : deps.queryFn || buildRuntimeQueryFn();
  const report = await buildHubLlmPromotionGateReport({
    queryFn,
    hours: args.hours,
    gate: args.gate,
    noDb: args.noDb,
  });
  return {
    report,
    exitCode: args.strict && !report.ok ? 1 : 0,
  };
}

function buildRuntimeQueryFn(): HubLlmPromotionGateQueryFn {
  const pgPool = require('../../../packages/core/lib/pg-pool');
  return async (sql: string, params: unknown[] = []) => {
    assertReadOnlySql(sql);
    return pgPool.query('public', sql, params);
  };
}

function assertReadOnlySql(sql: string): void {
  const normalized = String(sql || '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error('hub_llm_promotion_gate_read_only_violation: only SELECT/WITH statements are allowed');
  }
  if (/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|merge|copy|call)\b/i.test(normalized)) {
    throw new Error('hub_llm_promotion_gate_read_only_violation: mutating SQL keyword detected');
  }
}

function buildInvalidGateReport(args: RuntimeArgs): HubLlmPromotionGateReport {
  const blocker = {
    gate: 'all' as const,
    type: 'contract' as const,
    name: 'invalid_gate',
    detail: `Invalid gate '${args.invalidGate}'. Expected GATE-H, GATE-H3, or all.`,
    observed: args.invalidGate,
    threshold: ['GATE-H', 'GATE-H3', 'all'],
  };
  return {
    ok: false,
    status: 'blocked',
    selectedGate: args.gate,
    gates: { 'GATE-H': 'blocked', 'GATE-H3': 'blocked' },
    hours: args.hours,
    generatedAt: new Date().toISOString(),
    shadowMode: true,
    liveMutation: false,
    promotionReady: false,
    manualPromotionReviewCandidate: false,
    notifyMasterReview: false,
    notificationPayload: null,
    contractChecks: [],
    evidenceChecks: [],
    blockers: [blocker],
    metrics: { invalidGate: args.invalidGate },
  };
}

function printReport(report: HubLlmPromotionGateReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const blockerSummary = report.blockers.length > 0
    ? ` blockers=${report.blockers.map((blocker) => `${blocker.gate}:${blocker.name}`).join(',')}`
    : '';
  console.log(`[hub-llm-promotion-gate] status=${report.status} ok=${report.ok} gate=${report.selectedGate} promotionReady=${report.promotionReady}${blockerSummary}`);
  if (report.notifyMasterReview) {
    console.log(`[hub-llm-promotion-gate] notifyMasterReview=${JSON.stringify(report.notificationPayload)}`);
  }
}

async function main(): Promise<void> {
  const args = parseHubLlmPromotionGateArgs();
  const { report, exitCode } = await runHubLlmPromotionGateRuntime({ argv: process.argv.slice(2) });
  printReport(report, args.json);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((error) => {
    const report: HubLlmPromotionGateReport = {
      ok: false,
      status: 'blocked',
      selectedGate: 'GATE-H',
      gates: { 'GATE-H': 'blocked', 'GATE-H3': 'blocked' },
      hours: DEFAULT_HOURS,
      generatedAt: new Date().toISOString(),
      shadowMode: true,
      liveMutation: false,
      promotionReady: false,
      manualPromotionReviewCandidate: false,
      notifyMasterReview: false,
      notificationPayload: null,
      contractChecks: [],
      evidenceChecks: [],
      blockers: [{
        gate: 'all',
        type: 'safety',
        name: 'runtime_error',
        detail: error?.message || String(error),
      }],
      metrics: {},
    };
    printReport(report, process.argv.includes('--json'));
    process.exitCode = 1;
  });
}
