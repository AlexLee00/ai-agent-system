#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildAgentMemoryDoctorReport } from './runtime-agent-memory-doctor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const report = await buildAgentMemoryDoctorReport({ market: 'crypto', strict: false });
  assert.equal(report.status, 'agent_memory_doctor_clear', 'doctor clear in non-strict mode');
  assert.ok(Array.isArray(report.tables) && report.tables.length >= 1, 'tables listed');
  assert.ok(report.tables.every((row) => row.exists === true), 'all required tables exist');
  assert.ok(Array.isArray(report.sampleRoutes) && report.sampleRoutes.length >= 1, 'sample routes listed');
  assert.ok(report.sampleRoutes.some((row) => row.agent === 'luna'), 'luna sample route exists');

  return {
    ok: true,
    status: report.status,
    warningCount: report.warnings.length,
    routeSamples: report.sampleRoutes.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent-memory-doctor-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent-memory-doctor-smoke 실패:',
  });
}
