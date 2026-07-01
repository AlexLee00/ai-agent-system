import crypto from 'node:crypto';
import pgPool = require('./pg-pool');

type Priority = 'low' | 'normal' | 'high' | 'critical';

type TokenBudgetProfile = {
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxTotalTokens: number;
  maxCostUsd: number;
  timeoutMs: number;
  perAttemptTimeoutMs: number;
  fallbackAttempts: number;
};

type TokenBudgetRequest = {
  callerTeam?: string | null;
  agent?: string | null;
  selectorKey?: string | null;
  taskType?: string | null;
  priority?: Priority | string | null;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  systemPrompt?: string | null;
  maxTokens?: number | null;
  timeoutMs?: number | null;
  maxBudgetUsd?: number | null;
  tokenBudgetProfile?: string | null;
  traceId?: string | null;
  requestId?: string | null;
};

type TokenBudgetCheck = {
  ok: boolean;
  reason?: string;
  profile: TokenBudgetProfile;
  profileName: string;
  callerTeam: string;
  agent: string;
  taskType: string;
  selectorKey: string | null;
  inputTokens: number;
  maxOutputTokens: number;
  estimatedTotalTokens: number;
  estimatedCostUsd: number;
  budgetCostUsd: number;
  timeoutMs: number;
  perAttemptTimeoutMs: number;
  fallbackAttempts: number;
  promptHash: string | null;
  requestFingerprint: string;
};

type FallbackEntry = {
  provider?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  [key: string]: any;
};

type UsageRecord = {
  traceId?: string | null;
  requestId?: string | null;
  callerTeam?: string | null;
  agent?: string | null;
  taskType?: string | null;
  selectorKey?: string | null;
  profileName?: string | null;
  provider?: string | null;
  model?: string | null;
  selectedRoute?: string | null;
  status?: string | null;
  error?: string | null;
  inputTokens?: number | null;
  maxOutputTokens?: number | null;
  estimatedTotalTokens?: number | null;
  estimatedCostUsd?: number | null;
  budgetCostUsd?: number | null;
  timeoutMs?: number | null;
  durationMs?: number | null;
  fallbackCount?: number | null;
  attemptedProviders?: string[] | null;
  promptHash?: string | null;
  requestFingerprint?: string | null;
  metadata?: Record<string, any> | null;
};

const TOKEN_CHARS_PER_TOKEN = 4;

const MODEL_PRICING_USD_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-5.4': { input: 3, output: 12 },
  'gpt-5.4-mini': { input: 0.6, output: 2.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-code/haiku': { input: 1, output: 5 },
  'claude-code/sonnet': { input: 3, output: 15 },
  'claude-code/opus': { input: 15, output: 75 },
  'claude-code-oauth/haiku': { input: 1, output: 5 },
  'claude-code-oauth/sonnet': { input: 3, output: 15 },
  'claude-code-oauth/opus': { input: 15, output: 75 },
};

const FREE_PROVIDER_PREFIXES = [
  'groq/',
  'gemini-cli-oauth/',
  'gemini-codeassist-oauth/',
  'local/',
  'local-embedding/',
];

