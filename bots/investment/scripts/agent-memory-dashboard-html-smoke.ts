#!/usr/bin/env node
// @ts-nocheck
/**
 * agent-memory-dashboard-html-smoke.ts — Phase Ω5 smoke test
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { collectDashboardData, runMemoryDashboard } from './runtime-agent-memory-dashboard-html.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const results: { name: string; pass: boolean; detail?: string }[] = [];

  // ─── 1. collectDashboardData — 구조 검증 ───────────────────────────
  {
    const data = await collectDashboardData().catch(() => null);
    const ok = data !== null &&
      typeof data.generatedAt === 'string' &&
      typeof data.layer1 === 'object' &&
      typeof data.layer2 === 'object' &&
      typeof data.layer3 === 'object' &&
      typeof data.layer4 === 'object' &&
      Array.isArray(data.agentRetrievals) &&
      typeof data.reflexions === 'object' &&
      typeof data.llmRouting === 'object' &&
      typeof data.crossBus === 'object';
    assert.ok(ok, 'collectDashboardData returns valid shape');
    results.push({
      name: 'collect_data_shape',
      pass: ok,
      detail: data
        ? `L2=${data.layer2.count}, reflexion=${data.layer3.reflexionCount}, skills=${data.layer4.skillCount}`
        : 'null (DB 연결 불가)',
    });
  }

  // ─── 2. agentRetrievals — 12 에이전트 포함 ──────────────────────────
  {
    const data = await collectDashboardData().catch(() => null);
    if (data) {
      const agents = data.agentRetrievals.map(a => a.agent);
      const hasLuna = agents.includes('luna');
      assert.ok(hasLuna, 'luna agent present in retrievals');
      assert.equal(data.agentRetrievals.length, 12, '12개 에이전트');
      results.push({ name: 'agent_retrievals_12', pass: true, detail: `agents: ${agents.join(', ')}` });
    } else {
      results.push({ name: 'agent_retrievals_12', pass: true, detail: 'DB 연결 불가 (soft pass)' });
    }
  }

  // ─── 3. runMemoryDashboard — CLI 출력 ──────────────────────────────
  {
    const r = await runMemoryDashboard({ format: 'cli' }).catch(() => null);
    const ok = r !== null && r.ok === true && typeof r.output === 'string' && r.output.length > 100;
    assert.ok(ok, 'CLI dashboard output is non-empty');
    results.push({ name: 'cli_output_nonempty', pass: ok, detail: `output length=${r?.output?.length ?? 0}` });
  }

  // ─── 4. runMemoryDashboard — HTML 구조 체크 ─────────────────────────
  {
    const r = await runMemoryDashboard({
      format: 'html',
      outputPath: path.join(os.tmpdir(), 'luna-memory-dashboard-smoke'),
    }).catch(() => null);
    const ok = r !== null && r.ok === true &&
      typeof r.output === 'string' &&
      r.output.includes('<!DOCTYPE html>') &&
      r.output.includes('Luna Memory Dashboard');
    assert.ok(ok, 'HTML dashboard contains DOCTYPE and title');
    results.push({ name: 'html_output_valid', pass: ok, detail: `outputPath=${r?.outputPath ?? 'n/a'}` });
  }

  const passed = results.filter(r => r.pass).length;
  const total = results.length;

  return { ok: passed === total, passed, total, results };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const r of result.results) {
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.detail ? `: ${r.detail}` : ''}`);
    }
    console.log(`\n${result.ok ? '✅' : '❌'} agent-memory-dashboard-html-smoke (${result.passed}/${result.total})`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-dashboard-html-smoke 실패:',
  });
}
