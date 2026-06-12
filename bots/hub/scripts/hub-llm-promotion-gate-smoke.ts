#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildHubLlmPromotionGateReport,
  type HubLlmPromotionGateQueryFn,
  type HubLlmPromotionGateReport,
} from '../lib/hub-llm-promotion-gate.ts';
import { runHubLlmPromotionGateRuntime } from './runtime-hub-llm-promotion-gate.ts';

type SmokeResult = {
  id: string;
  name: string;
  pass: boolean;
  evidence: string;
};

const reports: HubLlmPromotionGateReport[] = [];
const results: SmokeResult[] = [];

function makeFixture({ includeContracts = true }: { includeContracts?: boolean } = {}): { packageJsonPath: string; sourceFiles: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-promotion-gate-'));
  const packageJsonPath = path.join(dir, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({
    scripts: includeContracts ? {
      'check:llm-stage-a': 'fixture',
      'llm:stage-a-selector-smoke': 'fixture',
      'llm:stage-a-request-log-smoke': 'fixture',
      'llm:stage-a-protected-secrets-smoke': 'fixture',
    } : {},
  }, null, 2));
  const sourcePath = path.join(dir, 'source.ts');
  fs.writeFileSync(sourcePath, includeContracts
    ? [
      'const HUB_LLM_RATELIMIT_COOLDOWN_ENABLED = true;',
      'const HUB_LLM_RATELIMIT_COOLDOWN_MIN_MS = 30000;',
      'function isRateLimitCoolingDown() { return false; }',
      'const HUB_LLM_DYNAMIC_BUDGET_ENABLED = false;',
    ].join('\n')
    : 'const missing = true;\n');
  return { packageJsonPath, sourceFiles: [sourcePath] };
}

function gateHEvidenceQuery(overrides: Record<string, unknown> = {}): HubLlmPromotionGateQueryFn {
  const row = {
    darwin_failure_count: 2,
    darwin_failed_avg_duration_ms: 12_000,
    local_general_calls: 0,
    darwin_total_count: 100,
    darwin_unknown_purpose_count: 3,
    ...overrides,
  };
  return async (sql: string) => {
    if (sql.includes('hub_llm_gate:gate_h_evidence')) return [row];
    if (sql.includes('hub_llm_gate:schema_columns')) return [];
    throw new Error(`unexpected query in smoke: ${sql.slice(0, 80)}`);
  };
}

function gateH3EvidenceQuery(): HubLlmPromotionGateQueryFn {
  const columns = [
    'created_at',
    'caller_team',
    'task_type',
    'selector_key',
    'timeout_ms',
    'duration_ms',
    'metadata',
  ];
  return async (sql: string) => {
    if (sql.includes('hub_llm_gate:schema_columns')) return columns.map((column_name) => ({ column_name }));
    if (sql.includes('hub_llm_gate:gate_h3_evidence')) {
      assert(!sql.includes("status <> 'ok'"), 'H3 regression query must not assume ok is the success status');
      assert(sql.includes("'success'") && sql.includes("'cache_hit'"), 'H3 regression query must allow recorded success statuses');
      return [{
        shadow_sample_count: 1000,
        timeout_under_actual_ratio: 0,
        blog_longform_regression_count: 0,
      }];
    }
    throw new Error(`unexpected query in smoke: ${sql.slice(0, 80)}`);
  };
}

function gateREvidenceQuery({ total = 50, mismatches = 0 }: { total?: number; mismatches?: number } = {}): HubLlmPromotionGateQueryFn {
  return async (sql: string) => {
    if (sql.includes('hub_llm_gate:gate_r_evidence')) {
      return [{ shadow_total_count: total, shadow_mismatch_count: mismatches }];
    }
    throw new Error(`unexpected query in GATE-R smoke: ${sql.slice(0, 80)}`);
  };
}

async function record(id: string, name: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const evidence = await fn();
    results.push({ id, name, pass: true, evidence });
  } catch (error) {
    results.push({ id, name, pass: false, evidence: error?.stack || error?.message || String(error) });
  }
}