const PROFILES: Record<string, TokenBudgetProfile> = {
  default: {
    name: 'default',
    maxInputTokens: 32_000,
    maxOutputTokens: 2_048,
    maxTotalTokens: 36_000,
    maxCostUsd: 0.08,
    timeoutMs: 60_000,
    perAttemptTimeoutMs: 30_000,
    fallbackAttempts: 3,
  },
  fast_triage: {
    name: 'fast_triage',
    maxInputTokens: 12_000,
    maxOutputTokens: 900,
    maxTotalTokens: 14_000,
    maxCostUsd: 0.03,
    timeoutMs: 25_000,
    perAttemptTimeoutMs: 12_000,
    fallbackAttempts: 2,
  },
  hub_alarm_interpreter: {
    name: 'hub_alarm_interpreter',
    maxInputTokens: 16_000,
    maxOutputTokens: 1_800,
    maxTotalTokens: 20_000,
    maxCostUsd: 0.05,
    timeoutMs: 45_000,
    perAttemptTimeoutMs: 20_000,
    fallbackAttempts: 3,
  },
  oauth_monitor: {
    name: 'oauth_monitor',
    maxInputTokens: 12_000,
    maxOutputTokens: 1_200,
    maxTotalTokens: 15_000,
    maxCostUsd: 0.04,
    timeoutMs: 45_000,
    perAttemptTimeoutMs: 20_000,
    fallbackAttempts: 2,
  },
  darwin_research: {
    name: 'darwin_research',
    maxInputTokens: 48_000,
    maxOutputTokens: 4_096,
    maxTotalTokens: 56_000,
    maxCostUsd: 0.2,
    timeoutMs: 120_000,
    perAttemptTimeoutMs: 60_000,
    fallbackAttempts: 3,
  },
  archer_batch_analysis: {
    name: 'archer_batch_analysis',
    maxInputTokens: 64_000,
    maxOutputTokens: 4_096,
    maxTotalTokens: 72_000,
    maxCostUsd: 0.12,
    timeoutMs: 240_000,
    perAttemptTimeoutMs: 240_000,
    fallbackAttempts: 3,
  },
  code_refactor: {
    name: 'code_refactor',
    maxInputTokens: 64_000,
    maxOutputTokens: 8_192,
    maxTotalTokens: 80_000,
    maxCostUsd: 0.25,
    timeoutMs: 180_000,
    perAttemptTimeoutMs: 90_000,
    fallbackAttempts: 2,
  },
  blog_section_generation: {
    name: 'blog_section_generation',
    maxInputTokens: 48_000,
    maxOutputTokens: 4_096,
    maxTotalTokens: 58_000,
    maxCostUsd: 0.3,
    timeoutMs: 240_000,
    perAttemptTimeoutMs: 90_000,
    fallbackAttempts: 3,
  },
  blog_long_generation: {
    name: 'blog_long_generation',
    maxInputTokens: 96_000,
    maxOutputTokens: 8_000,
    maxTotalTokens: 112_000,
    maxCostUsd: 0.8,
    timeoutMs: 600_000,
    perAttemptTimeoutMs: 180_000,
    fallbackAttempts: 3,
  },
};

let schemaReadyPromise: Promise<void> | null = null;

export function estimateTokens(text: string | null | undefined): number {
  const value = String(text || '');
  if (!value) return 0;
  return Math.max(1, Math.ceil(value.length / TOKEN_CHARS_PER_TOKEN));
}

export function inferTokenBudgetProfile(request: TokenBudgetRequest = {}): string {
  const explicit = String(request.tokenBudgetProfile || '').trim();
  if (explicit && PROFILES[explicit]) return explicit;

  const team = normalizeKey(request.callerTeam);
  const agent = normalizeKey(request.agent);
  const selectorKey = normalizeKey(request.selectorKey);
  const taskType = normalizeKey(request.taskType);

  if (team === 'blog' && (selectorKey === 'blog.pos.writer' || selectorKey === 'blog.gems.writer' || agent === 'pos' || agent === 'gems')) {
    return 'blog_long_generation';
  }
  if (team === 'blog' || taskType.includes('blog')) return 'blog_section_generation';
  if (selectorKey.startsWith('hub.alarm.') || taskType.includes('alarm_interpreter') || taskType.includes('alarm')) return 'hub_alarm_interpreter';
  if (selectorKey.includes('oauth') || agent.includes('oauth') || taskType.includes('oauth')) return 'oauth_monitor';
  if (team === 'claude' && (agent === 'archer' || selectorKey === 'claude.archer.tech_analysis')) return 'archer_batch_analysis';
  if (team === 'darwin' || selectorKey.startsWith('darwin.') || taskType.includes('research')) return 'darwin_research';
  if (selectorKey.includes('refactorer') || taskType.includes('code_refactor') || agent.includes('refactorer')) return 'code_refactor';
  if (taskType.includes('triage') || taskType.includes('classif')) return 'fast_triage';
  return 'default';
}

