import kst = require('./kst');
import env = require('./env');
import pgPool = require('./pg-pool');
import billingGuard = require('./billing-guard');

type LLMLogInput = {
  team: string;
  bot: string;
  model: string;
  market?: string | null;
  symbol?: string | null;
  guardScope?: string | null;
  requestType?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  cacheHit?: boolean;
  latencyMs?: number | null;
  success?: boolean;
  errorMsg?: string | null;
};

type CostRow = {
  team: string;
  total?: string | number;
  cache_hits?: string | number;
  calls?: string | number;
  bot?: string;
  model?: string;
  request_type?: string;
  total_cost?: string | number;
  total_tokens?: string | number;
  avg_latency_ms?: string | number;
  day?: string;
  daily_cost?: number;
  success_rate?: string | number;
};

type Recommendation = {
  team: string;
  bot: string;
  currentModel: string;
  recommendModel: string;
  reason: string;
  estimatedSaving: number;
  priority: string;
};

const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;

const EMERGENCY_LIMITS = {
  daily: parseFloat(process.env.BILLING_LIMIT_DAILY || '10'),
  hourly: parseFloat(process.env.BILLING_LIMIT_HOURLY || '3'),
  perCall: parseFloat(process.env.BILLING_LIMIT_PER_CALL || '1'),
  spikeRatio: parseFloat(process.env.BILLING_SPIKE_RATIO || '5'),
};

let initialized = false;

