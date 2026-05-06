#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const selector = require('../../../packages/core/lib/llm-model-selector.ts');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(SCRIPT_DIR, '..', '..', '..');

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const HOURS = Math.min(Math.max(Number(process.env.LLM_OAUTH4_REVIEW_HOURS || 168), 1), 24 * 30);
const STRICT = ['1', 'true', 'yes', 'on'].includes(String(process.env.LLM_OAUTH4_REVIEW_STRICT || '').trim().toLowerCase());
const OUTPUT_JSON = path.resolve(
  process.env.LLM_OAUTH4_REVIEW_JSON
    || path.join(PROJECT_ROOT, 'bots', 'hub', 'output', 'llm-oauth4-master-review.json'),
);
const OUTPUT_MD = path.resolve(
  process.env.LLM_OAUTH4_REVIEW_MD
    || path.join(PROJECT_ROOT, 'docs', 'hub', 'LLM_OAUTH4_MASTER_REVIEW.md'),
);

const PROVIDER_ORDER = [
  'claude-code-oauth',
  'openai-oauth',
  'gemini-cli-oauth',
  'gemini-oauth',
  'anthropic',
  'groq',
  'failed',
];
const OAUTH_RUNTIME_PROVIDERS = new Set(['claude-code-oauth', 'openai-oauth', 'gemini-cli-oauth', 'gemini-oauth']);
const OAUTH4_SELECTOR_OPTIONS = {
  selectorVersion: 'v3.0_oauth_4',
  rolloutPercent: 100,
};

function normalizeProviderRow(raw = {}) {
  const calls = Number(raw.total_calls || 0);
  const successCount = Number(raw.success_count || 0);
  return {
    provider: String(raw.provider || 'unknown'),
    calls,
    success_count: successCount,
    failed_count: Math.max(0, calls - successCount),
    avg_duration_ms: Number(raw.avg_duration_ms || 0),
    max_duration_ms: Number(raw.max_duration_ms || 0),
    total_cost_usd: Number(raw.total_cost_usd || 0),
  };
}

function aggregateProviderRows(rawRows = []) {
  const byProvider = new Map();
  for (const raw of rawRows) {
    const row = normalizeProviderRow(raw);
    const current = byProvider.get(row.provider) || {
      provider: row.provider,
      calls: 0,
      success_count: 0,
      failed_count: 0,
      duration_weighted_sum: 0,
      max_duration_ms: 0,
      total_cost_usd: 0,
    };
    current.calls += row.calls;
    current.success_count += row.success_count;
    current.failed_count += row.failed_count;
    current.duration_weighted_sum += row.avg_duration_ms * row.calls;
    current.max_duration_ms = Math.max(current.max_duration_ms, row.max_duration_ms);
    current.total_cost_usd += row.total_cost_usd;
    byProvider.set(row.provider, current);
  }
  return Array.from(byProvider.values()).map((row) => ({
    provider: row.provider,
    calls: row.calls,
    success_count: row.success_count,
    failed_count: row.failed_count,
    avg_duration_ms: row.calls > 0 ? Math.round(row.duration_weighted_sum / row.calls) : 0,
    max_duration_ms: row.max_duration_ms,
    total_cost_usd: Number(row.total_cost_usd.toFixed(6)),
  }));
}

function providerLabel(provider = '') {
  if (provider === 'claude-code-oauth') return 'Claude Code OAuth';
  if (provider === 'openai-oauth') return 'OpenAI OAuth';
  if (provider === 'gemini-cli-oauth') return 'Gemini CLI OAuth';
  if (provider === 'gemini-oauth') return 'Gemini OAuth';
  if (provider === 'anthropic') return 'Anthropic SDK';
  if (provider === 'groq') return 'Groq';
  if (provider === 'failed') return 'Failed';
  return provider || 'unknown';
}

function normalizeSelectorProvider(provider = '') {
  const normalized = String(provider || '').trim();
  if (normalized === 'claude-code-oauth') return 'claude-code';
  if (normalized === 'gemini-oauth') return 'gemini-cli-oauth';
  return normalized || 'unknown';
}