export function resolveTokenBudget(request: TokenBudgetRequest = {}): TokenBudgetCheck {
  const profileName = inferTokenBudgetProfile(request);
  const profile = PROFILES[profileName] || PROFILES.default;
  const callerTeam = normalizeText(request.callerTeam, 'hub');
  const agent = normalizeText(request.agent, 'unknown');
  const taskType = normalizeText(request.taskType, 'default');
  const selectorKey = normalizeNullableText(request.selectorKey);
  const inputTokens = estimateTokens(`${request.systemPrompt || ''}\n${request.prompt || ''}`);
  const requestedOutput = toPositiveInt(request.maxTokens, profile.maxOutputTokens);
  const maxOutputTokens = Math.min(requestedOutput, profile.maxOutputTokens);
  const estimatedTotalTokens = inputTokens + maxOutputTokens;
  const budgetCostUsd = Math.min(toPositiveNumber(request.maxBudgetUsd, profile.maxCostUsd), profile.maxCostUsd);
  const timeoutMs = Math.min(toPositiveInt(request.timeoutMs, profile.timeoutMs), profile.timeoutMs);
  const perAttemptTimeoutMs = Math.min(timeoutMs, profile.perAttemptTimeoutMs);
  const estimatedCostUsd = estimateCostUsd({
    provider: request.provider,
    model: request.model,
    inputTokens,
    outputTokens: maxOutputTokens,
  });
  const promptHash = hashText(request.prompt || '');
  const requestFingerprint = hashText(JSON.stringify({
    callerTeam,
    agent,
    taskType,
    selectorKey,
    profileName,
    promptHash,
    systemPromptHash: hashText(request.systemPrompt || ''),
  })) || crypto.randomUUID();

  let ok = true;
  let reason: string | undefined;
  if (inputTokens > profile.maxInputTokens) {
    ok = false;
    reason = `input_tokens_exceeded:${inputTokens}>${profile.maxInputTokens}`;
  } else if (estimatedTotalTokens > profile.maxTotalTokens) {
    ok = false;
    reason = `total_tokens_exceeded:${estimatedTotalTokens}>${profile.maxTotalTokens}`;
  } else if (estimatedCostUsd > budgetCostUsd) {
    ok = false;
    reason = `estimated_cost_exceeded:${estimatedCostUsd.toFixed(6)}>${budgetCostUsd.toFixed(6)}`;
  }

  return {
    ok,
    reason,
    profile,
    profileName,
    callerTeam,
    agent,
    taskType,
    selectorKey,
    inputTokens,
    maxOutputTokens,
    estimatedTotalTokens,
    estimatedCostUsd,
    budgetCostUsd,
    timeoutMs,
    perAttemptTimeoutMs,
    fallbackAttempts: profile.fallbackAttempts,
    promptHash,
    requestFingerprint,
  };
}

export function applyTokenBudgetToRequest<T extends TokenBudgetRequest>(request: T): T & { tokenBudget: TokenBudgetCheck } {
  const budget = resolveTokenBudget(request);
  return {
    ...request,
    maxTokens: budget.maxOutputTokens,
    timeoutMs: budget.timeoutMs,
    maxBudgetUsd: budget.budgetCostUsd,
    tokenBudgetProfile: budget.profileName,
    tokenBudget: budget,
  };
}

export function applyTokenBudgetToFallbackChain<T extends FallbackEntry>(chain: T[] = [], budget: TokenBudgetCheck): T[] {
  const maxAttempts = Math.max(1, budget.fallbackAttempts || 1);
  return chain.slice(0, maxAttempts).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    return {
      ...entry,
      maxTokens: Math.min(toPositiveInt(entry.maxTokens, budget.maxOutputTokens), budget.maxOutputTokens),
      timeoutMs: Math.min(toPositiveInt(entry.timeoutMs, budget.perAttemptTimeoutMs), budget.perAttemptTimeoutMs),
    };
  });
}

export function estimateCostUsd({ provider, model, inputTokens = 0, outputTokens = 0 }: {
  provider?: string | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
}): number {
  const route = normalizeRoute(provider, model);
  if (FREE_PROVIDER_PREFIXES.some((prefix) => route.startsWith(prefix))) return 0;
  const direct = MODEL_PRICING_USD_PER_1M[route] || MODEL_PRICING_USD_PER_1M[String(model || '').trim()];
  if (!direct) {
    if (route.startsWith('openai-oauth/')) return ((inputTokens * 0.6) + (outputTokens * 2.4)) / 1_000_000;
    if (route.startsWith('claude-code/')) return ((inputTokens * 3) + (outputTokens * 15)) / 1_000_000;
    return 0.01;
  }
  return ((inputTokens * direct.input) + (outputTokens * direct.output)) / 1_000_000;
}