const PRICING: Record<string, { input: number; output: number }> = {
  'groq/llama-4-scout-17b-16e-instruct': { input: 0, output: 0 },
  'meta-llama/llama-4-scout-17b-16e-instruct': { input: 0, output: 0 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-opus-4-6': { input: 15.0, output: 75.0 },
  'claude-code/sonnet': { input: 3.0, output: 15.0 },
  'claude-code/opus': { input: 15.0, output: 75.0 },
  'gemini-oauth/gemini-2.5-flash': { input: 0, output: 0 },
  'google-gemini-cli/gemini-2.5-flash': { input: 0, output: 0 },
  'gemini-2.5-flash': { input: 0, output: 0 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'openai/gpt-oss-20b': { input: 0, output: 0 },
  'gpt-oss-20b': { input: 0, output: 0 },
  'qwen/qwen3-32b': { input: 0.29, output: 0.59 },
  'qwen3-32b': { input: 0.29, output: 0.59 },
  'meta-llama/llama-4-maverick-17b-128e-instruct': { input: 0, output: 0 },
  'llama-3.3-70b-versatile': { input: 0, output: 0 },
};

const BATCH_TEAMS = new Set(['blog']);
const INVESTMENT_TEAMS = new Set(['luna', 'nemesis', 'oracle', 'argos', 'hermes', 'sophia', 'athena', 'zeus', 'investment']);

function kstNow(): string {
  return kst.datetimeStr();
}

function kstDate(): string {
  return kst.today();
}

function normalizeModel(model: string): string {
  if (!model) return '';
  if (model === 'claude-code/sonnet' || model === 'sonnet') return 'claude-code/sonnet';
  if (model === 'claude-code/opus' || model === 'opus') return 'claude-code/opus';
  if (model.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
  if (model.startsWith('gpt-4o')) return 'gpt-4o';
  const claudeMatch = model.match(/^(claude-(?:haiku|sonnet|opus)-[\d.-]+)/);
  if (claudeMatch) return claudeMatch[1];
  return model;
}

export function _calcCostForModel(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[normalizeModel(model)] || PRICING[model] || { input: 0, output: 0 };
  return ((inputTokens * pricing.input) + (outputTokens * pricing.output)) / 1_000_000;
}

async function ensureTable(): Promise<void> {
  if (initialized) return;
  if (DEV_HUB_READONLY) {
    initialized = true;
    return;
  }
  await pgPool.run('reservation', `
    CREATE TABLE IF NOT EXISTS llm_usage_log (
      id            SERIAL PRIMARY KEY,
      timestamp     TEXT NOT NULL,
      team          TEXT NOT NULL,
      bot           TEXT NOT NULL,
      model         TEXT NOT NULL,
      market        TEXT,
      symbol        TEXT,
      guard_scope   TEXT,
      request_type  TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      cache_hit     INTEGER NOT NULL DEFAULT 0,
      latency_ms    INTEGER,
      success       INTEGER NOT NULL DEFAULT 1,
      error_msg     TEXT,
      created_at    TEXT NOT NULL
    )
  `);
  await pgPool.run('reservation', `ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS market TEXT`);
  await pgPool.run('reservation', `ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS symbol TEXT`);
  await pgPool.run('reservation', `ALTER TABLE llm_usage_log ADD COLUMN IF NOT EXISTS guard_scope TEXT`);
  await pgPool.run('reservation', `CREATE INDEX IF NOT EXISTS idx_llm_log_team ON llm_usage_log(team, created_at)`);
  await pgPool.run('reservation', `CREATE INDEX IF NOT EXISTS idx_llm_log_bot ON llm_usage_log(team, bot, created_at)`);
  await pgPool.run('reservation', `CREATE INDEX IF NOT EXISTS idx_llm_log_market_symbol ON llm_usage_log(team, market, symbol, created_at)`);
  initialized = true;
}

function normalizeScopeToken(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveTeamEmergencyScope(team: string, meta: { market?: string | null; symbol?: string | null } = {}): string {
  const normalized = String(team || '').trim().toLowerCase();
  if (INVESTMENT_TEAMS.has(normalized)) {
    const mode = String(process.env.INVESTMENT_TRADE_MODE || 'normal').trim().toLowerCase();
    const rail = `investment.${mode === 'validation' ? 'validation' : 'normal'}`;
    const market = String(meta.market || process.env.INVESTMENT_MARKET || '').trim().toLowerCase();
    if (['crypto', 'domestic', 'overseas'].includes(market)) {
      const symbolToken = normalizeScopeToken(meta.symbol || '');
      if (symbolToken) return `${rail}.${market}.${symbolToken}`;
      return `${rail}.${market}`;
    }
    return rail;
  }
  return normalized || 'global';
}

function resolveEmergencyTtlMs(scope = 'global'): number {
  return billingGuard.getDefaultAutoTtlMs?.(scope) || 0;
}

function triggerEmergency(reason: string, cost: number, scope = 'global', options: { ttlMs?: number } = {}): void {
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : resolveEmergencyTtlMs(scope);
  const stopData = billingGuard.activate(reason, cost, 'llm-logger', scope, { ttlMs });

  try {
    const alertPublisher = require('../../../bots/claude/lib/alert-publisher') as any;
    const publish = alertPublisher.publishAlert
      || alertPublisher.default?.publishAlert;
    if (publish) {
      publish({
        from_bot: 'dexter',
        event_type: 'billing_emergency',
        alert_level: 3,
        message: [
          '🚨 *LLM 긴급 차단 발동!*',
          '',
          `사유: ${reason}`,
          `비용: $${cost.toFixed(4)}`,
          `시각: ${kst.datetimeStr()} KST`,
          ttlMs > 0 && stopData?.expires_at ? `자동 해제: ${String(stopData.expires_at).replace('T', ' ').replace('Z', ' UTC')}` : null,
          '',
          '⚠️ 모든 LLM 호출 즉시 중단됨',
          `해제: \`rm ${scope === 'global' ? '.llm-emergency-stop' : `.llm-emergency-stop.${billingGuard.normalizeScope(scope)}`}\` (마스터만)`,
        ].filter(Boolean).join('\n'),
      }).catch(() => {});
    }
  } catch {
    // ignore alarm failure
  }
}

async function checkEmergencyLimits(cost: number, team: string, meta: { market?: string | null; symbol?: string | null; guardScope?: string | null } = {}): Promise<void> {
  const scopedGuard = resolveTeamEmergencyScope(team, meta);
  if (billingGuard.isBlocked(scopedGuard) || billingGuard.isBlocked('global')) return;

  try {
    if (cost > EMERGENCY_LIMITS.perCall) {
      triggerEmergency(`단건 $${cost.toFixed(4)} > 한도 $${EMERGENCY_LIMITS.perCall}`, cost);
      return;
    }

    const hrRow = await pgPool.get('reservation',
      `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log WHERE created_at::timestamptz > NOW() - INTERVAL '1 hour'`);
    const hourlyCost = parseFloat(String(hrRow?.t || 0));
    if (hourlyCost > EMERGENCY_LIMITS.hourly) {
      triggerEmergency(`시간당 $${hourlyCost.toFixed(4)} > 한도 $${EMERGENCY_LIMITS.hourly}`, hourlyCost);
      return;
    }

    const dyRow = await pgPool.get('reservation',
      `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log WHERE created_at::date = CURRENT_DATE`);
    const dailyCost = parseFloat(String(dyRow?.t || 0));
    if (dailyCost > EMERGENCY_LIMITS.daily) {
      triggerEmergency(`일일 $${dailyCost.toFixed(4)} > 한도 $${EMERGENCY_LIMITS.daily}`, dailyCost);
      return;
    }

    if (!BATCH_TEAMS.has(team)) {
      const hasScopedSymbol = Boolean(meta.symbol && meta.market);
      if (!hasScopedSymbol) {
        const recentRow = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND created_at::timestamptz > NOW() - INTERVAL '10 minutes'`,
          [team]);
        const previousRow = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND created_at::timestamptz BETWEEN NOW() - INTERVAL '20 minutes' AND NOW() - INTERVAL '10 minutes'`,
          [team]);
        const recent = parseFloat(String(recentRow?.t || 0));
        const previous = parseFloat(String(previousRow?.t || 0));
        if (previous > 0.01 && recent / previous >= EMERGENCY_LIMITS.spikeRatio) {
          triggerEmergency(`[${team}] 10분 급등 ${(recent / previous).toFixed(1)}배 ($${recent.toFixed(4)})`, recent, scopedGuard);
        }
      }

      if (hasScopedSymbol) {
        const recentSymbolRow = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND market = $2 AND symbol = $3
             AND created_at::timestamptz > NOW() - INTERVAL '10 minutes'`,
          [team, meta.market, meta.symbol]);
        const previousSymbolRow = await pgPool.get('reservation',
          `SELECT COALESCE(SUM(cost_usd),0)::float AS t FROM llm_usage_log
           WHERE team = $1 AND market = $2 AND symbol = $3
             AND created_at::timestamptz BETWEEN NOW() - INTERVAL '20 minutes' AND NOW() - INTERVAL '10 minutes'`,
          [team, meta.market, meta.symbol]);
        const recentSymbol = parseFloat(String(recentSymbolRow?.t || 0));
        const previousSymbol = parseFloat(String(previousSymbolRow?.t || 0));
        if (previousSymbol > 0.01 && recentSymbol / previousSymbol >= EMERGENCY_LIMITS.spikeRatio) {
          triggerEmergency(
            `[${team}:${meta.market}:${meta.symbol}] 10분 급등 ${(recentSymbol / previousSymbol).toFixed(1)}배 ($${recentSymbol.toFixed(4)})`,
            recentSymbol,
            scopedGuard,
          );
        }
      }
    }
  } catch (error) {
    console.warn(`[llm-logger] 긴급 한도 체크 실패 (무시): ${(error as Error).message}`);
  }
}

export async function logLLMCall({
  team,
  bot,
  model,
  market = null,
  symbol = null,
  guardScope = null,
  requestType = 'unknown',
  inputTokens = 0,
  outputTokens = 0,
  costUsd,
  cacheHit = false,
  latencyMs = null,
  success = true,
  errorMsg = null,
}: LLMLogInput): Promise<void> {
  if (DEV_HUB_READONLY) return;
  try {
    await ensureTable();
    const cost = costUsd !== undefined ? costUsd : _calcCostForModel(model, inputTokens, outputTokens);
    const now = kstNow();
    const effectiveGuardScope = guardScope || resolveTeamEmergencyScope(team, { market, symbol });

    await pgPool.run('reservation', `
      INSERT INTO llm_usage_log
        (timestamp, team, bot, model, market, symbol, guard_scope, request_type,
         input_tokens, output_tokens, cost_usd,
         cache_hit, latency_ms, success, error_msg, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    `, [
      now, team, bot, model, market, symbol, effectiveGuardScope, requestType,
      inputTokens, outputTokens, cost,
      cacheHit ? 1 : 0, latencyMs,
      success ? 1 : 0, errorMsg, now,
    ]);

    if (success && cost > 0) {
      checkEmergencyLimits(cost, team, { market, symbol, guardScope: effectiveGuardScope }).catch(() => {});
    }
  } catch (error) {
    console.warn(`[llm-logger] 기록 실패 (${bot}): ${(error as Error).message}`);
  }
}

export async function getDailyCost(team?: string, dateKst?: string): Promise<any> {
  await ensureTable();
  const date = dateKst || kstDate();

  if (team) {
    const row = await pgPool.get('reservation', `
      SELECT SUM(cost_usd)::float   AS total,
             SUM(cache_hit)         AS cache_hits,
             COUNT(*)               AS calls
      FROM llm_usage_log
      WHERE team = $1 AND created_at::date = $2::date
    `, [team, date]);
    return {
      team,
      date,
      total: parseFloat(String(row?.total || 0)),
      cacheHits: parseInt(String(row?.cache_hits || 0), 10),
      calls: parseInt(String(row?.calls || 0), 10),
    };
  }

  return pgPool.query('reservation', `
    SELECT team,
           SUM(cost_usd)::float AS total,
           SUM(cache_hit)       AS cache_hits,
           COUNT(*)             AS calls
    FROM llm_usage_log
    WHERE created_at::date = $1::date
    GROUP BY team
    ORDER BY total DESC
  `, [date]);
}

export async function getCostBreakdown(team?: string, days = 7): Promise<any[]> {
  await ensureTable();
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0];

  if (team) {
    return pgPool.query('reservation', `
      SELECT team, bot, model, request_type,
             SUM(cost_usd)::float                AS total_cost,
             SUM(input_tokens + output_tokens)   AS total_tokens,
             SUM(cache_hit)                      AS cache_hits,
             COUNT(*)                            AS calls,
             AVG(latency_ms)::integer            AS avg_latency_ms
      FROM llm_usage_log
      WHERE team = $1 AND created_at::date >= $2::date
      GROUP BY team, bot, model, request_type
      ORDER BY total_cost DESC, total_tokens DESC
    `, [team, cutoff]) as Promise<any[]>;
  }

  return pgPool.query('reservation', `
    SELECT team, bot, model, request_type,
           SUM(cost_usd)::float                AS total_cost,
           SUM(input_tokens + output_tokens)   AS total_tokens,
           SUM(cache_hit)                      AS cache_hits,
           COUNT(*)                            AS calls,
           AVG(latency_ms)::integer            AS avg_latency_ms
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model, request_type
    ORDER BY total_cost DESC, total_tokens DESC
  `, [cutoff]) as Promise<any[]>;
}

export async function buildDailyCostReport(): Promise<string> {
  const today = kstDate();
  const rows = await getDailyCost(undefined, today) as CostRow[];

  if (!Array.isArray(rows) || rows.length === 0) {
    return `💰 LLM 일간 비용 리포트 (${today})\n  데이터 없음`;
  }

  const totalCost = rows.reduce((sum, row) => sum + (parseFloat(String(row.total || 0)) || 0), 0);
  const totalCalls = rows.reduce((sum, row) => sum + (parseInt(String(row.calls || 0), 10) || 0), 0);
  const totalCached = rows.reduce((sum, row) => sum + (parseInt(String(row.cache_hits || 0), 10) || 0), 0);
  const savedPct = totalCalls > 0 ? Math.round(totalCached / totalCalls * 100) : 0;

  const TEAM_LABEL: Record<string, string> = { ska: '스카팀', claude: '클로드팀', luna: '루나팀', blog: '블로팀', worker: '워커팀' };
  const teamLines = rows.map((row) => {
    const label = TEAM_LABEL[row.team] || row.team;
    const tag = parseFloat(String(row.total || 0)) < 0.0001 ? '무료' : `$${parseFloat(String(row.total || 0)).toFixed(4)}`;
    return `  ${label}: ${tag} (${row.calls}회)`;
  });

  return [
    `💰 팀 제이 LLM 일간 비용 (${today})`,
    `──────────────────────`,
    ...teamLines,
    `──────────────────────`,
    `총계: $${totalCost.toFixed(4)}`,
    `캐시 절감: ${totalCached}회 (${savedPct}%)`,
  ].join('\n');
}

export async function analyzeCostTrend(days = 14): Promise<any> {
  await ensureTable();
  const half = Math.floor(days / 2);
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0];
  const midDate = new Date(Date.now() - half * 86400 * 1000).toISOString().split('T')[0];

  const rows = await pgPool.query('reservation', `
    SELECT created_at::date AS day, SUM(cost_usd)::float AS daily_cost
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY day ORDER BY day
  `, [cutoff]) as CostRow[];

  const thisWeekRows = rows.filter((row) => String(row.day) >= midDate);
  const lastWeekRows = rows.filter((row) => String(row.day) < midDate);

  const thisWeekCost = thisWeekRows.reduce((sum, row) => sum + Number(row.daily_cost || 0), 0);
  const lastWeekCost = lastWeekRows.reduce((sum, row) => sum + Number(row.daily_cost || 0), 0);
  const weekOverWeek = lastWeekCost > 0
    ? ((thisWeekCost - lastWeekCost) / lastWeekCost * 100)
    : null;
  const avgDaily = rows.length > 0
    ? rows.reduce((sum, row) => sum + Number(row.daily_cost || 0), 0) / rows.length
    : 0;

  return { thisWeekCost, lastWeekCost, weekOverWeek, avgDaily, dailyRows: rows };
}

export async function analyzeModelEfficiency(days = 30): Promise<{ models: CostRow[]; recommendations: Recommendation[] }> {
  await ensureTable();
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString().split('T')[0];

  const models = await pgPool.query('reservation', `
    SELECT team, bot, model,
           COUNT(*)                            AS calls,
           SUM(cost_usd)::float                AS total_cost,
           AVG(latency_ms)::integer            AS avg_latency,
           ROUND(AVG(success) * 100)::integer  AS success_rate
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model
    ORDER BY total_cost DESC
  `, [cutoff]) as CostRow[];

  const recommendations = models
    .filter((model) => model.model === 'gpt-4o' && parseFloat(String(model.total_cost || 0)) > 0.05 && parseInt(String(model.calls || 0), 10) >= 5)
    .map((model) => ({
      team: model.team,
      bot: String(model.bot || ''),
      currentModel: String(model.model || ''),
      recommendModel: 'gpt-4o-mini',
      reason: `${model.calls}회 호출, $${parseFloat(String(model.total_cost || 0)).toFixed(4)} 소요 — 단순 작업이라면 gpt-4o-mini로 97% 절감 가능`,
      estimatedSaving: parseFloat(String(model.total_cost || 0)) * 0.94,
      priority: parseFloat(String(model.total_cost || 0)) > 0.5 ? 'high' : 'medium',
    }));

  return { models, recommendations };
}

export async function buildWeeklyFeedbackReport(): Promise<string> {
  const trend = await analyzeCostTrend(14);
  const { models, recommendations } = await analyzeModelEfficiency(7);

  const today = kstDate();
  const totalCost = models.reduce((sum, model) => sum + parseFloat(String(model.total_cost || 0)), 0);
  const totalCalls = models.reduce((sum, model) => sum + parseInt(String(model.calls || 0), 10), 0);
  const freeCalls = models
    .filter((model) => String(model.model || '').includes('llama') || String(model.model || '').includes('gemini'))
    .reduce((sum, model) => sum + parseInt(String(model.calls || 0), 10), 0);

  const lines = [
    `📊 팀 제이 LLM 주간 피드백 리포트 (${today})`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `💰 비용 현황 (최근 7일)`,
    `  총 비용:   $${totalCost.toFixed(4)}`,
    `  총 호출:   ${totalCalls}회 (무료 ${freeCalls}회 포함)`,
    `  일 평균:   $${(trend.avgDaily || 0).toFixed(4)}`,
    trend.weekOverWeek != null
      ? `  전주 대비: ${trend.weekOverWeek > 0 ? '+' : ''}${trend.weekOverWeek.toFixed(1)}%`
      : `  전주 대비: 데이터 부족`,
    ``,
    `🤖 모델별 사용 TOP5`,
    ...models.slice(0, 5).map((model) =>
      `  ${model.team}/${model.bot} [${String(model.model || '').slice(0, 20)}] $${parseFloat(String(model.total_cost || 0)).toFixed(4)} ${model.calls}회`,
    ),
    ``,
  ];

  if (recommendations.length > 0) {
    lines.push(`💡 최적화 추천`);
    recommendations.forEach((recommendation, index) => {
      lines.push(`  ${index + 1}. [${recommendation.priority.toUpperCase()}] ${recommendation.team}/${recommendation.bot}`);
      lines.push(`     ${recommendation.currentModel} → ${recommendation.recommendModel}`);
      lines.push(`     절감 예상: $${recommendation.estimatedSaving.toFixed(4)}`);
    });
  } else {
    lines.push(`💡 최적화 추천: 없음 (이미 최적 또는 데이터 부족)`);
  }

  return lines.join('\n');
}
