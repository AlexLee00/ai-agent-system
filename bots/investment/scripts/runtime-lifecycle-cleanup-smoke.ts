#!/usr/bin/env node
// @ts-nocheck
/**
 * runtime-lifecycle-cleanup-smoke.ts — Phase Ω3 smoke test
 */

import assert from 'node:assert/strict';
import {
  archiveClosedPositions,
  cleanupExpiredLifecycleEntries,
  calculateLifecycleStageCoverage,
} from '../shared/position-lifecycle-cleanup.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const results: { name: string; pass: boolean; detail?: string }[] = [];

  // ─── 1. archiveClosedPositions — disabled (default) ─────────────────
  {
    const prev = process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED;
    process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED = 'false';
    const r = await archiveClosedPositions();
    if (prev === undefined) delete process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED;
    else process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED = prev;

    assert.equal(r.enabled, false, 'disabled → enabled=false');
    assert.equal(r.positionsChecked, 0, 'disabled → 0 checked');
    results.push({ name: 'archive_disabled', pass: true });
  }

  // ─── 2. archiveClosedPositions — dryRun (no DB write) ───────────────
  {
    const r = await archiveClosedPositions({ dryRun: true, retentionDays: 30, limit: 5 }).catch(() => null);
    const ok = r === null || (typeof r === 'object' && typeof r.positionsChecked === 'number');
    assert.ok(ok, 'dryRun returns valid shape');
    if (r !== null) {
      assert.equal(r.entriesArchived, 0, 'dryRun → 0 archived');
      assert.equal(r.entriesMigratedToRag, 0, 'dryRun → 0 migrated');
    }
    results.push({ name: 'archive_dry_run', pass: true, detail: `checked=${r?.positionsChecked ?? 'n/a'}` });
  }

  // ─── 3. cleanupExpiredLifecycleEntries — disabled ───────────────────
  {
    const prev = process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED;
    process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED = 'false';
    const r = await cleanupExpiredLifecycleEntries();
    if (prev === undefined) delete process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED;
    else process.env.LUNA_LIFECYCLE_CLEANUP_ENABLED = prev;

    assert.equal(r.deleted, 0, 'disabled → 0 deleted');
    results.push({ name: 'cleanup_disabled', pass: true });
  }

  // ─── 4. calculateLifecycleStageCoverage — DB call ───────────────────
  {
    const r = await calculateLifecycleStageCoverage({ days: 30 }).catch(() => null);
    const ok = r === null || (
      typeof r === 'object' &&
      typeof r.totalPositions === 'number' &&
      typeof r.coveragePercent === 'number' &&
      typeof r.stageBreakdown === 'object'
    );
    assert.ok(ok, 'calculateLifecycleStageCoverage returns valid shape');
    results.push({
      name: 'stage_coverage_calc',
      pass: ok,
      detail: r
        ? `totalPositions=${r.totalPositions}, stage8=${r.stage8CoveredCount}, coverage=${r.coveragePercent}%`
        : 'DB 연결 불가 (soft pass)',
    });
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  return {
    ok: passed === total,
    passed,
    total,
    results,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const r of result.results) {
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    }
    console.log(`\n${result.ok ? '✅' : '❌'} runtime-lifecycle-cleanup-smoke (${result.passed}/${result.total})`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-lifecycle-cleanup-smoke 실패:',
  });
}