function normalizeSelectorModel(entry = {}) {
  const provider = normalizeSelectorProvider(entry?.provider);
  const rawModel = String(entry?.model || 'unknown').trim() || 'unknown';
  if (rawModel.startsWith(`${provider}/`)) return rawModel;
  if (provider === 'unknown') return rawModel;
  if (provider === 'claude-code' && rawModel.startsWith('claude-')) return `${provider}/${rawModel.replace(/^claude-code\//, '')}`;
  if (provider === 'gemini-cli-oauth' && rawModel.startsWith('gemini-cli-oauth/')) return rawModel;
  if (provider === 'groq' && rawModel.startsWith('groq/')) return rawModel;
  return `${provider}/${rawModel.replace(/^groq\//, '').replace(/^gemini-cli-oauth\//, '').replace(/^openai-oauth\//, '')}`;
}

function addCount(bucket, key) {
  bucket[key] = (bucket[key] || 0) + 1;
}

function pct(value, total) {
  return total > 0 ? Number(((value * 100) / total).toFixed(2)) : 0;
}

function buildSelectorSnapshot(selectorModule = selector) {
  const selectorKeys = typeof selectorModule.listLLMSelectorKeys === 'function'
    ? selectorModule.listLLMSelectorKeys()
    : [];
  const agentTargets = typeof selectorModule.listAgentModelTargets === 'function'
    ? selectorModule.listAgentModelTargets()
    : [];
  const primaryProviderCounts = {};
  const primaryModelCounts = {};
  const chainProviderCounts = {};
  const chainModelCounts = {};
  const findings = [];
  let selectorKeyCount = 0;
  let agentRouteCount = 0;

  function inspectChain(scope, key, chain) {
    if (!Array.isArray(chain) || chain.length === 0) return;
    const primaryProvider = normalizeSelectorProvider(chain[0]?.provider);
    const primaryModel = normalizeSelectorModel(chain[0]);
    addCount(primaryProviderCounts, primaryProvider);
    addCount(primaryModelCounts, primaryModel);
    if (scope === 'selector_key') selectorKeyCount += 1;
    if (scope === 'agent_route') agentRouteCount += 1;
    chain.forEach((entry, index) => {
      const provider = normalizeSelectorProvider(entry?.provider);
      const model = normalizeSelectorModel(entry);
      addCount(chainProviderCounts, provider);
      addCount(chainModelCounts, model);
      if (provider === 'anthropic') {
        findings.push({
          scope,
          key,
          routeIndex: index,
          primary: index === 0,
          provider: entry?.provider || null,
          model: entry?.model || null,
        });
      }
    });
  }

  for (const key of selectorKeys) {
    try {
      const chain = selectorModule.selectLLMChain(key, {
        ...OAUTH4_SELECTOR_OPTIONS,
        rolloutKey: `master-review:${key}`,
      });
      inspectChain('selector_key', key, chain);
    } catch (error) {
      findings.push({ scope: 'selector_key_error', key, error: String(error?.message || error) });
    }
  }

  for (const target of agentTargets) {
    if (!target?.selected || !target?.selectorKey) continue;
    try {
      const key = `${target.team}.${target.agent}`;
      const chain = selectorModule.selectLLMChain(target.selectorKey, {
        ...OAUTH4_SELECTOR_OPTIONS,
        agentName: target.agent,
        team: target.team,
        rolloutKey: `master-review-agent:${target.team}:${target.agent}`,
      });
      inspectChain('agent_route', key, chain);
    } catch (error) {
      findings.push({
        scope: 'agent_route_error',
        key: `${target.team}.${target.agent}`,
        selectorKey: target.selectorKey,
        error: String(error?.message || error),
      });
    }
  }

  const totalPrimaryRoutes = Object.values(primaryProviderCounts).reduce((sum, value) => sum + Number(value || 0), 0);
  const primaryProviderShares = Object.fromEntries(
    Object.entries(primaryProviderCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, count]) => [provider, pct(Number(count), totalPrimaryRoutes)]),
  );
  const primaryModelShares = Object.fromEntries(
    Object.entries(primaryModelCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, count]) => [model, pct(Number(count), totalPrimaryRoutes)]),
  );
  const anthropicPrimaryFindings = findings.filter((finding) => finding.provider === 'anthropic' && finding.primary);
  const anthropicChainFindings = findings.filter((finding) => finding.provider === 'anthropic');

  return {
    selector_version: OAUTH4_SELECTOR_OPTIONS.selectorVersion,
    rollout_percent: OAUTH4_SELECTOR_OPTIONS.rolloutPercent,
    checked: {
      selector_keys: selectorKeyCount,
      agent_routes: agentRouteCount,
      total_primary_routes: totalPrimaryRoutes,
    },
    primary_provider_counts: primaryProviderCounts,
    primary_provider_shares: primaryProviderShares,
    primary_model_counts: primaryModelCounts,
    primary_model_shares: primaryModelShares,
    chain_provider_counts: chainProviderCounts,
    chain_model_counts: chainModelCounts,
    claude_code_primary_share_pct: primaryProviderShares['claude-code'] || 0,
    claude_code_sonnet_primary_count: primaryModelCounts['claude-code/sonnet'] || 0,
    claude_code_sonnet_primary_share_pct: primaryModelShares['claude-code/sonnet'] || 0,
    anthropic_primary_findings: anthropicPrimaryFindings,
    anthropic_chain_findings: anthropicChainFindings,
    findings,
  };
}

