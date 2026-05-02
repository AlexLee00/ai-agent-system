#!/usr/bin/env tsx
// @ts-nocheck

import fs from 'fs';
import path from 'path';

const HUB_BASE = process.env.HUB_BASE_URL || 'http://localhost:7788';
const HUB_TOKEN = process.env.HUB_AUTH_TOKEN || '';
const HOURS = Math.min(Math.max(Number(process.env.LLM_OAUTH4_REVIEW_HOURS || 168), 1), 24 * 30);
const STRICT = ['1', 'true', 'yes', 'on'].includes(String(process.env.LLM_OAUTH4_REVIEW_STRICT || '').trim().toLowerCase());
const OUTPUT_JSON = path.resolve(
  process.env.LLM_OAUTH4_REVIEW_JSON
    || '/Users/alexlee/projects/ai-agent-system/bots/hub/output/llm-oauth4-master-review.json',
);
const OUTPUT_MD = path.resolve(
  process.env.LLM_OAUTH4_REVIEW_MD
    || '/Users/alexlee/projects/ai-agent-system/docs/hub/LLM_OAUTH4_MASTER_REVIEW.md',
);

const PROVIDER_ORDER = [
  'claude-code-oauth',
  'openai-oauth',
  'gemini-cli-oauth',
  'gemini-oauth',
  'groq',
  'failed',
];

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

function providerLabel(provider = '') {
  if (provider === 'claude-code-oauth') return 'Claude Code OAuth';
  if (provider === 'openai-oauth') return 'OpenAI OAuth';
  if (provider === 'gemini-cli-oauth') return 'Gemini CLI OAuth';
  if (provider === 'gemini-oauth') return 'Gemini OAuth';
  if (provider === 'groq') return 'Groq';
  if (provider === 'failed') return 'Failed';
  return provider || 'unknown';
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

function buildReport(stats) {
  const rows = Array.isArray(stats.summary) ? stats.summary.map(normalizeProviderRow) : [];
  const totalCalls = rows.reduce((sum, row) => sum + row.calls, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.total_cost_usd, 0);
  const failedCalls = rows.find((row) => row.provider === 'failed')?.calls || 0;
  const oauthCalls = rows
    .filter((row) => ['claude-code-oauth', 'openai-oauth', 'gemini-cli-oauth', 'gemini-oauth'].includes(row.provider))
    .reduce((sum, row) => sum + row.calls, 0);
  const anthropicCalls = rows
    .filter((row) => row.provider === 'anthropic')
    .reduce((sum, row) => sum + row.calls, 0);
  const byProvider = {};
  for (const provider of PROVIDER_ORDER) {
    const row = rows.find((candidate) => candidate.provider === provider) || normalizeProviderRow({ provider });
    byProvider[provider] = {
      ...row,
      share_pct: totalCalls > 0 ? Number(((row.calls / totalCalls) * 100).toFixed(2)) : 0,
      success_rate_pct: row.calls > 0 ? Number(((row.success_count / row.calls) * 100).toFixed(2)) : 0,
    };
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
      failed_rate_pct: totalCalls > 0 ? Number(((failedCalls / totalCalls) * 100).toFixed(2)) : 0,
      total_cost_usd: Number(totalCost.toFixed(6)),
      anthropic_provider_calls: anthropicCalls,
    },
    providers: byProvider,
    targets: {
      claude_code_primary_share_target_pct: 50,
      anthropic_provider_calls_target: 0,
      free_cost_target_usd: 0,
    },
    verdict: {
      claude_code_share_ok: byProvider['claude-code-oauth'].share_pct >= 45,
      anthropic_zero_ok: anthropicCalls === 0,
      free_cost_ok: totalCost === 0,
    },
  };
  review.ok = Boolean(review.verdict.claude_code_share_ok && review.verdict.anthropic_zero_ok);
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
  lines.push(`- total_cost_usd: ${report.totals.total_cost_usd}`);
  lines.push(`- anthropic_provider_calls: ${report.totals.anthropic_provider_calls}`);
  lines.push('');
  lines.push('| Provider | Calls | Share % | Success % | Avg ms | Cost USD |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const provider of PROVIDER_ORDER) {
    const row = report.providers[provider];
    lines.push(`| ${providerLabel(provider)} | ${row.calls} | ${row.share_pct.toFixed(2)} | ${row.success_rate_pct.toFixed(2)} | ${row.avg_duration_ms} | ${row.total_cost_usd.toFixed(6)} |`);
  }
  lines.push('');
  lines.push(`- claude_code_share_ok: ${report.verdict.claude_code_share_ok}`);
  lines.push(`- anthropic_zero_ok: ${report.verdict.anthropic_zero_ok}`);
  lines.push(`- free_cost_ok: ${report.verdict.free_cost_ok}`);
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
  }, null, 2));
  process.exitCode = STRICT ? (report.ok ? 0 : 1) : 0;
}

main().catch((error) => {
  console.error('[llm-oauth4-master-review] failed:', error?.message || error);
  process.exitCode = 1;
});
