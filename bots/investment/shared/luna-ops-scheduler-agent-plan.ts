// @ts-nocheck

const IMMUTABLE_JOB_NAMES = new Set([
  'market_regime_capture',
  'market_cycle_crypto',
  'market_cycle_domestic',
  'market_cycle_domestic_open_catchup',
  'market_cycle_overseas',
  'guardrails_hourly',
  'reconcile_auto_settle',
]);

const DEFAULT_MIN_INTERVAL_SECONDS = 60;
const DEFAULT_MAX_INTERVAL_SECONDS = 86_400;

function normalizeObject(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function parseJsonObject(value = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  try {
    return normalizeObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function firstObject(...values) {
  for (const value of values) {
    const objectValue = normalizeObject(value) || parseJsonObject(value);
    if (objectValue) return objectValue;
  }
  return null;
}

function normalizeList(value = null) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeJobName(value = '') {
  return String(value || '').trim();
}

function normalizeCategory(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeMarket(value = '') {
  return String(value || '').trim().toLowerCase();
}

export function classifyOpsSchedulerJob(job = {}) {
  const name = normalizeJobName(job?.name);
  if (job?.category) {
    return {
      category: normalizeCategory(job.category),
      market: normalizeMarket(job.market || ''),
      immutable: job.immutable === true || IMMUTABLE_JOB_NAMES.has(name),
    };
  }
  if (name.includes('market_cycle')) {
    return {
      category: 'market_cycle',
      market: name.includes('crypto') ? 'crypto' : name.includes('domestic') ? 'domestic' : name.includes('overseas') ? 'overseas' : '',
      immutable: true,
    };
  }
  if (name === 'market_regime_capture') return { category: 'market_state', market: 'all', immutable: true };
  if (name === 'reconcile_auto_settle') return { category: 'reconcile', market: 'all', immutable: true };
  if (name === 'guardrails_hourly') return { category: 'guardrail', market: 'all', immutable: true };
  if (name.includes('candidate') || name.includes('discovery')) return { category: 'discovery', market: name.includes('crypto') ? 'crypto' : name.includes('domestic') ? 'domestic' : 'all', immutable: false };
  if (name.includes('near_miss')) return { category: 'watchlist', market: name.includes('crypto') ? 'crypto' : name.includes('domestic') ? 'domestic' : 'all', immutable: false };
  if (name.includes('backtest')) return { category: 'backtest', market: 'all', immutable: false };
  if (name.includes('checkpoint') || name.includes('voyager')) return { category: 'learning', market: 'all', immutable: false };
  if (name.includes('dashboard') || name.includes('report')) return { category: 'report', market: 'all', immutable: false };
  return { category: 'ops', market: 'all', immutable: IMMUTABLE_JOB_NAMES.has(name) };
}

function extractAgentPlan(agentPlan = null) {
  const direct = firstObject(agentPlan);
  const envPlan = firstObject(process.env.LUNA_OPS_SCHEDULER_AGENT_PLAN_JSON);
  const plan = firstObject(
    direct?.opsScheduler,
    direct?.ops_scheduler,
    direct?.scheduler,
    direct,
    envPlan?.opsScheduler,
    envPlan?.ops_scheduler,
    envPlan?.scheduler,
    envPlan,
  );
  return plan;
}

function normalizeCadenceOverrides(plan = null) {
  const source = firstObject(
    plan?.cadenceOverrides,
    plan?.cadence_overrides,
    plan?.intervalSecondsByJob,
    plan?.interval_seconds_by_job,
  ) || {};
  return source;
}

function applyCadenceOverride(job, plan = null, warnings = []) {
  const cadenceOverrides = normalizeCadenceOverrides(plan);
  const raw = cadenceOverrides?.[job.name];
  if (raw === undefined || raw === null || raw === '') return job;
  if (job?.cadence?.type !== 'interval') {
    warnings.push(`cadence_override_non_interval_ignored:${job.name}`);
    return job;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    warnings.push(`invalid_cadence_override:${job.name}`);
    return job;
  }
  const min = Math.max(1, Number(plan?.minIntervalSeconds || plan?.min_interval_seconds || DEFAULT_MIN_INTERVAL_SECONDS));
  const max = Math.max(min, Number(plan?.maxIntervalSeconds || plan?.max_interval_seconds || DEFAULT_MAX_INTERVAL_SECONDS));
  const seconds = Math.min(max, Math.max(min, Math.round(parsed)));
  if (seconds !== parsed) warnings.push(`cadence_override_clamped:${job.name}`);
  return {
    ...job,
    cadence: {
      ...(job.cadence || {}),
      seconds,
    },
    agentPlanCadenceOverride: true,
  };
}

export function buildOpsSchedulerAgentPlan({
  agentPlan = null,
  jobs = [],
} = {}) {
  const plan = extractAgentPlan(agentPlan);
  const disabledJobs = new Set(normalizeList(plan?.disabledJobs || plan?.disabled_jobs).map(normalizeJobName));
  const enabledJobs = new Set(normalizeList(plan?.enabledJobs || plan?.enabled_jobs).map(normalizeJobName));
  const disabledCategories = new Set(normalizeList(plan?.disabledCategories || plan?.disabled_categories).map(normalizeCategory));
  const enabledCategories = new Set(normalizeList(plan?.enabledCategories || plan?.enabled_categories).map(normalizeCategory));
  const disabledMarkets = new Set(normalizeList(plan?.disabledMarkets || plan?.disabled_markets).map(normalizeMarket));
  const warnings = [];
  const skipped = [];
  const selectedJobs = [];

  for (const job of jobs) {
    const meta = classifyOpsSchedulerJob(job);
    const name = normalizeJobName(job.name);
    const category = meta.category || 'ops';
    const market = meta.market || 'all';
    const disabledByName = disabledJobs.has(name);
    const disabledByCategory = disabledCategories.has(category);
    const disabledByMarket = market && market !== 'all' && disabledMarkets.has(market);
    const enabledFilterActive = enabledJobs.size > 0 || enabledCategories.size > 0;
    const explicitlyEnabled = enabledJobs.has(name) || enabledCategories.has(category);
    const shouldDisable = disabledByName || disabledByCategory || disabledByMarket || (enabledFilterActive && !explicitlyEnabled);

    if (shouldDisable && meta.immutable) {
      warnings.push(`immutable_scheduler_job:${name}`);
      selectedJobs.push(applyCadenceOverride({ ...job, category, market, immutable: true }, plan, warnings));
      continue;
    }

    if (shouldDisable) {
      skipped.push({
        name,
        category,
        market,
        reason: disabledByName
          ? 'disabled_by_job'
          : disabledByCategory
            ? 'disabled_by_category'
            : disabledByMarket
              ? 'disabled_by_market'
              : 'not_in_enabled_filter',
      });
      continue;
    }

    selectedJobs.push(applyCadenceOverride({ ...job, category, market, immutable: meta.immutable }, plan, warnings));
  }

  return {
    source: plan ? 'override' : 'default_ops_scheduler_plan',
    overrideRequested: Boolean(plan),
    totalJobs: jobs.length,
    selectedJobs: selectedJobs.length,
    skippedJobs: skipped,
    warnings,
    jobs: selectedJobs,
  };
}

export default {
  buildOpsSchedulerAgentPlan,
  classifyOpsSchedulerJob,
};