async function fetchStats(hours = HOURS) {
  const url = `${HUB_BASE}/hub/llm/stats?hours=${hours}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HUB_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`hub_llm_stats_http_${res.status}`);
  }
  const body = await res.json();
  if (!body?.ok) throw new Error(`hub_llm_stats_failed:${body?.error || 'unknown'}`);
  return body;
}

function buildReport(stats, options = {}) {
  const rows = Array.isArray(stats.summary) ? aggregateProviderRows(stats.summary) : [];
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  const reportedCost = rows.reduce((sum, row) => sum + row.total_cost_usd, 0);
  const failedCalls = rows.find((row) => row.provider === 'failed')?.calls || 0;
  const oauthCalls = rows
    .filter((row) => OAUTH_RUNTIME_PROVIDERS.has(row.provider))
    .reduce((sum, row) => sum + row.calls, 0);
  const anthropicCalls = rows
    .filter((row) => row.provider === 'anthropic')
    .reduce((sum, row) => sum + row.calls, 0);
  const oauthReportedCost = rows
    .filter((row) => OAUTH_RUNTIME_PROVIDERS.has(row.provider))
    .reduce((sum, row) => sum + row.total_cost_usd, 0);
  const claudeCodeReportedCost = rows
    .filter((row) => row.provider === 'claude-code-oauth')
    .reduce((sum, row) => sum + row.total_cost_usd, 0);
  const nonOauthReportedCost = rows
    .filter((row) => !OAUTH_RUNTIME_PROVIDERS.has(row.provider) && row.provider !== 'failed')
    .reduce((sum, row) => sum + row.total_cost_usd, 0);
  const byProvider = {};
  for (const provider of PROVIDER_ORDER) {
    const row = rows.find((candidate) => candidate.provider === provider) || normalizeProviderRow({ provider });
    byProvider[provider] = {
      ...row,
      share_pct: totalCalls > 0 ? Number(((row.calls / totalCalls) * 100).toFixed(2)) : 0,
      success_rate_pct: row.calls > 0 ? Number(((row.success_count / row.calls) * 100).toFixed(2)) : 0,
    };
  }
  const selectorSnapshot = options.selectorSnapshot || buildSelectorSnapshot();
  const failedRatePct = totalCalls > 0 ? Number(((failedCalls / totalCalls) * 100).toFixed(2)) : 0;
  const maxFailedRatePct = Number.isFinite(Number(process.env.LLM_OAUTH4_REVIEW_MAX_FAILED_RATE_PCT))
    ? Number(process.env.LLM_OAUTH4_REVIEW_MAX_FAILED_RATE_PCT)
    : 1;
  const selectorClaudeCodePrimaryMaxPct = Number.isFinite(Number(process.env.LLM_OAUTH4_SELECTOR_CLAUDE_CODE_MAX_PCT))
    ? Number(process.env.LLM_OAUTH4_SELECTOR_CLAUDE_CODE_MAX_PCT)
    : 45;
  const selectorClaudeCodeSonnetPrimaryMaxPct = Number.isFinite(Number(process.env.LLM_OAUTH4_SELECTOR_SONNET_MAX_PCT))
    ? Number(process.env.LLM_OAUTH4_SELECTOR_SONNET_MAX_PCT)
    : 20;
  const claudeCodeRuntimeCostWarnPct = Number.isFinite(Number(process.env.LLM_OAUTH4_CLAUDE_CODE_COST_WARN_PCT))
    ? Number(process.env.LLM_OAUTH4_CLAUDE_CODE_COST_WARN_PCT)
    : 50;
  const claudeCodeRuntimeCostSharePct = reportedCost > 0
    ? Number(((claudeCodeReportedCost / reportedCost) * 100).toFixed(2))
    : 0;
  const warnings = [];
  if (reportedCost > 0) {
    warnings.push('runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate');
  }
  if (claudeCodeRuntimeCostSharePct > claudeCodeRuntimeCostWarnPct) {
    warnings.push('runtime_claude_code_reported_cost_share_high_reduce_sonnet_primary_routes');
  }
  if (nonOauthReportedCost > 0) {
    warnings.push('non_oauth_runtime_cost_observed_groq_or_other_fallback_usage');
  }

  const review = {
    ok: true,
    generated_at: new Date().toISOString(),
    hours: HOURS,
    totals: {
      total_calls: totalCalls,
      oauth_calls: oauthCalls,
      oauth_share_pct: totalCalls > 0 ? Number(((oauthCalls / totalCalls) * 100).toFixed(2)) : 0,
      failed_calls: failedCalls,
      failed_rate_pct: failedRatePct,
      reported_cost_usd: Number(reportedCost.toFixed(6)),
      oauth_reported_cost_usd: Number(oauthReportedCost.toFixed(6)),
      claude_code_reported_cost_usd: Number(claudeCodeReportedCost.toFixed(6)),
      claude_code_runtime_cost_share_pct: claudeCodeRuntimeCostSharePct,
      non_oauth_reported_cost_usd: Number(nonOauthReportedCost.toFixed(6)),
      anthropic_provider_calls: anthropicCalls,
    },
    providers: byProvider,
    selector_matrix: selectorSnapshot,
    targets: {
      selector_claude_code_primary_max_pct: selectorClaudeCodePrimaryMaxPct,
      selector_claude_code_sonnet_primary_max_pct: selectorClaudeCodeSonnetPrimaryMaxPct,
      claude_code_runtime_cost_warn_pct: claudeCodeRuntimeCostWarnPct,
      anthropic_provider_calls_target: 0,
      max_failed_rate_pct: maxFailedRatePct,
    },
    verdict: {
      selector_claude_code_share_ok: selectorSnapshot.claude_code_primary_share_pct <= selectorClaudeCodePrimaryMaxPct,
      selector_claude_code_sonnet_share_ok: selectorSnapshot.claude_code_sonnet_primary_share_pct <= selectorClaudeCodeSonnetPrimaryMaxPct,
      selector_anthropic_primary_zero_ok: selectorSnapshot.anthropic_primary_findings.length === 0,
      selector_anthropic_chain_zero_ok: selectorSnapshot.anthropic_chain_findings.length === 0,
      runtime_anthropic_zero_ok: anthropicCalls === 0,
      runtime_failed_rate_ok: failedRatePct <= maxFailedRatePct,
      runtime_oauth_seen_ok: totalCalls === 0 || oauthCalls > 0,
      reported_cost_accounting_only: true,
    },
    warnings,
  };
  review.ok = Boolean(
    review.verdict.selector_claude_code_share_ok
    && review.verdict.selector_claude_code_sonnet_share_ok
    && review.verdict.selector_anthropic_primary_zero_ok
    && review.verdict.selector_anthropic_chain_zero_ok
    && review.verdict.runtime_anthropic_zero_ok
    && review.verdict.runtime_failed_rate_ok
    && review.verdict.runtime_oauth_seen_ok,
  );
  return review;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# LLM OAuth4 Master Review');
  lines.push('');
  lines.push(`- generated_at: ${report.generated_at}`);
  lines.push(`- hours: ${report.hours}`);
  lines.push(`- total_calls: ${report.totals.total_calls}`);
  lines.push(`- oauth_share_pct: ${report.totals.oauth_share_pct}`);
  lines.push(`- failed_rate_pct: ${report.totals.failed_rate_pct}`);
  lines.push(`- reported_cost_usd: ${report.totals.reported_cost_usd}`);
  lines.push(`- oauth_reported_cost_usd: ${report.totals.oauth_reported_cost_usd}`);
  lines.push(`- claude_code_reported_cost_usd: ${report.totals.claude_code_reported_cost_usd}`);
  lines.push(`- claude_code_runtime_cost_share_pct: ${report.totals.claude_code_runtime_cost_share_pct}`);
  lines.push(`- non_oauth_reported_cost_usd: ${report.totals.non_oauth_reported_cost_usd}`);
  lines.push(`- anthropic_provider_calls: ${report.totals.anthropic_provider_calls}`);
  lines.push(`- selector_claude_code_primary_share_pct: ${report.selector_matrix.claude_code_primary_share_pct}`);
  lines.push(`- selector_claude_code_sonnet_primary_share_pct: ${report.selector_matrix.claude_code_sonnet_primary_share_pct}`);
  lines.push('');
  lines.push('| Provider | Calls | Share % | Success % | Avg ms | Cost USD |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const provider of PROVIDER_ORDER) {
    const row = report.providers[provider];
    lines.push(`| ${providerLabel(provider)} | ${row.calls} | ${row.share_pct.toFixed(2)} | ${row.success_rate_pct.toFixed(2)} | ${row.avg_duration_ms} | ${row.total_cost_usd.toFixed(6)} |`);
  }
  lines.push('');
  lines.push('## Selector Matrix');
  lines.push('');
  lines.push(`- selector_version: ${report.selector_matrix.selector_version}`);
  lines.push(`- checked_selector_keys: ${report.selector_matrix.checked.selector_keys}`);
  lines.push(`- checked_agent_routes: ${report.selector_matrix.checked.agent_routes}`);
  lines.push(`- selector_primary_provider_counts: ${JSON.stringify(report.selector_matrix.primary_provider_counts)}`);
  lines.push(`- selector_primary_provider_shares: ${JSON.stringify(report.selector_matrix.primary_provider_shares)}`);
  lines.push(`- selector_primary_model_counts: ${JSON.stringify(report.selector_matrix.primary_model_counts)}`);
  lines.push(`- selector_primary_model_shares: ${JSON.stringify(report.selector_matrix.primary_model_shares)}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  for (const [key, value] of Object.entries(report.verdict)) {
    lines.push(`- ${key}: ${value}`);
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const stats = await fetchStats(HOURS);
  const report = buildReport(stats);
  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT_MD), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(OUTPUT_MD, renderMarkdown(report), 'utf8');
  console.log(JSON.stringify({
    ok: report.ok,
    strict: STRICT,
    output_json: OUTPUT_JSON,
    output_markdown: OUTPUT_MD,
    totals: report.totals,
    verdict: report.verdict,
    warnings: report.warnings,
  }, null, 2));
  process.exitCode = STRICT ? (report.ok ? 0 : 1) : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error('[llm-oauth4-master-review] failed:', error?.message || error);
    process.exitCode = 1;
  });
}

export {
  buildReport,
  buildSelectorSnapshot,
  normalizeProviderRow,
  renderMarkdown,
};
