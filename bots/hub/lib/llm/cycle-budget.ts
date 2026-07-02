// @ts-nocheck

const path = require('node:path');
const pgPool = require(path.resolve(__dirname, '../../../..', 'packages/core/lib/pg-pool.ts'));

const DEFAULT_MAX_CALLS = 200;
const DEFAULT_MAX_USD = 1.0;
const DEFAULT_MAX_MINUTES = 60;
const DEFAULT_REPEAT_WARN_COUNT = 30;

function envNumber(name, fallback, min = 0) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function envInt(name, fallback, min = 0) {
  return Math.floor(envNumber(name, fallback, min));
}

function cycleBudgetConfig() {
  return {
    maxCalls: envInt('HUB_CYCLE_MAX_CALLS', DEFAULT_MAX_CALLS, 1),
    maxUsd: envNumber('HUB_CYCLE_MAX_USD', DEFAULT_MAX_USD, 0),
    maxMinutes: envInt('HUB_CYCLE_MAX_MINUTES', DEFAULT_MAX_MINUTES, 1),
    repeatWarnCount: envInt('HUB_CYCLE_REPEAT_WARN_COUNT', DEFAULT_REPEAT_WARN_COUNT, 2),
  };
}

function cycleGuardMode() {
  const raw = String(process.env.HUB_CYCLE_GUARD_MODE || 'off').trim().toLowerCase();
  return ['advisory', 'enforce'].includes(raw) ? raw : 'off';
}

function normalizeCycleId(value) {
  const normalized = String(value || '').trim();
  return normalized ? normalized.slice(0, 240) : '';
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCycleBudgetReportFromRows({ cycleId, rows = [], config = cycleBudgetConfig(), now = new Date() } = {}) {
  const repeatCounts = new Map();
  let totalDurationMs = 0;
  let totalCostUsd = 0;
  let promptChars = 0;
  let successCount = 0;

  for (const row of rows) {
    totalDurationMs += Math.max(0, Number(row.duration_ms || 0) || 0);
    totalCostUsd += money(row.cost_usd);
    promptChars += Math.max(0, Number(row.prompt_chars || 0) || 0);
    if (row.success === true || row.success === 't' || row.success === 'true') successCount += 1;
    const key = String(row.prompt_hash || row.request_fingerprint || row.selected_route || '').trim();
    if (key) repeatCounts.set(key, (repeatCounts.get(key) || 0) + 1);
  }

  const topRepeat = [...repeatCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([fingerprint, count]) => ({ fingerprint, count }));

  const calls = rows.length;
  const blockers = [];
  const warnings = [];
  if (calls > config.maxCalls) blockers.push({ type: 'call_budget', calls, limit: config.maxCalls });
  if (totalCostUsd > config.maxUsd) blockers.push({ type: 'cost_budget', costUsd: totalCostUsd, limit: config.maxUsd });
  if ((topRepeat[0]?.count || 0) >= config.repeatWarnCount) {
    warnings.push({ type: 'convergence_loop', repeatCount: topRepeat[0].count, fingerprint: topRepeat[0].fingerprint });
  }

  return {
    ok: blockers.length === 0,
    source: 'hub_cycle_budget_guard',
    mode: 'read_only_select',
    cycleId: normalizeCycleId(cycleId),
    checkedAt: now.toISOString(),
    config,
    metrics: {
      calls,
      success: successCount,
      successRate: calls > 0 ? successCount / calls : null,
      durationMs: totalDurationMs,
      costUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
      promptChars,
      estimatedTokens: Math.ceil(promptChars / 4),
      topRepeat,
    },
    warnings,
    blockers,
    advisoryOnly: true,
    liveMutation: false,
  };
}

async function traceColumnsExist(queryReadonly = pgPool.queryReadonly) {
  const rows = await queryReadonly('public', `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'llm_routing_log'
      AND column_name = ANY($1::text[])
  `, [['cycle_id', 'prompt_hash', 'request_fingerprint', 'prompt_chars', 'estimated_cost_usd', 'cost_usd', 'duration_ms']]);
  const columns = new Set(rows.map((row) => row.column_name));
  return columns.has('cycle_id') && columns.has('duration_ms');
}

async function fetchCycleBudgetRows(cycleId, options = {}) {
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const normalizedCycleId = normalizeCycleId(cycleId);
  if (!normalizedCycleId) return { skipped: true, reason: 'cycle_id_missing', rows: [] };
  const hasColumns = await traceColumnsExist(queryReadonly);
  if (!hasColumns) return { skipped: true, reason: 'cycle_budget_columns_missing', rows: [] };
  const minutes = envInt('HUB_CYCLE_MAX_MINUTES', DEFAULT_MAX_MINUTES, 1);
  const rows = await queryReadonly('public', `
    SELECT
      created_at,
      success,
      duration_ms,
      prompt_hash,
      request_fingerprint,
      selected_route,
      prompt_chars,
      COALESCE(NULLIF(estimated_cost_usd, 0), cost_usd, 0)::float AS cost_usd
    FROM public.llm_routing_log
    WHERE cycle_id = $1
      AND created_at >= NOW() - ($2::int * INTERVAL '1 minute')
    ORDER BY created_at DESC
    LIMIT 10000
  `, [normalizedCycleId, minutes]);
  return { skipped: false, rows };
}

async function buildCycleBudgetReport(cycleId, options = {}) {
  const normalizedCycleId = normalizeCycleId(cycleId);
  if (!normalizedCycleId) {
    return {
      ok: true,
      skipped: true,
      source: 'hub_cycle_budget_guard',
      reason: 'cycle_id_missing',
      cycleId: null,
      advisoryOnly: true,
      liveMutation: false,
    };
  }
  try {
    const result = await fetchCycleBudgetRows(normalizedCycleId, options);
    if (result.skipped) {
      return {
        ok: true,
        skipped: true,
        source: 'hub_cycle_budget_guard',
        reason: result.reason,
        cycleId: normalizedCycleId,
        advisoryOnly: true,
        liveMutation: false,
      };
    }
    return buildCycleBudgetReportFromRows({
      cycleId: normalizedCycleId,
      rows: result.rows,
      config: options.config || cycleBudgetConfig(),
      now: options.now || new Date(),
    });
  } catch (error) {
    return {
      ok: true,
      skipped: true,
      source: 'hub_cycle_budget_guard',
      reason: 'cycle_budget_query_failed',
      error: String(error?.message || error).slice(0, 240),
      cycleId: normalizedCycleId,
      advisoryOnly: true,
      liveMutation: false,
    };
  }
}

function summarizeCycleBudget(report) {
  if (!report || report.skipped) return '';
  const blockers = (report.blockers || []).map((item) => item.type).join(',');
  const warnings = (report.warnings || []).map((item) => item.type).join(',');
  if (blockers) return `cycle_budget_blocked:${blockers}`;
  if (warnings) return `cycle_budget_warning:${warnings}`;
  return '';
}

module.exports = {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_USD,
  DEFAULT_MAX_MINUTES,
  DEFAULT_REPEAT_WARN_COUNT,
  cycleBudgetConfig,
  cycleGuardMode,
  normalizeCycleId,
  buildCycleBudgetReportFromRows,
  buildCycleBudgetReport,
  summarizeCycleBudget,
};

