#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool.ts'));

const DAY_MS = 24 * 60 * 60 * 1000;

export const EVENT_LAKE_RETENTION_V2_DRAFT_POLICY = Object.freeze({
  tvBarDays: 30,
  ephemeralRuntimeDays: 90,
  ephemeralRuntimeEventTypes: Object.freeze([
    'port_agent_run',
    'port_agent_started',
    'port_agent_completed',
    'port_agent_failed',
    'port_agent_skipped',
  ]),
  unknownAction: 'keep',
  archiveRequired: true,
  applySupported: false,
});

export function classifyRetentionDraft(eventType, policy = EVENT_LAKE_RETENTION_V2_DRAFT_POLICY) {
  const normalized = String(eventType || '');
  if (normalized.startsWith('luna.tv.bar.')) {
    return { className: 'tv_bar', hotDays: policy.tvBarDays, action: 'archive_then_delete' };
  }
  if (policy.ephemeralRuntimeEventTypes.includes(normalized)) {
    return {
      className: 'ephemeral_runtime',
      hotDays: policy.ephemeralRuntimeDays,
      action: 'archive_then_delete',
    };
  }
  return { className: 'unknown_or_durable', hotDays: null, action: policy.unknownAction };
}

export function isRetentionDraftCandidate(row, now = new Date(), policy = EVENT_LAKE_RETENTION_V2_DRAFT_POLICY) {
  const classification = classifyRetentionDraft(row?.event_type, policy);
  const createdAtValue = row?.created_at;
  const createdAt = new Date(createdAtValue).getTime();
  if (!createdAtValue || classification.hotDays == null || !Number.isFinite(createdAt)) return false;
  return now.getTime() - createdAt > classification.hotDays * DAY_MS;
}

export async function collectRetentionV2DraftPlan({
  queryReadonly = pgPool.queryReadonly,
  policy = EVENT_LAKE_RETENTION_V2_DRAFT_POLICY,
} = {}) {
  const rows = await queryReadonly('agent', `
    SELECT
      CASE
        WHEN event_type LIKE 'luna.tv.bar.%' THEN 'tv_bar'
        WHEN event_type = ANY($1::text[]) THEN 'ephemeral_runtime'
      END AS class_name,
      COUNT(*)::bigint AS candidate_rows,
      MIN(created_at) AS oldest_at,
      MAX(created_at) AS newest_at
    FROM agent.event_lake
    WHERE (event_type LIKE 'luna.tv.bar.%' AND created_at < NOW() - ($2::int * INTERVAL '1 day'))
       OR (event_type = ANY($1::text[]) AND created_at < NOW() - ($3::int * INTERVAL '1 day'))
    GROUP BY 1
    ORDER BY candidate_rows DESC
  `, [policy.ephemeralRuntimeEventTypes, policy.tvBarDays, policy.ephemeralRuntimeDays]);

  return {
    ok: true,
    mode: 'read_only_draft',
    applySupported: false,
    unknownAction: policy.unknownAction,
    archiveContract: {
      required: true,
      immutableManifest: true,
      restoreVerification: true,
      exactPopulationDelete: true,
    },
    candidates: rows.map((row) => ({
      className: row.class_name,
      rows: Number(row.candidate_rows || 0),
      oldestAt: row.oldest_at || null,
      newestAt: row.newest_at || null,
    })),
  };
}

async function main() {
  const result = await collectRetentionV2DraftPlan();
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  });
}