async function main(): Promise<void> {
  await record('TS-G1', '--apply is permanently blocked', async () => {
    const { report, exitCode } = await runHubLlmPromotionGateRuntime({ argv: ['--apply', '--json'] });
    reports.push(report);
    assert.equal(exitCode, 2);
    assert.equal(report.ok, false);
    assert.equal(report.status, 'hub_llm_promotion_gate_apply_blocked');
    assert.equal(report.promotionReady, false);
    return `exit=${exitCode} status=${report.status}`;
  });

  await record('TS-G2', 'evidence OK reaches ready_for_master_review', async () => {
    const fixture = makeFixture({ includeContracts: true });
    const report = await buildHubLlmPromotionGateReport({
      gate: 'GATE-H',
      hours: 168,
      packageJsonPath: fixture.packageJsonPath,
      sourceFiles: fixture.sourceFiles,
      queryFn: gateHEvidenceQuery(),
    });
    reports.push(report);
    assert.equal(report.status, 'ready_for_master_review');
    assert.equal(report.ok, true);
    assert.equal(report.manualPromotionReviewCandidate, true);
    assert.equal(report.notifyMasterReview, true);
    assert.equal(report.promotionReady, false);
    return `status=${report.status} blockers=${report.blockers.length}`;
  });

  await record('TS-G3', 'evidence fail stays shadow_ready_data_pending', async () => {
    const fixture = makeFixture({ includeContracts: true });
    const report = await buildHubLlmPromotionGateReport({
      gate: 'GATE-H',
      hours: 168,
      packageJsonPath: fixture.packageJsonPath,
      sourceFiles: fixture.sourceFiles,
      queryFn: gateHEvidenceQuery({ local_general_calls: 1 }),
    });
    reports.push(report);
    assert.equal(report.status, 'shadow_ready_data_pending');
    assert(report.blockers.some((blocker) => blocker.type === 'evidence' && blocker.name === 'local_general_calls'));
    assert.equal(report.promotionReady, false);
    return `status=${report.status} blockers=${report.blockers.map((blocker) => blocker.name).join(',')}`;
  });

  await record('TS-G4', 'missing contract blocks gate', async () => {
    const fixture = makeFixture({ includeContracts: false });
    const report = await buildHubLlmPromotionGateReport({
      gate: 'GATE-H',
      hours: 168,
      packageJsonPath: fixture.packageJsonPath,
      sourceFiles: fixture.sourceFiles,
      queryFn: gateHEvidenceQuery(),
    });
    reports.push(report);
    assert.equal(report.status, 'blocked');
    assert(report.blockers.some((blocker) => blocker.type === 'contract'));
    assert.equal(report.promotionReady, false);
    return `status=${report.status} contractBlockers=${report.blockers.filter((blocker) => blocker.type === 'contract').length}`;
  });

  await record('TS-G5', 'promotionReady never becomes true', () => {
    assert(reports.length >= 4, 'expected reports from TS-G1~G4');
    assert(reports.every((report) => report.promotionReady === false));
    return `checkedReports=${reports.length}`;
  });

  await record('TS-G6', 'GATE-H3 treats success/cache_hit as non-regression', async () => {
    const fixture = makeFixture({ includeContracts: true });
    const report = await buildHubLlmPromotionGateReport({
      gate: 'GATE-H3',
      hours: 168,
      packageJsonPath: fixture.packageJsonPath,
      sourceFiles: fixture.sourceFiles,
      queryFn: gateH3EvidenceQuery(),
    });
    reports.push(report);
    assert.equal(report.status, 'ready_for_master_review');
    assert.equal(report.promotionReady, false);
    assert.equal(report.metrics['GATE-H3']?.blog_longform_regression_count, 0);
    return `status=${report.status} blogLongformRegression=${report.metrics['GATE-H3']?.blog_longform_regression_count}`;
  });

  await record('TS-G7', 'GATE-R contract and evidence reach master-review candidate', async () => {
    const report = await buildHubLlmPromotionGateReport({
      gate: 'GATE-R',
      hours: 168,
      queryFn: gateREvidenceQuery(),
    });
    reports.push(report);
    assert.equal(report.status, 'ready_for_master_review');
    assert.equal(report.ok, true);
    assert.equal(report.promotionReady, false);
    assert.equal(report.metrics['GATE-R']?.shadow_total_count, 50);
    assert.equal(report.metrics['GATE-R']?.shadow_mismatch_count, 0);
    return `status=${report.status} total=${report.metrics['GATE-R']?.shadow_total_count}`;
  });

  const failed = results.filter((result) => !result.pass);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    suite: 'hub-llm-promotion-gate-smoke',
    results,
  }, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
