#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { attachSourceRefToMeta } from '../shared/source-ref.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool.ts');

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback: string | null = null): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? Math.trunc(parsed) : fallback));
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function improvementProposal(rows: any[]): string[] {
  const proposals: string[] = [];
  for (const row of rows) {
    const error = String(row.error || 'unknown');
    const count = Number(row.count || 0);
    if (/provider_circuit_open/i.test(error)) {
      proposals.push(`${row.caller_team || 'unknown'}:${row.selector_key || 'unknown'} provider circuit open ${count}회 - selector fallback order and provider cooldown evidence review`);
    } else if (/token_budget_exceeded/i.test(error)) {
      proposals.push(`${row.caller_team || 'unknown'}:${row.selector_key || 'unknown'} token budget exceeded ${count}회 - profile maxTokens/budget profile review`);
    } else if (Number(row.fallback_sum || 0) > 0) {
      proposals.push(`${row.caller_team || 'unknown'}:${row.selector_key || 'unknown'} fallback ${row.fallback_sum}회 - cheaper/healthier route candidate review`);
    }
  }
  return proposals.slice(0, 10);
}

function buildVaultEntry(report: any) {
  const content = [
    '# Hub LLM routing feedback',
    '',
    `windowHours: ${report.windowHours}`,
    `totalIssues: ${report.totalIssues}`,
    '',
    '## Proposals',
    ...report.proposals.map((item: string) => `- ${item}`),
  ].join('\n');
  return {
    title: `Hub LLM routing feedback ${report.generatedAt.slice(0, 10)}`,
    type: 'hub_llm_feedback',
    content,
    tags: ['sigma-library', 'hub', 'hub_llm', 'W-axis', 'routing-feedback'],
    filePath: `hub/llm-feedback/${shortHash(content)}`,
    source: 'hub_llm',
    meta: attachSourceRefToMeta({
      team: 'hub',
      domain: 'hub_llm',
      generatedAt: report.generatedAt,
      windowHours: report.windowHours,
      proposals: report.proposals,
      libraryCoords: {
        abstraction_level: 'L2',
        time_stage: 'digest',
        validation_state: 'unverified',
        prediction_state: 'none',
      },
    }, { team: 'hub', table: 'public.llm_routing_log.aggregate', id: report.generatedAt.slice(0, 10) }),
  };
}

export async function runSigmaHubLlmFeed(options: any = {}) {
  const windowHours = boundedInt(options.windowHours, 24 * 7, 1, 24 * 30);
  const limit = boundedInt(options.limit, 50, 1, 200);
  const dryRun = options.dryRun !== false;
  const writeVault = options.writeVault === true && dryRun === false;
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;

  let rows: any[] = [];
  let warnings: string[] = [];
  try {
    rows = await queryReadonly('public', `
      SELECT
        COALESCE(caller_team, 'unknown') AS caller_team,
        COALESCE(agent, 'unknown') AS agent,
        COALESCE(selector_key, 'unknown') AS selector_key,
        COALESCE(selected_route, provider, 'unknown') AS route,
        COALESCE(error, '') AS error,
        COUNT(*)::int AS count,
        COALESCE(SUM(fallback_count), 0)::int AS fallback_sum,
        ROUND(AVG(duration_ms))::int AS avg_duration_ms
      FROM public.llm_routing_log
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
        AND (
          success IS FALSE
          OR COALESCE(fallback_count, 0) > 0
          OR COALESCE(error, '') ILIKE '%provider_circuit_open%'
          OR COALESCE(error, '') ILIKE '%fallback_exhausted%'
          OR COALESCE(error, '') ILIKE '%token_budget_exceeded%'
        )
      GROUP BY 1,2,3,4,5
      ORDER BY count DESC, fallback_sum DESC
      LIMIT $2
    `, [windowHours, limit]);
  } catch (error: any) {
    warnings.push(`routing_log_query_unavailable:${String(error?.message || error).slice(0, 180)}`);
  }

  const proposals = improvementProposal(rows);
  const report = {
    ok: true,
    dryRun,
    writeVault,
    windowHours,
    totalIssues: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
    rows,
    proposals,
    vaultCandidate: null,
    persisted: { attempted: 0, ok: 0, skipped: !writeVault, id: null, message: null },
    warnings,
    generatedAt: new Date().toISOString(),
  };
  report.vaultCandidate = buildVaultEntry(report);

  if (writeVault) {
    const { VaultManager } = await import('../vault/vault-manager.ts');
    const manager = new VaultManager();
    const persisted = await manager.addToInbox(report.vaultCandidate);
    report.persisted = {
      attempted: 1,
      ok: persisted.ok ? 1 : 0,
      skipped: false,
      id: persisted.id || null,
      message: persisted.message || null,
    };
    report.ok = persisted.ok !== false;
  }

  return report;
}

async function main() {
  const result = await runSigmaHubLlmFeed({
    windowHours: boundedInt(argValue('hours', '168'), 168, 1, 720),
    limit: boundedInt(argValue('limit', '50'), 50, 1, 200),
    dryRun: !hasFlag('no-dry-run') || hasFlag('dry-run'),
    writeVault: hasFlag('write-vault') && hasFlag('no-dry-run'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[sigma-hub-llm-feed] dryRun=${result.dryRun} issues=${result.totalIssues} proposals=${result.proposals.length} persisted=${result.persisted.ok}/${result.persisted.attempted}`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}
