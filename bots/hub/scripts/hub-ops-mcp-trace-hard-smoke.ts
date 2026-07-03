#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import * as pgPool from '../../../packages/core/lib/pg-pool.ts';
import { callHubOpsTool } from '../mcp/hub-ops-mcp/src/server.ts';

async function main() {
  const columns = await pgPool.queryReadonly('public', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'llm_routing_log'
      AND column_name = ANY($1::text[])
  `, [['trace_id', 'cycle_id']]).catch(() => []);
  const columnSet = new Set((Array.isArray(columns) ? columns : columns?.rows ?? []).map((row) => row.column_name));
  if (!columnSet.has('trace_id')) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'trace_id_column_missing' }, null, 2));
    return;
  }

  const samples = await pgPool.queryReadonly('public', `
    SELECT trace_id, cycle_id
    FROM public.llm_routing_log
    WHERE trace_id IS NOT NULL AND trace_id <> ''
    ORDER BY created_at DESC
    LIMIT 1
  `, []).catch(() => []);
  const sample = (Array.isArray(samples) ? samples : samples?.rows ?? [])[0];
  if (!sample?.trace_id) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'trace_sample_missing' }, null, 2));
    return;
  }

  const started = Date.now();
  const result = await callHubOpsTool('hub-trace', {
    traceId: sample.trace_id,
    limit: 5,
    hours: 168,
    timeoutMs: 2500,
    requestTimeoutMs: 5000,
  });
  const elapsedMs = Date.now() - started;
  assert.ok(elapsedMs < 6000, `hub-trace must finish within timeout, elapsed=${elapsedMs}`);
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.events));
  assert.equal(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i.test(JSON.stringify(result)), false);
  console.log(JSON.stringify({
    ok: true,
    smoke: 'hub-ops-mcp-trace-hard',
    elapsedMs,
    resultOk: result.ok,
    skipped: Boolean(result.skipped),
    counts: result.counts || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