export async function recordTokenBudgetUsage(record: UsageRecord): Promise<{ id: number | null }> {
  try {
    await ensureTokenBudgetUsageSchema();
    const rows = await pgPool.query<{ id: number }>('agent', `
      INSERT INTO llm_token_budget_usage (
        trace_id, request_id, caller_team, agent, task_type, selector_key, profile_name,
        provider, model, selected_route, status, error,
        input_tokens, max_output_tokens, estimated_total_tokens,
        estimated_cost_usd, budget_cost_usd, timeout_ms, duration_ms,
        fallback_count, attempted_providers, prompt_hash, request_fingerprint, metadata
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22,$23,$24::jsonb)
      RETURNING id
    `, [
      record.traceId || null,
      record.requestId || null,
      normalizeText(record.callerTeam, 'hub'),
      normalizeText(record.agent, 'unknown'),
      normalizeText(record.taskType, 'default'),
      record.selectorKey || null,
      record.profileName || 'default',
      record.provider || null,
      record.model || null,
      record.selectedRoute || null,
      record.status || 'unknown',
      record.error || null,
      toNonNegativeInt(record.inputTokens, 0),
      toNonNegativeInt(record.maxOutputTokens, 0),
      toNonNegativeInt(record.estimatedTotalTokens, 0),
      toNonNegativeNumber(record.estimatedCostUsd, 0),
      toNonNegativeNumber(record.budgetCostUsd, 0),
      toNonNegativeInt(record.timeoutMs, 0),
      toNonNegativeInt(record.durationMs, 0),
      toNonNegativeInt(record.fallbackCount, 0),
      JSON.stringify(Array.isArray(record.attemptedProviders) ? record.attemptedProviders : []),
      record.promptHash || null,
      record.requestFingerprint || null,
      JSON.stringify(record.metadata || {}),
    ]);
    return { id: rows?.[0]?.id ?? null };
  } catch (error) {
    console.warn(`[token-budget] usage 기록 실패: ${(error as Error).message}`);
    return { id: null };
  }
}

export async function getTokenBudgetUsageSummary(minutes = 60): Promise<any[]> {
  await ensureTokenBudgetUsageSchema();
  return pgPool.query('agent', `
    SELECT
      caller_team,
      agent,
      task_type,
      profile_name,
      status,
      COUNT(*)::int AS call_count,
      SUM(estimated_total_tokens)::bigint AS estimated_tokens,
      SUM(estimated_cost_usd)::double precision AS estimated_cost_usd,
      MAX(created_at) AS latest_at
    FROM llm_token_budget_usage
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
    GROUP BY 1,2,3,4,5
    ORDER BY latest_at DESC
    LIMIT 100
  `, [Math.max(1, Math.min(10080, Math.floor(Number(minutes) || 60)))]);
}

export async function ensureTokenBudgetUsageSchema(): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pgPool.run('agent', `
        CREATE TABLE IF NOT EXISTS llm_token_budget_usage (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          trace_id TEXT,
          request_id TEXT,
          caller_team TEXT NOT NULL DEFAULT 'hub',
          agent TEXT NOT NULL DEFAULT 'unknown',
          task_type TEXT NOT NULL DEFAULT 'default',
          selector_key TEXT,
          profile_name TEXT NOT NULL DEFAULT 'default',
          provider TEXT,
          model TEXT,
          selected_route TEXT,
          status TEXT NOT NULL DEFAULT 'unknown',
          error TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          max_output_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_total_tokens INTEGER NOT NULL DEFAULT 0,
          estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          budget_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
          timeout_ms INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          fallback_count INTEGER NOT NULL DEFAULT 0,
          attempted_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
          prompt_hash TEXT,
          request_fingerprint TEXT,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      await pgPool.run('agent', `
        CREATE INDEX IF NOT EXISTS idx_llm_token_budget_usage_created_team
          ON llm_token_budget_usage (created_at DESC, caller_team, agent)
      `);
      await pgPool.run('agent', `
        CREATE INDEX IF NOT EXISTS idx_llm_token_budget_usage_fingerprint
          ON llm_token_budget_usage (request_fingerprint, created_at DESC)
      `);
      await pgPool.run('agent', `
        CREATE INDEX IF NOT EXISTS idx_llm_token_budget_usage_profile
          ON llm_token_budget_usage (profile_name, created_at DESC)
      `);
    })();
  }
  return schemaReadyPromise;
}

export function listTokenBudgetProfiles(): TokenBudgetProfile[] {
  return Object.values(PROFILES).map((profile) => ({ ...profile }));
}

function normalizeRoute(provider?: string | null, model?: string | null): string {
  const providerText = String(provider || '').trim();
  const modelText = String(model || '').trim();
  if (!providerText) return modelText;
  if (!modelText) return providerText;
  if (modelText.startsWith(`${providerText}/`)) return modelText;
  return `${providerText}/${modelText}`;
}

function normalizeKey(value?: string | null): string {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value: string | null | undefined, fallback: string): string {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const text = String(value || '').trim();
  return text || null;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function toNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hashText(value: string): string | null {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
}
