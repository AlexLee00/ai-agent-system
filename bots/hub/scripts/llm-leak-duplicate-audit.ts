#!/usr/bin/env tsx
// @ts-nocheck

const { execFileSync } = require('node:child_process');
const pgPool = require('../../../packages/core/lib/pg-pool');

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg === name || arg.startsWith(prefix));
  if (!found) return fallback;
  if (found === name) return true;
  return found.slice(prefix.length);
}

function enabled(value) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value || '').trim().toLowerCase());
}

function launchctlGetenv(name) {
  try {
    return execFileSync('/bin/launchctl', ['getenv', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function tableExists() {
  const rows = await pgPool.query('public', `
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'llm_routing_log'
    LIMIT 1
  `);
  return rows.length > 0;
}

async function columnExists(columnName) {
  const rows = await pgPool.query('public', `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'llm_routing_log'
      AND column_name = $1
    LIMIT 1
  `, [columnName]);
  return rows.length > 0;
}

async function runAudit(hours) {
  if (!(await tableExists())) {
    return {
      ok: false,
      hours,
      status: 'missing_llm_routing_log',
      blockers: ['public.llm_routing_log table missing'],
      warnings: [],
      evidence: {},
    };
  }

  const [
    providerRows,
    duplicateSessionRows,
    burstRows,
    fallbackRows,
    errorRows,
    promptHashAvailable,
  ] = await Promise.all([
    pgPool.query('public', `
      SELECT
        provider,
        caller_team,
        COUNT(*)::int AS calls,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS success_count,
        ROUND(SUM(cost_usd)::numeric, 6)::float AS cost_usd,
        COALESCE(SUM(fallback_count), 0)::int AS fallback_sum,
        ROUND(AVG(duration_ms))::int AS avg_ms
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
      GROUP BY provider, caller_team
      ORDER BY calls DESC
    `, [hours]),
    pgPool.query('public', `
      SELECT
        session_id,
        COUNT(*)::int AS calls,
        COUNT(DISTINCT provider)::int AS providers,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        ARRAY_AGG(provider ORDER BY created_at) AS providers_seen,
        ARRAY_AGG(caller_team ORDER BY created_at) AS teams,
        ARRAY_AGG(agent ORDER BY created_at) AS agents
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
        AND session_id IS NOT NULL
        AND length(session_id) > 0
      GROUP BY session_id
      HAVING COUNT(*) > 1
      ORDER BY calls DESC, last_at DESC
      LIMIT 25
    `, [hours]),
    pgPool.query('public', `
      SELECT
        date_trunc('minute', created_at) AS minute,
        caller_team,
        agent,
        provider,
        COUNT(*)::int AS calls,
        COALESCE(SUM(fallback_count), 0)::int AS fallback_sum,
        ROUND(SUM(cost_usd)::numeric, 6)::float AS cost_usd
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
      GROUP BY minute, caller_team, agent, provider
      HAVING COUNT(*) >= $2
      ORDER BY calls DESC, minute DESC
      LIMIT 25
    `, [hours, Number(process.env.HUB_LLM_DUP_AUDIT_BURST_PER_MINUTE || 20)]),
    pgPool.query('public', `
      SELECT
        caller_team,
        agent,
        provider,
        COUNT(*)::int AS calls,
        COALESCE(SUM(fallback_count), 0)::int AS fallback_sum,
        ROUND(SUM(cost_usd)::numeric, 6)::float AS cost_usd
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
        AND fallback_count > 0
      GROUP BY caller_team, agent, provider
      ORDER BY fallback_sum DESC, calls DESC
      LIMIT 25
    `, [hours]),
    pgPool.query('public', `
      SELECT provider, error, COUNT(*)::int AS calls
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
        AND success = false
      GROUP BY provider, error
      ORDER BY calls DESC
      LIMIT 20
    `, [hours]),
    columnExists('prompt_hash'),
  ]);
  const duplicatePromptRows = promptHashAvailable
    ? await pgPool.query('public', `
      SELECT
        prompt_hash,
        caller_team,
        agent,
        abstract_model,
        COUNT(*)::int AS calls,
        COUNT(DISTINCT session_id)::int AS sessions,
        COUNT(DISTINCT provider)::int AS providers,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        ARRAY_AGG(DISTINCT provider) AS providers_seen
      FROM llm_routing_log
      WHERE created_at > NOW() - ($1 || ' hours')::interval
        AND prompt_hash IS NOT NULL
      GROUP BY prompt_hash, caller_team, agent, abstract_model
      HAVING COUNT(*) > 1
      ORDER BY calls DESC, last_at DESC
      LIMIT 25
    `, [hours])
    : [];

  const providerTotals = providerRows.reduce((acc, row) => {
    const provider = String(row.provider || 'unknown');
    acc[provider] = (acc[provider] || 0) + Number(row.calls || 0);
    return acc;
  }, {});
  const totalCalls = Object.values(providerTotals).reduce((sum, value) => sum + Number(value || 0), 0);
  const totalCostUsd = providerRows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0);
  const failedCalls = errorRows.reduce((sum, row) => sum + Number(row.calls || 0), 0);
  const directRoutesEnv = process.env.HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES || launchctlGetenv('HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES');
  const directFallbackEnv = process.env.INVESTMENT_LLM_DIRECT_FALLBACK || launchctlGetenv('INVESTMENT_LLM_DIRECT_FALLBACK');

  const blockers = [];
  const warnings = [];
  if (Number(providerTotals.anthropic || 0) > 0) blockers.push(`anthropic provider calls observed: ${providerTotals.anthropic}`);
  if (duplicateSessionRows.length > 0) blockers.push(`duplicate session_id rows observed: ${duplicateSessionRows.length}`);
  if (enabled(directRoutesEnv)) blockers.push('HUB_ALLOW_DIRECT_LLM_PROVIDER_ROUTES is enabled');
  if (enabled(directFallbackEnv)) warnings.push('INVESTMENT_LLM_DIRECT_FALLBACK is enabled; direct fallback can bypass Hub in emergency paths');
  if (!promptHashAvailable) warnings.push('public.llm_routing_log.prompt_hash missing; exact duplicate prompt detection is limited to session/burst heuristics');
  if (duplicatePromptRows.length > 0) {
    const message = `duplicate prompt_hash groups observed: ${duplicatePromptRows.length}`;
    if (enabled(process.env.HUB_LLM_DUP_AUDIT_BLOCK_PROMPT_DUPES)) blockers.push(message);
    else warnings.push(message);
  }
  if (burstRows.length > 0) warnings.push(`high per-minute LLM bursts observed: ${burstRows.length} bucket(s)`);
  if (failedCalls > 0) warnings.push(`failed LLM calls observed: ${failedCalls}`);

  return {
    ok: blockers.length === 0,
    hours,
    status: blockers.length === 0 ? 'clear' : 'blocked',
    blockers,
    warnings,
    summary: {
      total_calls: totalCalls,
      failed_calls: failedCalls,
      failed_rate_pct: totalCalls > 0 ? Number(((failedCalls * 100) / totalCalls).toFixed(2)) : 0,
      total_cost_usd: Number(totalCostUsd.toFixed(6)),
      provider_totals: providerTotals,
      duplicate_session_count: duplicateSessionRows.length,
      duplicate_prompt_group_count: duplicatePromptRows.length,
      prompt_hash_available: promptHashAvailable,
      direct_provider_routes_enabled: enabled(directRoutesEnv),
      investment_direct_fallback_enabled: enabled(directFallbackEnv),
    },
    evidence: {
      by_provider_team: providerRows.slice(0, 30),
      duplicate_sessions: duplicateSessionRows,
      duplicate_prompt_groups: duplicatePromptRows,
      high_bursts: burstRows,
      fallback_hotspots: fallbackRows,
      errors: errorRows,
    },
  };
}

async function main() {
  const hours = Math.min(Math.max(Number(argValue('--hours', process.env.HUB_LLM_DUP_AUDIT_HOURS || 24)), 1), 168);
  const strict = enabled(argValue('--strict', process.env.HUB_LLM_DUP_AUDIT_STRICT || ''));
  const json = enabled(argValue('--json', 'true'));
  const result = await runAudit(hours);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(`[llm-leak-duplicate-audit] status=${result.status} calls=${result.summary?.total_calls || 0} blockers=${result.blockers.length}`);
  if (strict && !result.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('[llm-leak-duplicate-audit] failed:', error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.close?.().catch?.(() => null);
  });
