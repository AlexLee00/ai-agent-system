'use strict';

const crypto = require('node:crypto');
const pgPool = require('../lib/pg-pool');
const { createAgentMemory } = require('../lib/agent-memory');

type PatternRow = {
  team: string;
  agent: string;
  intent: string;
  kind: string;
  result: string;
  count: number;
  latest_at: string;
  signatures: string[];
  sample_root_cause?: string;
  sample_resolution_hint?: string;
  sample_recovery_result?: string;
  sample_test_result?: string;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function clampNumber(value: string, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function semanticKey(row: PatternRow): string {
  const raw = [
    row.team,
    row.agent,
    row.intent,
    row.kind,
    row.result,
    row.signatures.join(','),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function buildContent(row: PatternRow): string {
  return [
    `[실행 궤적 통합] ${row.team}/${row.agent}/${row.intent}`,
    `종류: ${row.kind}`,
    `결과: ${row.result}`,
    `반복: ${row.count}건`,
    `최근: ${row.latest_at}`,
    row.sample_root_cause ? `대표 실패 원인: ${row.sample_root_cause}` : '',
    row.sample_resolution_hint ? `대표 해결 힌트: ${row.sample_resolution_hint}` : '',
    row.sample_recovery_result ? `대표 성공 결과: ${row.sample_recovery_result}` : '',
    row.sample_test_result ? `대표 테스트 결과: ${row.sample_test_result}` : '',
    `signature: ${row.signatures.slice(0, 5).join(', ')}`,
  ].filter(Boolean).join('\n');
}

async function loadPatterns(sinceHours: number, minCount: number, limit: number): Promise<PatternRow[]> {
  return pgPool.query('reservation', `
    SELECT
      metadata->>'team' AS team,
      metadata->>'agent' AS agent,
      metadata->>'intent' AS intent,
      metadata->>'kind' AS kind,
      COALESCE(metadata->>'result', CASE WHEN metadata->>'kind' = 'failure_trajectory' THEN 'failure' END) AS result,
      COUNT(*)::int AS count,
      MAX(created_at)::text AS latest_at,
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT metadata->>'signature'), NULL) AS signatures,
      MAX(NULLIF(metadata->>'root_cause', '')) AS sample_root_cause,
      MAX(NULLIF(metadata->>'resolution_hint', '')) AS sample_resolution_hint,
      MAX(NULLIF(metadata->>'recovery_result', '')) AS sample_recovery_result,
      MAX(NULLIF(metadata->>'test_result', '')) AS sample_test_result
    FROM reservation.rag_experience
    WHERE created_at > NOW() - ($1::text || ' hours')::INTERVAL
      AND metadata->>'kind' IN ('failure_trajectory', 'execution_trajectory')
      AND COALESCE(metadata->'metadata'->>'health_probe', 'false') <> 'true'
      AND COALESCE(metadata->'metadata'->>'probe', 'false') <> 'true'
      AND metadata->>'intent' NOT ILIKE '%probe%'
      AND metadata->>'intent' NOT ILIKE '%smoke%'
      AND metadata->>'intent' NOT ILIKE '%test%'
    GROUP BY 1, 2, 3, 4, 5
    HAVING COUNT(*) >= $2
    ORDER BY count DESC, MAX(created_at) DESC
    LIMIT $3
  `, [String(sinceHours), minCount, limit]);
}

async function existingSemanticKey(key: string): Promise<number | null> {
  const rows = await pgPool.query('reservation', `
    SELECT id
    FROM rag.agent_memory
    WHERE metadata->>'trajectory_semantic_key' = $1
    LIMIT 1
  `, [key]);
  return rows[0]?.id ? Number(rows[0].id) : null;
}

async function consolidatePattern(row: PatternRow, apply: boolean): Promise<Record<string, unknown>> {
  const key = semanticKey(row);
  const existingId = await existingSemanticKey(key);
  if (existingId) {
    return { key, action: 'skip_existing', memoryId: existingId, row };
  }
  if (!apply) {
    return { key, action: 'dry_run', row };
  }
  const agentMemory = createAgentMemory({
    team: row.team,
    agentId: `${row.team}.${row.agent}.trajectory`,
  });
  const memoryId = await agentMemory.remember(buildContent(row), 'semantic', {
    keywords: [
      'execution_trajectory',
      row.kind,
      row.result,
      row.intent,
      row.agent,
    ].filter(Boolean).slice(0, 12),
    importance: row.result === 'failure' ? 0.82 : 0.74,
    metadata: {
      trajectory_semantic_key: key,
      source: 'execution-trajectory-consolidate',
      team: row.team,
      agent: row.agent,
      intent: row.intent,
      kind: row.kind,
      result: row.result,
      count: row.count,
      signatures: row.signatures,
      latest_at: row.latest_at,
    },
  });
  return { key, action: 'created', memoryId, row };
}

async function main(): Promise<void> {
  const apply = hasFlag('--apply');
  const sinceHours = clampNumber(argValue('--since-hours', '168'), 168, 1, 24 * 30);
  const minCount = clampNumber(argValue('--min-count', '2'), 2, 1, 100);
  const limit = clampNumber(argValue('--limit', '20'), 20, 1, 100);
  const patterns = await loadPatterns(sinceHours, minCount, limit);
  const results = [];
  for (const row of patterns) {
    results.push(await consolidatePattern(row, apply));
  }
  console.log(JSON.stringify({
    ok: true,
    apply,
    sinceHours,
    minCount,
    patternCount: patterns.length,
    created: results.filter((item) => item.action === 'created').length,
    skipped: results.filter((item) => item.action === 'skip_existing').length,
    results,
  }, null, 2));
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
