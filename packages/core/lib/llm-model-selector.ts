type LLMChainEntry = {
  provider: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

type SelectorOptions = {
  maxTokens?: number;
  temperature?: number;
  policyOverride?: any;
  intentPrimary?: string;
  intentFallback?: string;
  chatFallbackChain?: LLMChainEntry[];
  agentName?: string;
  agentModel?: string | null;
  openaiPerfModel?: string;
  rolloutKey?: string;
  selectorVersion?: string;
  rolloutPercent?: number;
  [key: string]: any;
};

type LlmRouteTargetKind = 'visible_agent' | 'task_route' | 'runtime_service' | 'retired' | 'planned' | 'pending_runtime' | 'alias';

type LlmRouteTarget = {
  team: string;
  agent: string;
  selectorKey: string | null;
  selected: boolean;
  kind: LlmRouteTargetKind;
  canonicalTeam: string;
  countable: boolean;
  blockReason: string | null;
};

export type LlmConfiguredModelConstant = {
  name: string;
  token: string;
  envName: string;
  value: string;
  fallback: string;
  providerPrefixes: string[];
};

function configuredModel(name: string, fallback: string, providerPrefixes: string[] = []): string {
  const raw = String(process.env[name] || fallback || '').trim();
  if (!raw) return fallback;
  for (const prefix of providerPrefixes) {
    const marker = `${prefix}/`;
    if (raw.startsWith(marker)) return raw.slice(marker.length);
  }
  return raw;
}

const OPENAI_PERF_MODEL = configuredModel('LLM_OPENAI_PERF_MODEL', 'gpt-5.4', ['openai-oauth', 'openai']);
const OPENAI_MINI_MODEL = configuredModel('LLM_OPENAI_MINI_MODEL', 'gpt-5.4-mini', ['openai-oauth', 'openai']);
const OPENAI_OPUS_MODEL = configuredModel('LLM_OPENAI_OPUS_MODEL', 'gpt-5.5', ['openai-oauth', 'openai']);
const GROQ_FAST_MODEL = configuredModel('LLM_GROQ_FAST_MODEL', 'llama-3.1-8b-instant', ['groq']);
const GROQ_DEEP_MODEL = configuredModel('LLM_GROQ_DEEP_MODEL', 'qwen/qwen3-32b', ['groq']);
const GROQ_SCOUT_MODEL = configuredModel('LLM_GROQ_SCOUT_MODEL', GROQ_FAST_MODEL, ['groq']);
const GEMINI_CLI_FLASH_LITE_MODEL = configuredModel(
  'LLM_GEMINI_FLASH_LITE_MODEL',
  'gemini-2.5-flash-lite',
  ['gemini-cli-oauth', 'gemini-oauth', 'gemini'],
);
const GEMINI_CLI_FLASH_MODEL = configuredModel(
  'LLM_GEMINI_FLASH_MODEL',
  'gemini-2.5-flash',
  ['gemini-cli-oauth', 'gemini-oauth', 'gemini'],
);
const GEMINI_CLI_PRO_MODEL = configuredModel(
  'LLM_GEMINI_PRO_MODEL',
  'gemini-2.5-pro',
  ['gemini-cli-oauth', 'gemini-oauth', 'gemini'],
);
const LOCAL_EMBED_MODEL = configuredModel('LLM_LOCAL_EMBED_MODEL', 'qwen3-embed-0.6b', ['local-embedding', 'local']);

export {
  OPENAI_PERF_MODEL,
  OPENAI_MINI_MODEL,
  OPENAI_OPUS_MODEL,
  GROQ_FAST_MODEL,
  GROQ_DEEP_MODEL,
  GROQ_SCOUT_MODEL,
  GEMINI_CLI_FLASH_LITE_MODEL,
  GEMINI_CLI_FLASH_MODEL,
  GEMINI_CLI_PRO_MODEL,
  LOCAL_EMBED_MODEL,
};

export const LLM_CONFIGURED_MODEL_CONSTANTS: ReadonlyArray<LlmConfiguredModelConstant> = Object.freeze([
  {
    name: 'OPENAI_PERF_MODEL',
    token: '@OPENAI_PERF_MODEL',
    envName: 'LLM_OPENAI_PERF_MODEL',
    value: OPENAI_PERF_MODEL,
    fallback: 'gpt-5.4',
    providerPrefixes: ['openai-oauth', 'openai'],
  },
  {
    name: 'OPENAI_MINI_MODEL',
    token: '@OPENAI_MINI_MODEL',
    envName: 'LLM_OPENAI_MINI_MODEL',
    value: OPENAI_MINI_MODEL,
    fallback: 'gpt-5.4-mini',
    providerPrefixes: ['openai-oauth', 'openai'],
  },
  {
    name: 'OPENAI_OPUS_MODEL',
    token: '@OPENAI_OPUS_MODEL',
    envName: 'LLM_OPENAI_OPUS_MODEL',
    value: OPENAI_OPUS_MODEL,
    fallback: 'gpt-5.5',
    providerPrefixes: ['openai-oauth', 'openai'],
  },
  {
    name: 'GROQ_FAST_MODEL',
    token: '@GROQ_FAST_MODEL',
    envName: 'LLM_GROQ_FAST_MODEL',
    value: GROQ_FAST_MODEL,
    fallback: 'llama-3.1-8b-instant',
    providerPrefixes: ['groq'],
  },
  {
    name: 'GROQ_DEEP_MODEL',
    token: '@GROQ_DEEP_MODEL',
    envName: 'LLM_GROQ_DEEP_MODEL',
    value: GROQ_DEEP_MODEL,
    fallback: 'qwen/qwen3-32b',
    providerPrefixes: ['groq'],
  },
  {
    name: 'GROQ_SCOUT_MODEL',
    token: '@GROQ_SCOUT_MODEL',
    envName: 'LLM_GROQ_SCOUT_MODEL',
    value: GROQ_SCOUT_MODEL,
    fallback: GROQ_FAST_MODEL,
    providerPrefixes: ['groq'],
  },
  {
    name: 'GEMINI_CLI_FLASH_LITE_MODEL',
    token: '@GEMINI_CLI_FLASH_LITE_MODEL',
    envName: 'LLM_GEMINI_FLASH_LITE_MODEL',
    value: GEMINI_CLI_FLASH_LITE_MODEL,
    fallback: 'gemini-2.5-flash-lite',
    providerPrefixes: ['gemini-cli-oauth', 'gemini-oauth', 'gemini'],
  },
  {
    name: 'GEMINI_CLI_FLASH_MODEL',
    token: '@GEMINI_CLI_FLASH_MODEL',
    envName: 'LLM_GEMINI_FLASH_MODEL',
    value: GEMINI_CLI_FLASH_MODEL,
    fallback: 'gemini-2.5-flash',
    providerPrefixes: ['gemini-cli-oauth', 'gemini-oauth', 'gemini'],
  },
  {
    name: 'GEMINI_CLI_PRO_MODEL',
    token: '@GEMINI_CLI_PRO_MODEL',
    envName: 'LLM_GEMINI_PRO_MODEL',
    value: GEMINI_CLI_PRO_MODEL,
    fallback: 'gemini-2.5-pro',
    providerPrefixes: ['gemini-cli-oauth', 'gemini-oauth', 'gemini'],
  },
  {
    name: 'LOCAL_EMBED_MODEL',
    token: '@LOCAL_EMBED_MODEL',
    envName: 'LLM_LOCAL_EMBED_MODEL',
    value: LOCAL_EMBED_MODEL,
    fallback: 'qwen3-embed-0.6b',
    providerPrefixes: ['local-embedding', 'local'],
  },
]);

export const LLM_CONFIGURED_MODEL_TOKEN_VALUES: Record<string, string> = Object.freeze(
  Object.fromEntries(LLM_CONFIGURED_MODEL_CONSTANTS.map((constant) => [constant.token, constant.value])),
);

export function resolveConfiguredModelToken(token: string): string | null {
  const normalized = String(token || '').trim();
  const key = normalized.startsWith('@') ? normalized : `@${normalized}`;
  return LLM_CONFIGURED_MODEL_TOKEN_VALUES[key] || null;
}

const TEAM_SELECTOR_VERSION_LEGACY = 'v2_legacy';
const TEAM_SELECTOR_VERSION_OAUTH4 = 'v3_oauth_4';

type TeamSelectorVersion = typeof TEAM_SELECTOR_VERSION_LEGACY | typeof TEAM_SELECTOR_VERSION_OAUTH4;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value: any): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: any, override: any): any {
  if (!isObject(base) || !isObject(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : clone(value);
  }
  return merged;
}

function normalizeSelectorVersion(value: any): TeamSelectorVersion {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_./-]+/g, '');
  if (
    normalized === 'v3_oauth_4'
    || normalized === 'v3.0_oauth_4'
    || normalized === 'oauth4'
    || normalized === 'oauth_4'
  ) return TEAM_SELECTOR_VERSION_OAUTH4;
  return TEAM_SELECTOR_VERSION_LEGACY;
}

function parseEnabledFlag(value: any): boolean | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

function parseRolloutStagePercent(value: any): number | null {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'canary') return 1;
  if (normalized === '50' || normalized === 'half') return 50;
  if (normalized === '100' || normalized === 'full') return 100;
  return null;
}

function parseRolloutPercent(options: SelectorOptions = {}): number {
  const optionPercent = Number(options.rolloutPercent);
  if (Number.isFinite(optionPercent)) {
    return Math.max(0, Math.min(100, Math.floor(optionPercent)));
  }
  const optionStage = parseRolloutStagePercent((options as any).rolloutStage);
  if (optionStage != null) return optionStage;

  const envPercentRaw = String(process.env.LLM_TEAM_SELECTOR_AB_PERCENT || process.env.LLM_TEAM_SELECTOR_VERSION_PCT || '').trim();
  if (envPercentRaw) {
    const envPercent = Number(envPercentRaw);
    if (Number.isFinite(envPercent)) {
      return Math.max(0, Math.min(100, Math.floor(envPercent)));
    }
  }
  const envStage = parseRolloutStagePercent(process.env.LLM_TEAM_SELECTOR_AB_STAGE);
  if (envStage != null) return envStage;

  const optionAbTest = parseEnabledFlag((options as any).abTest);
  const envAbTest = parseEnabledFlag(process.env.LLM_TEAM_SELECTOR_AB_TEST);
  const abTestEnabled = optionAbTest ?? envAbTest;
  if (abTestEnabled === false) return 100;
  return 100;
}

function stableHashPercent(seed: string): number {
  let hash = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

function resolveSelectorVersionForKey(selectorKey: string, options: SelectorOptions = {}): TeamSelectorVersion {
  const envVersionRaw = String(process.env.LLM_TEAM_SELECTOR_VERSION || '').trim();
  const oauthPrimaryEnabled = parseEnabledFlag(process.env.LLM_USE_OAUTH_PRIMARY) === true;
  const envVersion = normalizeSelectorVersion(envVersionRaw || (oauthPrimaryEnabled ? TEAM_SELECTOR_VERSION_OAUTH4 : TEAM_SELECTOR_VERSION_LEGACY));
  const optionVersion = options.selectorVersion ? normalizeSelectorVersion(options.selectorVersion) : envVersion;
  if (optionVersion !== TEAM_SELECTOR_VERSION_OAUTH4) return TEAM_SELECTOR_VERSION_LEGACY;

  const percent = parseRolloutPercent(options);
  if (percent >= 100) return TEAM_SELECTOR_VERSION_OAUTH4;
  if (percent <= 0) return TEAM_SELECTOR_VERSION_LEGACY;

  const seedParts = [
    selectorKey,
    options.rolloutKey,
    options.incidentKey,
    options.traceId,
    options.agentName,
    options.team,
  ].filter(Boolean);
  const seed = seedParts.length > 0 ? seedParts.join('|') : selectorKey;
  return stableHashPercent(seed) < percent ? TEAM_SELECTOR_VERSION_OAUTH4 : TEAM_SELECTOR_VERSION_LEGACY;
}

export function inferProviderFromModel(model = ''): string {
  if (!model) return 'claude-code';
  if (model.startsWith('local-embedding/') || model === LOCAL_EMBED_MODEL) return 'local-embedding';
  if (model.startsWith('claude-code/')) return 'claude-code';
  if (model.startsWith('gemma4') || model.startsWith('gemma-4')) return 'local';
  if (model.startsWith('local/') || model === 'qwen2.5-7b' || model === 'deepseek-r1-32b') return 'local';
  if (model.startsWith('groq/')) return 'groq';
  if (
    model.startsWith('meta-llama/') ||
    model.startsWith('openai/gpt-oss-') ||
    model.startsWith('llama-') ||
    model.startsWith('qwen/')
  ) return 'groq';
  if (model.startsWith('claude-')) return 'claude-code';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  if (model.startsWith('gemini-codeassist-oauth/') || model.startsWith('gemini-code-assist-oauth/')) return 'gemini-codeassist-oauth';
  if (model.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (model.startsWith('gemini-oauth/')) return 'gemini-cli-oauth';
  if (model.startsWith('gemini-') || model.startsWith('google-gemini-cli/')) return 'gemini-cli-oauth';
  return 'claude-code';
}

export function buildSingleChain(model: string, maxTokens = 1024, temperature = 0.1): LLMChainEntry[] {
  return [{ provider: inferProviderFromModel(model), model, maxTokens, temperature }];
}

function applyChainOverrides(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const maxTokens = Number.isFinite(Number(options.maxTokens)) ? Number(options.maxTokens) : null;
  const temperature = Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : null;
  return chain.map((entry) => ({
    ...entry,
    maxTokens: maxTokens ?? entry.maxTokens,
    temperature: temperature ?? entry.temperature,
  }));
}

function applyPolicyOverride(resolved: any, policyOverride: any, options: SelectorOptions = {}): any {
  if (!policyOverride) return Array.isArray(resolved) ? applyChainOverrides(resolved, options) : resolved;
  if (Array.isArray(resolved)) {
    if (Array.isArray(policyOverride)) return applyChainOverrides(clone(policyOverride), options);
    if (Array.isArray(policyOverride.chain)) return applyChainOverrides(clone(policyOverride.chain), options);
    return applyChainOverrides(resolved, options);
  }
  if (isObject(resolved) && isObject(policyOverride)) return deepMerge(resolved, policyOverride);
  return policyOverride;
}

function resolvePreferredProvider(preferredApi: string, groqModel: string, maxTokens: number): LLMChainEntry {
  if (preferredApi === 'claude-code') return { provider: 'claude-code', model: 'claude-code/haiku', maxTokens, temperature: 0.1 };
  if (preferredApi === 'anthropic') return { provider: 'claude-code', model: 'claude-code/haiku', maxTokens, temperature: 0.1 };
  if (preferredApi === 'openai') return {
    provider: publicOpenAiDirectEnabled() ? 'openai' : 'openai-oauth',
    model: OPENAI_MINI_MODEL,
    maxTokens,
    temperature: 0.1,
  };
  if (preferredApi === 'gemini' || preferredApi === 'gemini-oauth' || preferredApi === 'gemini-cli-oauth') {
    return { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.1 };
  }
  return { provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 };
}

function buildRouteFromAgentModel(agentModel: string | null | undefined, {
  openaiPerfModel = OPENAI_PERF_MODEL,
  openaiMiniModel = OPENAI_MINI_MODEL,
  groqScoutModel = 'llama-3.1-8b-instant',
  groqCompetitionModels = ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
}: {
  openaiPerfModel?: string;
  openaiMiniModel?: string;
  groqScoutModel?: string;
  groqCompetitionModels?: string[];
} = {}): string | null {
  const normalized = String(agentModel || '').trim();
  const openaiPerfLabel = openaiPerfModel.startsWith('openai-oauth/') ? openaiPerfModel : `openai-oauth/${openaiPerfModel}`;
  const openaiMiniLabel = openaiMiniModel.startsWith('openai-oauth/') ? openaiMiniModel : `openai-oauth/${openaiMiniModel}`;
  if (!normalized) return null;
  if (normalized === openaiPerfLabel || normalized === openaiPerfModel) return 'openai_perf';
  if (normalized === openaiMiniLabel || normalized === openaiMiniModel) return 'openai_mini';
  if (normalized === LOCAL_EMBED_MODEL || normalized.startsWith('local-embedding/')) return 'local_embedding';
  if (normalized.startsWith('openai-oauth/')) return 'openai_mini';
  if (normalized.startsWith('local/')) return normalized.includes('deepseek') ? 'local_deep' : 'local_primary';
  if (normalized.startsWith('groq/')) {
    const lower = normalized.toLowerCase();
    if (lower.includes('gpt-oss') || lower.includes('scout')) return 'groq_scout';
    return 'groq_with_local';
  }
  if (normalized === 'anthropic') return 'groq_with_local';
  if (normalized.startsWith('claude-code/')) return 'groq_with_local';
  if (normalized.startsWith('anthropic/')) return 'groq_with_local';
  if (normalized.startsWith('gemini-oauth/')) return 'openai_mini';
  if (normalized.startsWith('gemini/')) return 'openai_mini';
  if (normalized.startsWith('google-gemini-cli/')) return 'openai_mini';
  if (normalized === openaiPerfModel) return 'openai_perf';
  if (normalized === openaiMiniModel) return 'openai_mini';
  if (normalized === groqScoutModel) return 'groq_scout';
  if (groqCompetitionModels.includes(normalized)) return 'dual_groq';
  return null;
}

function sanitizeConfiguredProviders(preferredApi: string, configuredProviders: string[] = []): string[] {
  const list = Array.isArray(configuredProviders) ? configuredProviders.slice() : [];
  if (preferredApi === 'claude-code' || preferredApi === 'anthropic') return list.filter((provider) => provider !== 'anthropic');
  return list;
}

function stripGroqPrefix(model = ''): string {
  return model.startsWith('groq/') ? model.slice(5) : model;
}

function dedupeByProvider(chain: LLMChainEntry[]): LLMChainEntry[] {
  return chain.filter((entry, index, array) => array.findIndex((candidate) => candidate.provider === entry.provider) === index);
}

function dedupeByProviderModel(chain: LLMChainEntry[]): LLMChainEntry[] {
  return chain.filter((entry, index, array) => array.findIndex((candidate) => (
    candidate.provider === entry.provider && candidate.model === entry.model
  )) === index);
}

function isTimeGateActive(value: any): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp > Date.now();
}

function shouldAvoidClaudeCode(entry: LLMChainEntry, options: SelectorOptions = {}): boolean {
  if (String(entry?.provider || '') !== 'claude-code') return false;
  const model = String(entry?.model || '').toLowerCase();
  const quotaMode = String(
    options.claudeCodeQuotaMode || process.env.LLM_CLAUDE_CODE_QUOTA_MODE || '',
  ).trim().toLowerCase();
  if (['avoid', 'saturated', 'openai_only', 'openai-only', 'disabled'].includes(quotaMode)) return true;
  if (parseEnabledFlag(options.claudeCodeDisabled ?? process.env.LLM_CLAUDE_CODE_DISABLED) === true) return true;
  if (parseEnabledFlag(options.claudeCodeUsageSaturated ?? process.env.LLM_CLAUDE_CODE_USAGE_SATURATED) === true) return true;
  if (isTimeGateActive(options.forceOpenaiOauthUntil ?? process.env.LLM_FORCE_OPENAI_OAUTH_UNTIL)) return true;
  if (
    model.includes('sonnet')
    && parseEnabledFlag(options.claudeCodeSonnetDisabled ?? process.env.LLM_CLAUDE_CODE_SONNET_DISABLED) === true
  ) return true;
  return false;
}

function publicOpenAiDirectEnabled(options: SelectorOptions = {}): boolean {
  const optionFlag = parseEnabledFlag(options.publicOpenAiDirectEnabled);
  if (optionFlag !== null) return optionFlag;
  return parseEnabledFlag(process.env.HUB_LLM_PUBLIC_OPENAI_ENABLED) === true
    || parseEnabledFlag(process.env.LLM_PUBLIC_OPENAI_ENABLED) === true;
}

function shouldAvoidPublicOpenAi(entry: LLMChainEntry, options: SelectorOptions = {}): boolean {
  return String(entry?.provider || '') === 'openai' && !publicOpenAiDirectEnabled(options);
}

function replacementForPublicOpenAi(entry: LLMChainEntry): LLMChainEntry {
  return {
    ...entry,
    provider: 'openai-oauth',
    model: String(entry?.model || '').replace(/^openai\//, '').replace(/^openai-oauth\//, ''),
  };
}

function replacementForClaudeCode(entry: LLMChainEntry, options: SelectorOptions = {}): LLMChainEntry {
  const configured = String(
    options.claudeCodeReplacementModel
    || process.env.LLM_CLAUDE_CODE_REPLACEMENT_MODEL
    || process.env.LLM_CLAUDE_CODE_SONNET_REPLACEMENT
    || '',
  ).trim();
  const model = configured || (String(entry?.model || '').toLowerCase().includes('haiku') ? OPENAI_MINI_MODEL : (options.openaiPerfModel || OPENAI_PERF_MODEL));
  return {
    ...entry,
    provider: 'openai-oauth',
    model: model.replace(/^openai-oauth\//, ''),
  };
}

const GEMINI_DIAGNOSTIC_SELECTOR_KEYS = new Set([
  'hub.gemini.cli.adapter.smoke',
  'hub.gemini.cli.readiness.live',
  'hub.unified.oauth.gemini.smoke',
]);

const CLAUDE_FIRST_WRITING_SELECTOR_KEYS = new Set([
  'blog.pos.writer',
  'blog.gems.writer',
  'blog.curriculum.generate',
  'blog.book_review.preview',
]);

const CLAUDE_CODE_FALLBACK_SELECTOR_KEYS = new Set([
  'claude.refactorer.code_refactor',
  'claude.auto_dev.code_fix',
  'claude.reviewer.code_review',
  'claude.doctor.recovery',
]);

function providerOfEntry(entry: LLMChainEntry): string {
  const explicit = String(entry?.provider || '').trim();
  if (explicit === 'gemini-oauth') return 'gemini-cli-oauth';
  if (explicit) return explicit;
  return inferProviderFromModel(String(entry?.model || ''));
}

function isGeminiProviderName(provider: string): boolean {
  return ['gemini-cli-oauth', 'gemini-oauth', 'gemini-codeassist-oauth', 'gemini-code-assist-oauth'].includes(
    String(provider || '').trim(),
  );
}

function isGeminiEntry(entry: LLMChainEntry): boolean {
  const model = String(entry?.model || '').trim().toLowerCase();
  return isGeminiProviderName(providerOfEntry(entry))
    || model.startsWith('gemini-')
    || model.startsWith('gemini-cli-oauth/')
    || model.startsWith('gemini-oauth/')
    || model.startsWith('google-gemini-cli/')
    || model.startsWith('gemini-codeassist-oauth/')
    || model.startsWith('gemini-code-assist-oauth/');
}

function isGroqEntry(entry: LLMChainEntry): boolean {
  return providerOfEntry(entry) === 'groq';
}

function isOpenAiEntry(entry: LLMChainEntry): boolean {
  const provider = providerOfEntry(entry);
  return provider === 'openai-oauth' || provider === 'openai';
}

function isClaudeCodeEntry(entry: LLMChainEntry): boolean {
  return providerOfEntry(entry) === 'claude-code';
}

function entryMaxTokens(entry: LLMChainEntry | null | undefined, fallback = 1024): number {
  const value = Number(entry?.maxTokens);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function groqRouteMaxTokens(): number {
  const configured = Number(process.env.LLM_GROQ_ROUTE_MAX_TOKENS || process.env.HUB_GROQ_ROUTE_MAX_TOKENS || '');
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return 4096;
}

function isExplicitGeminiDiagnosticSelector(selectorKey: string): boolean {
  return GEMINI_DIAGNOSTIC_SELECTOR_KEYS.has(String(selectorKey || ''));
}

function isBacktestSelector(selectorKey: string, options: SelectorOptions = {}): boolean {
  const key = String(selectorKey || '').trim();
  const agentName = String(options.agentName || '').trim().toLowerCase();
  const taskType = normalizeTaskTypeInput(options);
  return key === 'chronos.backtest'
    || key === 'investment.chronos.backtest'
    || (key === 'investment.agent_policy' && agentName === 'chronos' && taskType === 'backtest_embedding');
}

function normalizeTaskTypeInput(options: SelectorOptions = {}): string {
  return String(
    (options as any).taskType
    || (options as any).task_type
    || (options as any).runtimePurpose
    || (options as any).runtime_purpose
    || '',
  ).trim().toLowerCase();
}

function openAiEntry(template: LLMChainEntry | null | undefined, model: string): LLMChainEntry {
  return {
    provider: 'openai-oauth',
    model: model.replace(/^openai-oauth\//, ''),
    maxTokens: entryMaxTokens(template, model === OPENAI_MINI_MODEL ? 1024 : 2048),
    temperature: template?.temperature ?? 0.1,
    ...(template?.timeoutMs ? { timeoutMs: template.timeoutMs } : {}),
  };
}

function groqFastEntry(template: LLMChainEntry | null | undefined): LLMChainEntry {
  return {
    provider: 'groq',
    model: GROQ_FAST_MODEL,
    maxTokens: entryMaxTokens(template, 1024),
    temperature: template?.temperature ?? 0.1,
    ...(template?.timeoutMs ? { timeoutMs: template.timeoutMs } : {}),
  };
}

function groqDeepEntry(template: LLMChainEntry | null | undefined): LLMChainEntry {
  return {
    provider: 'groq',
    model: GROQ_DEEP_MODEL,
    maxTokens: entryMaxTokens(template, 2048),
    temperature: template?.temperature ?? 0.1,
    ...(template?.timeoutMs ? { timeoutMs: template.timeoutMs } : {}),
  };
}

function claudeWritingModelForSelector(selectorKey = ''): string {
  return selectorKey === 'blog.pos.writer' || selectorKey === 'blog.gems.writer'
    ? 'claude-code/sonnet'
    : 'claude-code/haiku';
}

function claudeWritingEntry(template: LLMChainEntry | null | undefined, selectorKey = ''): LLMChainEntry {
  return {
    provider: 'claude-code',
    model: claudeWritingModelForSelector(selectorKey),
    maxTokens: entryMaxTokens(template, 4096),
    temperature: template?.temperature ?? 0.7,
    ...(template?.timeoutMs ? { timeoutMs: template.timeoutMs } : {}),
  };
}

function localEmbeddingEntry(): LLMChainEntry {
  return { provider: 'local-embedding', model: LOCAL_EMBED_MODEL, maxTokens: 0, temperature: 0 };
}

function replacementForGemini(entry: LLMChainEntry, options: SelectorOptions = {}): LLMChainEntry {
  const selectorKey = String(options.selectorKey || '');
  const maxTokens = entryMaxTokens(entry, Number(options.maxTokens) || 1024);
  if (selectorKey === 'darwin.agent_policy' || selectorKey === 'sigma.agent_policy') {
    // Darwin/Sigma are background analysis loops. Gemini-disabled replacement
    // must not become Groq-primary by default: Groq has strict daily token
    // limits and recent evaluator bursts exhausted the full account pool.
    return openAiEntry(entry, maxTokens > 1000 ? OPENAI_PERF_MODEL : OPENAI_MINI_MODEL);
  }
  if (CLAUDE_FIRST_WRITING_SELECTOR_KEYS.has(selectorKey)) {
    const candidate = claudeWritingEntry(entry, selectorKey);
    if (!shouldAvoidClaudeCode(candidate, options)) return candidate;
    return openAiEntry(entry, maxTokens > 1500 ? OPENAI_PERF_MODEL : OPENAI_MINI_MODEL);
  }
  if (selectorKey.startsWith('claude.')) {
    return openAiEntry(entry, maxTokens > 1000 ? OPENAI_PERF_MODEL : OPENAI_MINI_MODEL);
  }
  if (maxTokens <= 1024) return groqFastEntry(entry);
  if (maxTokens <= 2048) return openAiEntry(entry, OPENAI_MINI_MODEL);
  return openAiEntry(entry, OPENAI_PERF_MODEL);
}

function ensureOpenAiPrimary(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const selectorKey = String(options.selectorKey || '');
  const allowClaudeCodeFallback = CLAUDE_CODE_FALLBACK_SELECTOR_KEYS.has(selectorKey);
  const nonGemini = chain.filter((entry) => !isGeminiEntry(entry) && (allowClaudeCodeFallback || !isClaudeCodeEntry(entry)));
  const existingOpenAi = nonGemini.find(isOpenAiEntry);
  const primary = existingOpenAi || openAiEntry(chain[0], entryMaxTokens(chain[0], 1024) > 1000 ? OPENAI_PERF_MODEL : OPENAI_MINI_MODEL);
  const rest = nonGemini.filter((entry) => entry !== existingOpenAi && !(
    providerOfEntry(entry) === providerOfEntry(primary) && entry.model === primary.model
  ));
  return dedupeByProviderModel([primary, ...rest]).map((entry) => (
    shouldAvoidPublicOpenAi(entry, options) ? replacementForPublicOpenAi(entry) : entry
  ));
}

function ensureOpenAiPrimaryWithBoundedFallback(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const openAiPrimary = ensureOpenAiPrimary(chain, options);
  if (parseEnabledFlag(process.env.HUB_DARWIN_SIGMA_GROQ_FALLBACK_ENABLED) !== false) {
    const bounded = openAiPrimary.map((entry) => (isGroqEntry(entry) ? groqFastEntry(entry) : entry));
    if (!bounded.some(isGroqEntry)) {
      bounded.push(groqFastEntry(bounded[0] || chain[0]));
    }
    return dedupeByProvider(bounded);
  }

  return dedupeByProvider(openAiPrimary.filter((entry) => !isGroqEntry(entry)));
}

function ensureOpenAiFallback(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  if (chain.some(isOpenAiEntry)) return chain;
  const template = chain[0];
  const maxTokens = entryMaxTokens(template, Number(options.maxTokens) || 1024);
  return [...chain, openAiEntry(template, maxTokens > 1000 ? OPENAI_PERF_MODEL : OPENAI_MINI_MODEL)];
}

function preferGroqWithOpenAiFallback(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const withOpenAiFallback = ensureOpenAiFallback(chain, options);
  const primary = withOpenAiFallback[0];
  if (!primary || !isOpenAiEntry(primary)) return withOpenAiFallback;

  const existingGroq = withOpenAiFallback.find(isGroqEntry);
  const maxTokens = entryMaxTokens(primary, Number(options.maxTokens) || 1024);
  const groqPrimary = existingGroq || (maxTokens > 1000 ? groqDeepEntry(primary) : groqFastEntry(primary));
  const rest = withOpenAiFallback.filter((entry) => entry !== groqPrimary);
  return [groqPrimary, ...rest];
}

function ensureClaudeWritingPrimary(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const selectorKey = String(options.selectorKey || '');
  const nonGemini = chain.filter((entry) => !isGeminiEntry(entry));
  const existingClaude = nonGemini.find(isClaudeCodeEntry);
  const preferredClaudeModel = claudeWritingModelForSelector(selectorKey);
  const preferredClaude = nonGemini.find((entry) => isClaudeCodeEntry(entry) && String(entry.model || '') === preferredClaudeModel);
  const primary = preferredClaude || (existingClaude && preferredClaudeModel === 'claude-code/haiku' ? existingClaude : null) || claudeWritingEntry(chain[0], selectorKey);
  if (shouldAvoidClaudeCode(primary, options)) return ensureOpenAiPrimary(nonGemini, options);
  const rest = nonGemini.filter((entry) => entry !== primary && !(
    providerOfEntry(entry) === providerOfEntry(primary) && entry.model === primary.model
  ));
  return dedupeByProviderModel([primary, ...rest]);
}

function applyGroqTokenPolicy(chain: LLMChainEntry[]): LLMChainEntry[] {
  const limit = groqRouteMaxTokens();
  const hasNonGroq = chain.some((entry) => !isGroqEntry(entry));
  if (!hasNonGroq) return chain;
  const filtered = chain.filter((entry) => !isGroqEntry(entry) || entryMaxTokens(entry, 1024) <= limit);
  return filtered.length > 0 ? filtered : chain;
}

function applySelectorOptimizationPolicy(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const selectorKey = String(options.selectorKey || '');
  if (isBacktestSelector(selectorKey, options)) return [localEmbeddingEntry()];
  if (isExplicitGeminiDiagnosticSelector(selectorKey)) return chain;

  let optimized = chain.map((entry) => (isGeminiEntry(entry) ? replacementForGemini(entry, options) : entry));
  optimized = optimized.filter((entry) => !isGeminiEntry(entry));

  if (
    (selectorKey === 'darwin.agent_policy' || selectorKey === 'sigma.agent_policy')
    && parseEnabledFlag(process.env.HUB_DARWIN_SIGMA_GROQ_PRIMARY) !== true
  ) {
    optimized = ensureOpenAiPrimaryWithBoundedFallback(optimized, options);
  } else if (selectorKey === 'darwin.agent_policy' || selectorKey === 'sigma.agent_policy') {
    optimized = dedupeByProviderModel(preferGroqWithOpenAiFallback(optimized, options));
  }
  if (selectorKey.startsWith('claude.')) optimized = ensureOpenAiPrimary(optimized, options);
  if (CLAUDE_FIRST_WRITING_SELECTOR_KEYS.has(selectorKey)) optimized = ensureClaudeWritingPrimary(optimized, options);

  optimized = applyGroqTokenPolicy(dedupeByProviderModel(optimized));
  return optimized.length > 0 ? optimized : [openAiEntry(chain[0], OPENAI_MINI_MODEL)];
}

function applyLocalBacktestOnlyGuard(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  if (parseEnabledFlag(process.env.HUB_LLM_LOCAL_BACKTEST_ONLY) === false) return chain;
  const taskType = normalizeTaskTypeInput(options);
  if (taskType.startsWith('backtest')) return chain;
  return chain.filter((entry) => providerOfEntry(entry) !== 'local');
}

export function applyProviderRuntimeGuards(chain: LLMChainEntry[], options: SelectorOptions = {}): LLMChainEntry[] {
  const providerGuarded = chain.map((entry) => {
    if (shouldAvoidClaudeCode(entry, options)) return replacementForClaudeCode(entry, options);
    if (shouldAvoidPublicOpenAi(entry, options)) return replacementForPublicOpenAi(entry);
    return entry;
  });
  const guarded = dedupeByProviderModel(applyLocalBacktestOnlyGuard(providerGuarded, options));
  return applySelectorOptimizationPolicy(guarded, options);
}

const TEAM_SELECTOR_DEFAULTS_LEGACY: Record<string, any> = {
  hub: {
    'alarm.classifier': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 200, temperature: 0 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 200, temperature: 0 },
      ],
    },
    'alarm.interpreter.work': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 200, temperature: 0.1 },
      fallbacks: [],
    },
    'alarm.interpreter.report': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [],
    },
    'alarm.interpreter.error': {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 400, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 400, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.critical': {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 400, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 400, temperature: 0.1 },
      ],
    },
    'roundtable.jay': {
      primary: { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.claude_lead': {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 500, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 500, temperature: 0.1 },
      ],
    },
    'roundtable.team_commander': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.judge': {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 600, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 600, temperature: 0.1 },
      ],
    },
    'control.planner': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1200, temperature: 0.1 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1200, temperature: 0.1 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 1200, temperature: 0.1 },
      ],
    },
    'session.compaction': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 700, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 700, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 700, temperature: 0.1 },
      ],
    },
    'oauth.gemini_cli.expiry_probe': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 24, temperature: 0 },
      fallbacks: [],
    },
    'gemini.cli.adapter.smoke': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_PRO_MODEL, maxTokens: 64, temperature: 0 },
      fallbacks: [],
    },
    'gemini.cli.readiness.live': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 32, temperature: 0 },
      fallbacks: [],
    },
    'unified.oauth.openai.smoke': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 32, temperature: 0 },
      fallbacks: [],
    },
    'unified.oauth.gemini.smoke': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 32, temperature: 0 },
      fallbacks: [],
    },
    // k6 load tests should measure Hub routing/backpressure, not slow quality-model latency.
    // Keep this selector explicit in tests/load/* so team defaults do not route to OpenAI perf models.
    'load_test.fast': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 128, temperature: 0, timeoutMs: 8_000 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 128, temperature: 0, timeoutMs: 10_000 },
      ],
    },
    _fallback: {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [],
    },
  },
  claude: {
    dexter: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 300, temperature: 0.1 },
      ],
    },
    archer: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.2 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.3 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 2048, temperature: 0.2 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 2048, temperature: 0.2 },
      ],
    },
    lead: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 300, temperature: 0.1 },
      ],
    },
    'refactorer.code_refactor': {
      primary: { provider: 'openai-oauth', model: OPENAI_OPUS_MODEL, maxTokens: 8192, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 8192, temperature: 0.1 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.1 },
      ],
    },
    'auto_dev.code_fix': {
      primary: { provider: 'openai-oauth', model: OPENAI_OPUS_MODEL, maxTokens: 8192, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 8192, temperature: 0.1 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.1 },
      ],
    },
    'reviewer.code_review': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 4096, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 2048, temperature: 0.1 },
      ],
    },
    'doctor.recovery': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 4096, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 2048, temperature: 0.1 },
      ],
    },
    'guardian.safety': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2048, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2048, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  blog: {
    'pos.writer': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 16000, temperature: 0.82, timeoutMs: 300_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 12000, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 8000, temperature: 0.72 },
      ],
    },
    'gems.writer': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 16000, temperature: 0.85, timeoutMs: 300_000 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 8000, temperature: 0.75 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'social.summarize': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'social.caption': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.summarize': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.caption': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'curriculum.recommend': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2000, temperature: 0.7 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2000, temperature: 0.7 },
      ],
    },
    'curriculum.generate': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 8000, temperature: 0.5 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 8000, temperature: 0.5 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4000, temperature: 0.5 },
      ],
    },
    'feedback.analyze': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 700, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 700, temperature: 0.1 },
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 700, temperature: 0.1 },
      ],
    },
    'commenter.reply': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 600, temperature: 0.4, timeoutMs: 22000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_SCOUT_MODEL, maxTokens: 600, temperature: 0.55, timeoutMs: 15000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 600, temperature: 0.45, timeoutMs: 14000 },
      ],
    },
    'commenter.neighbor': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 700, temperature: 0.45, timeoutMs: 22000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_SCOUT_MODEL, maxTokens: 700, temperature: 0.6, timeoutMs: 15000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 700, temperature: 0.5, timeoutMs: 14000 },
      ],
    },
    'book_review.preview': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  core: {
    'chunked.gpt4o': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    'chunked.default': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 4096, temperature: 0.75 },
      ],
    },
  },
  justin: {
    'stage-3': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 60_000 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 45_000 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
    analysis: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 45_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 30_000 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 60_000 },
      ],
    },
    citation: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 2048, temperature: 0.1, timeoutMs: 25_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 2048, temperature: 0.1, timeoutMs: 20_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 2048, temperature: 0.1, timeoutMs: 30_000 },
      ],
    },
    opinion: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 45_000 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 60_000 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
    'simple-qa': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 700, temperature: 0.1, timeoutMs: 20_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 700, temperature: 0.1, timeoutMs: 12_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 700, temperature: 0.1, timeoutMs: 12_000 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 45_000 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 60_000 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
  },
  elsa: {
    'chat.answer': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1800, temperature: 0.2, timeoutMs: 30_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1600, temperature: 0.2, timeoutMs: 15_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1800, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
    'chat.card_gen': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 900, temperature: 0.1, timeoutMs: 12_000 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 900, temperature: 0.1, timeoutMs: 15_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 900, temperature: 0.1, timeoutMs: 20_000 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1500, temperature: 0.2, timeoutMs: 30_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1500, temperature: 0.2, timeoutMs: 15_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1500, temperature: 0.2, timeoutMs: 30_000 },
      ],
    },
  },
  ska: {
    'parsing.level3': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 2000, temperature: 0.1, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2000, temperature: 0.1, timeoutMs: 15000 },
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 2000, temperature: 0.1, timeoutMs: 10000 },
      ],
    },
    'selector.generate': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 1000, temperature: 0.1, timeoutMs: 10000 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 1000, temperature: 0.1, timeoutMs: 10000 },
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1000, temperature: 0.1, timeoutMs: 8000 },
      ],
    },
    classify: {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 500, temperature: 0, timeoutMs: 8000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 500, temperature: 0, timeoutMs: 6000 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 500, temperature: 0, timeoutMs: 8000 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1000, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1000, temperature: 0.1 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1000, temperature: 0.1 },
      ],
    },
  },
};

const TEAM_SELECTOR_DEFAULTS_OAUTH4: Record<string, any> = deepMerge(clone(TEAM_SELECTOR_DEFAULTS_LEGACY), {
  hub: {
    'alarm.classifier': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 200, temperature: 0 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 200, temperature: 0 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 200, temperature: 0 },
      ],
    },
    'alarm.interpreter.work': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 160, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 160, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.report': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 220, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 220, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.error': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 320, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 320, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.critical': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 320, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 320, temperature: 0.1 },
      ],
    },
    'roundtable.jay': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 500, temperature: 0.2 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.claude_lead': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 500, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 500, temperature: 0.1 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 500, temperature: 0.1 },
      ],
    },
    'roundtable.team_commander': {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 500, temperature: 0.2 },
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.judge': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 600, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 600, temperature: 0.1 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 600, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 300, temperature: 0.1 },
      ],
    },
  },
  claude: {
    dexter: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 300, temperature: 0.1 },
      ],
    },
    archer: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.2 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.3 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 2048, temperature: 0.2 },
      ],
    },
    lead: {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 300, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  blog: {
    'pos.writer': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 16000, temperature: 0.82 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 16000, temperature: 0.78, timeoutMs: 300_000 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'gems.writer': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 16000, temperature: 0.85 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 16000, temperature: 0.78, timeoutMs: 300_000 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'social.summarize': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'social.caption': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.summarize': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.caption': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'curriculum.recommend': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2000, temperature: 0.7 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2000, temperature: 0.7 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2000, temperature: 0.7 },
      ],
    },
    'curriculum.generate': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 8000, temperature: 0.5 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 8000, temperature: 0.5 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 8000, temperature: 0.5 },
      ],
    },
    'feedback.analyze': {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 700, temperature: 0.1 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 700, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 700, temperature: 0.1 },
      ],
    },
    'commenter.reply': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 600, temperature: 0.4, timeoutMs: 22_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_SCOUT_MODEL, maxTokens: 600, temperature: 0.55, timeoutMs: 15_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 600, temperature: 0.45, timeoutMs: 14_000 },
      ],
    },
    'commenter.neighbor': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 700, temperature: 0.45, timeoutMs: 22_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_SCOUT_MODEL, maxTokens: 700, temperature: 0.6, timeoutMs: 15_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 700, temperature: 0.5, timeoutMs: 14_000 },
      ],
    },
    'book_review.preview': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25_000 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25_000 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2048, temperature: 0.3 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 2048, temperature: 0.2 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 2048, temperature: 0.2 },
      ],
    },
  },
  core: {
    'chunked.gpt4o': {
      primary: { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.75 },
      ],
    },
    'chunked.default': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.75 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.75 },
      ],
    },
  },
  ska: {
    'parsing.level3': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2000, temperature: 0.1, timeoutMs: 15_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2000, temperature: 0.1, timeoutMs: 10_000 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2000, temperature: 0.1, timeoutMs: 15_000 },
      ],
    },
    'selector.generate': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1000, temperature: 0.1, timeoutMs: 10_000 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1000, temperature: 0.1, timeoutMs: 8_000 },
        { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 1000, temperature: 0.1, timeoutMs: 10_000 },
      ],
    },
    classify: {
      primary: { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 500, temperature: 0, timeoutMs: 8_000 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 500, temperature: 0, timeoutMs: 8_000 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 500, temperature: 0, timeoutMs: 8_000 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1000, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1000, temperature: 0.1 },
        { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1000, temperature: 0.1 },
      ],
    },
  },
});

function resolveTeamSelectorDefaults(version: TeamSelectorVersion): Record<string, any> {
  return version === TEAM_SELECTOR_VERSION_OAUTH4
    ? TEAM_SELECTOR_DEFAULTS_OAUTH4
    : TEAM_SELECTOR_DEFAULTS_LEGACY;
}

const AGENT_MODEL_REGISTRY: Record<string, Record<string, string | null>> = {
  claude: {
    reviewer: 'claude.reviewer.code_review',
    guardian: 'claude.guardian.safety',
    builder: 'claude._default',
    'quality-report': 'claude._default',
    dexter: 'claude.dexter.ai_analyst',
    archer: 'claude.archer.tech_analysis',
    lead: 'claude.lead.system_issue_triage',
    commander: 'claude.lead.system_issue_triage',
    refactorer: 'claude.refactorer.code_refactor',
    'auto-dev': 'claude.auto_dev.code_fix',
    doctor: 'claude.doctor.recovery',
  },
  blog: {
    blo: 'blog._default',
    richer: 'blog._default',
    pos: 'blog.pos.writer',
    gems: 'blog.gems.writer',
    publ: 'blog._default',
    star: 'blog.star.summarize',
    'social-summarize': 'blog.social.summarize',
    'social-caption': 'blog.social.caption',
    'curriculum-recommend': 'blog.curriculum.recommend',
    'curriculum-generate': 'blog.curriculum.generate',
    'feedback-learner': 'blog.feedback.analyze',
    commenter: 'blog.commenter.reply',
    'neighbor-commenter': 'blog.commenter.neighbor',
    'book-review-draft': 'blog.book_review.preview',
  },
  core: {
    'chunked-gpt4o': 'core.chunked.gpt4o',
    'chunked-default': 'core.chunked.default',
  },
  elsa: {
    chat: 'elsa.chat.answer',
    rag: 'elsa.chat.answer',
    vision: 'elsa.chat.answer',
    voice: 'elsa.chat.answer',
    'chat.card_gen': 'elsa.chat.card_gen',
  },
  justin: {
    default: 'justin._default',
    justin: 'justin.stage-3',
    'stage-3': 'justin.stage-3',
    'simple-qa': 'justin.simple-qa',
    analysis: 'justin.analysis',
    citation: 'justin.citation',
    opinion: 'justin.opinion',
    briefing: 'justin.analysis',
    lens: 'justin.analysis',
    garam: 'justin.citation',
    atlas: 'justin.citation',
    claim: 'justin.analysis',
    defense: 'justin.analysis',
    quill: 'justin.opinion',
    balance: 'justin.opinion',
    contro: 'justin.analysis',
    citecheck: 'justin.citation',
    chain: 'justin.analysis',
    bench: 'justin.opinion',
    delta: 'justin.analysis',
    'ledger-law': 'justin.analysis',
    'plaintiff-x': 'justin.analysis',
    'defense-x': 'justin.analysis',
    'neutral-bench': 'justin.opinion',
  },
  orchestrator: {
    default: 'orchestrator.jay.intent',
    intent: 'orchestrator.jay.intent',
    fallback: 'orchestrator.jay.chat_fallback',
    summary: 'orchestrator.jay.summary',
    steward: 'orchestrator.steward.work',
    'steward-digest': 'orchestrator.steward.digest',
    'steward-work': 'orchestrator.steward.work',
    'steward-incident': 'orchestrator.steward.incident_plan',
    'steward-pro-canary': 'orchestrator.steward.pro_canary',
  },
  sigma: {
    commander: 'sigma.agent_policy',
    'pod.risk': 'sigma.agent_policy',
    'pod.growth': 'sigma.agent_policy',
    'pod.trend': 'sigma.agent_policy',
    'skill.data_quality': 'sigma.agent_policy',
    'skill.causal': 'sigma.agent_policy',
    'skill.experiment_design': 'sigma.agent_policy',
    'skill.feature_planner': 'sigma.agent_policy',
    'skill.observability': 'sigma.agent_policy',
    'principle.self_critique': 'sigma.agent_policy',
    reflexion: 'sigma.agent_policy',
    espl: 'sigma.agent_policy',
    self_rewarding_judge: 'sigma.agent_policy',
    'mapek.monitor': 'sigma.agent_policy',
    'rag.query_planner': 'sigma.agent_policy',
    'rag.retriever': 'sigma.agent_policy',
    'rag.quality_evaluator': 'sigma.agent_policy',
    'rag.synthesizer': 'sigma.agent_policy',
  },
  darwin: {
    'darwin.scanner': 'darwin.agent_policy',
    'darwin.evaluator': 'darwin.agent_policy',
    'darwin.planner': 'darwin.agent_policy',
    'darwin.edison': 'darwin.agent_policy',
    'darwin.verifier': 'darwin.agent_policy',
    'darwin.commander': 'darwin.agent_policy',
    'darwin.reflexion': 'darwin.agent_policy',
    'darwin.espl': 'darwin.agent_policy',
    'darwin.self_rag': 'darwin.agent_policy',
    'darwin.self_rewarding_judge': 'darwin.agent_policy',
    'darwin.rag.query_planner': 'darwin.agent_policy',
    'darwin.rag.synthesizer': 'darwin.agent_policy',
    'darwin.synthesis': 'darwin.agent_policy',
    research: 'darwin.agent_policy',
    synthesis: 'darwin.agent_policy',
    commander: 'darwin.agent_policy',
    evaluator: 'darwin.agent_policy',
    planner: 'darwin.agent_policy',
    implementor: 'darwin.agent_policy',
    verifier: 'darwin.agent_policy',
    applier: 'darwin.agent_policy',
    learner: 'darwin.agent_policy',
    scanner: 'darwin.agent_policy',
    reflexion: 'darwin.agent_policy',
    'self_rag.retrieve': 'darwin.agent_policy',
    'self_rag.relevance': 'darwin.agent_policy',
    'espl.crossover': 'darwin.agent_policy',
    'espl.mutation': 'darwin.agent_policy',
    'principle.critique': 'darwin.agent_policy',
  },
  luna: {
    default: 'investment._default',
    luna: 'investment.luna',
    analyst: 'investment.agent_policy',
    validator: 'investment.agent_policy',
    commander: 'investment.agent_policy',
    nemesis: 'investment.nemesis',
    oracle: 'investment.oracle',
    hermes: 'investment.hermes',
    sophia: 'investment.sophia',
    zeus: 'investment.zeus',
    athena: 'investment.athena',
    argos: 'investment.argos',
    scout: 'investment.scout',
    chronos: 'investment.chronos',
    aria: 'investment.aria',
    'adaptive-risk': 'investment.adaptive-risk',
    sentinel: 'investment.sentinel',
    hephaestos: 'investment.hephaestos',
    hanul: 'investment.hanul',
    budget: 'investment.budget',
    kairos: 'investment.kairos',
    'stock-flow': 'investment.stock-flow',
    sweeper: 'investment.sweeper',
    reporter: 'investment.reporter',
  },
  investment: {
    luna: 'investment.luna',
    nemesis: 'investment.nemesis',
    oracle: 'investment.oracle',
    hermes: 'investment.hermes',
    sophia: 'investment.sophia',
    zeus: 'investment.zeus',
    athena: 'investment.athena',
    argos: 'investment.argos',
    scout: 'investment.scout',
    chronos: 'investment.chronos',
    aria: 'investment.aria',
    'adaptive-risk': 'investment.adaptive-risk',
    sentinel: 'investment.sentinel',
    hephaestos: 'investment.hephaestos',
    hanul: 'investment.hanul',
    budget: 'investment.budget',
    kairos: 'investment.kairos',
    'stock-flow': 'investment.stock-flow',
    sweeper: 'investment.sweeper',
    reporter: 'investment.reporter',
  },
  ska: {
    'parsing-guard': 'ska.parsing.level3',
    'selector-generator': 'ska.selector.generate',
    'error-classifier': 'ska.classify',
    andy: 'ska.classify',
    jimmy: 'ska.classify',
    rebecca: 'ska._default',
    eve: 'ska._default',
    'ska-reflexion-engine': 'ska._default',
    'ska-roundtable-jay': 'ska._default',
    'ska-roundtable-claude': 'ska._default',
    'ska-roundtable-commander': 'ska._default',
  },
};

const RETIRED_GATEWAY_NAME = ['open', 'claw'].join('');
const RETIRED_GATEWAY_LABEL = [RETIRED_GATEWAY_NAME, 'gateway'].join('-');

const RETIRED_TEAM_NAMES = new Set([
  'worker',
  'video',
  'edi',
  'academic',
  'business',
  'data',
  'secretary',
]);

const RETIRED_TARGET_MARKERS = new Set([
  'worker',
  'video',
  'edi',
  RETIRED_GATEWAY_NAME,
  RETIRED_GATEWAY_LABEL,
  'worker-ops',
  'video-edi',
]);

const PLANNED_TEAMS = new Set<string>([]);
const PENDING_RUNTIME_TEAMS = new Set(['legal']);
const ACTIVE_BLOG_VISIBLE_AGENTS = new Set(['blo', 'richer', 'pos', 'gems', 'publ', 'star']);
const ACTIVE_SKA_VISIBLE_AGENTS = new Set(['andy', 'jimmy', 'rebecca', 'eve']);

function normalizeTargetToken(value: any): string {
  return String(value || '').trim().toLowerCase();
}

function containsRetiredTargetMarker(team: string, agent: string, selectorKey: string | null): boolean {
  const teamToken = normalizeTargetToken(team);
  if (RETIRED_TEAM_NAMES.has(teamToken)) return true;

  const tokens = [
    teamToken,
    normalizeTargetToken(agent),
    normalizeTargetToken(selectorKey),
  ].filter(Boolean);
  return tokens.some((token) => (
    RETIRED_TARGET_MARKERS.has(token)
      || token.includes(RETIRED_GATEWAY_NAME)
      || token.includes('worker-ops')
      || token.includes('video-edi')
  ));
}

function isDarwinAlias(agent: string): boolean {
  const key = normalizeTargetToken(agent);
  if (!key || key.includes('.')) return false;
  return Boolean((AGENT_MODEL_REGISTRY.darwin || {})[`darwin.${key}`]);
}

function isDarwinTaskRoute(agent: string): boolean {
  const key = normalizeTargetToken(agent);
  return key.includes('.rag.')
    || key.includes('self_rag')
    || key.startsWith('self_rag.')
    || key.startsWith('espl.')
    || key.includes('.espl')
    || key.startsWith('principle.')
    || key.includes('.principle.');
}

function isTaskRoute(team: string, agent: string): boolean {
  const normalizedTeam = normalizeTargetToken(team);
  const normalizedAgent = normalizeTargetToken(agent);
  if (normalizedTeam === 'core') return true;
  if (normalizedTeam === 'blog') return !ACTIVE_BLOG_VISIBLE_AGENTS.has(normalizedAgent);
  if (normalizedTeam === 'ska') return !ACTIVE_SKA_VISIBLE_AGENTS.has(normalizedAgent);
  if (normalizedTeam === 'sigma') return normalizedAgent !== 'commander';
  if (normalizedTeam === 'darwin') return isDarwinTaskRoute(normalizedAgent);
  return false;
}

export function classifyLlmRouteTarget(team: string, agent = '', selectorKey: string | null = null): LlmRouteTarget {
  const normalizedTeam = normalizeTargetToken(team || String(selectorKey || '').split('.')[0]);
  const normalizedAgent = normalizeTargetToken(agent);
  const normalizedSelectorKey = selectorKey ? String(selectorKey) : null;

  if (containsRetiredTargetMarker(normalizedTeam, normalizedAgent, normalizedSelectorKey)) {
    return {
      team: normalizedTeam,
      agent: normalizedAgent,
      selectorKey: normalizedSelectorKey,
      selected: Boolean(normalizedSelectorKey),
      kind: 'retired',
      canonicalTeam: normalizedTeam,
      countable: false,
      blockReason: 'retired_llm_target',
    };
  }
  if (PLANNED_TEAMS.has(normalizedTeam)) {
    return {
      team: normalizedTeam,
      agent: normalizedAgent,
      selectorKey: normalizedSelectorKey,
      selected: Boolean(normalizedSelectorKey),
      kind: 'planned',
      canonicalTeam: normalizedTeam,
      countable: false,
      blockReason: 'planned_llm_target',
    };
  }
  if (PENDING_RUNTIME_TEAMS.has(normalizedTeam)) {
    return {
      team: normalizedTeam,
      agent: normalizedAgent,
      selectorKey: normalizedSelectorKey,
      selected: Boolean(normalizedSelectorKey),
      kind: 'pending_runtime',
      canonicalTeam: normalizedTeam,
      countable: false,
      blockReason: 'pending_runtime_llm_target',
    };
  }
  if (normalizedTeam === 'luna') {
    return {
      team: normalizedTeam,
      agent: normalizedAgent,
      selectorKey: normalizedSelectorKey,
      selected: Boolean(normalizedSelectorKey),
      kind: 'alias',
      canonicalTeam: 'investment',
      countable: false,
      blockReason: null,
    };
  }
  if (normalizedTeam === 'orchestrator' || normalizedTeam === 'hub') {
    return {
      team: normalizedTeam,
      agent: normalizedAgent,
      selectorKey: normalizedSelectorKey,
      selected: Boolean(normalizedSelectorKey),
      kind: 'runtime_service',
      canonicalTeam: normalizedTeam,
      countable: false,
      blockReason: null,
    };
  }
  if (normalizedTeam === 'darwin' && isDarwinAlias(normalizedAgent)) {
    return {
      team: normalizedTeam,
      agent: normalizedAgent,
      selectorKey: normalizedSelectorKey,
      selected: Boolean(normalizedSelectorKey),
      kind: 'alias',
      canonicalTeam: 'darwin',
      countable: false,
      blockReason: null,
    };
  }
  const kind: LlmRouteTargetKind = isTaskRoute(normalizedTeam, normalizedAgent) ? 'task_route' : 'visible_agent';
  return {
    team: normalizedTeam,
    agent: normalizedAgent,
    selectorKey: normalizedSelectorKey,
    selected: Boolean(normalizedSelectorKey),
    kind,
    canonicalTeam: normalizedTeam,
    countable: kind === 'visible_agent',
    blockReason: null,
  };
}

export function isLlmRouteTargetAllowed(input: { callerTeam?: string | null; agent?: string | null; selectorKey?: string | null } = {}): {
  ok: boolean;
  target: LlmRouteTarget;
  error: string | null;
} {
  const target = classifyLlmRouteTarget(
    input.callerTeam || String(input.selectorKey || '').split('.')[0],
    input.agent || '',
    input.selectorKey || null,
  );
  const allowPlanned = parseEnabledFlag(process.env.HUB_ALLOW_PLANNED_LLM_ROUTES) === true;
  if (target.kind === 'retired') {
    return { ok: false, target, error: target.blockReason || 'retired_llm_target' };
  }
  if (target.blockReason && !allowPlanned) {
    return { ok: false, target, error: target.blockReason };
  }
  return { ok: true, target, error: null };
}

export function listLlmRouteTargets(options: {
  team?: string | null;
  includeInternal?: boolean;
  includeAliases?: boolean;
  includeBlocked?: boolean;
} = {}): LlmRouteTarget[] {
  const requestedTeam = options.team ? normalizeTargetToken(options.team) : null;
  const includeInternal = Boolean(options.includeInternal);
  const includeAliases = options.includeAliases ?? Boolean(requestedTeam);
  const includeBlocked = options.includeBlocked ?? Boolean(requestedTeam);
  const teams = requestedTeam ? { [requestedTeam]: AGENT_MODEL_REGISTRY[requestedTeam] || {} } : AGENT_MODEL_REGISTRY;
  const entries: LlmRouteTarget[] = [];
  for (const [teamName, agents] of Object.entries(teams)) {
    for (const [agentName, selectorKey] of Object.entries(agents || {})) {
      const target = classifyLlmRouteTarget(teamName, agentName, selectorKey || null);
      if (!includeInternal && (target.kind === 'task_route' || target.kind === 'runtime_service')) continue;
      if (!includeAliases && target.kind === 'alias') continue;
      if (!includeBlocked && ['retired', 'planned', 'pending_runtime'].includes(target.kind)) continue;
      entries.push(target);
    }
  }
  return entries.sort((a, b) => `${a.team}.${a.agent}`.localeCompare(`${b.team}.${b.agent}`));
}

function normalizeTeamDefaultEntry(entry: any): any {
  if (isObject(entry) && entry.enabled === false) {
    return { enabled: false, primary: null, fallbacks: [], chain: [] };
  }
  if (!isObject(entry) || !isObject(entry.primary)) return null;
  return {
    enabled: true,
    primary: clone(entry.primary),
    fallbacks: Array.isArray(entry.fallbacks) ? clone(entry.fallbacks) : [],
    chain: [clone(entry.primary), ...(Array.isArray(entry.fallbacks) ? clone(entry.fallbacks) : [])],
  };
}

function resolveFromTeamDefault(selectorKey: string, options: SelectorOptions = {}): any {
  const parts = String(selectorKey || '').split('.');
  const team = parts[0];
  const restKey = parts.slice(1).join('.');
  const shortKey = parts[1] || '';
  const selectorVersion = resolveSelectorVersionForKey(selectorKey, options);
  const teamDefaults = resolveTeamSelectorDefaults(selectorVersion)[team];
  if (!teamDefaults) return null;
  if (restKey === '_default') return normalizeTeamDefaultEntry(teamDefaults._fallback || null);
  return normalizeTeamDefaultEntry(teamDefaults[restKey] || teamDefaults[shortKey] || teamDefaults._fallback || null);
}

export function routeEntryFromAbstractRoute(route: string, selectorVersion: TeamSelectorVersion = TEAM_SELECTOR_VERSION_LEGACY): LLMChainEntry {
  const normalized = String(route || 'anthropic_haiku');
  if (normalized === 'openai_perf') {
    return { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2048, temperature: 0.1 };
  }
  if (normalized === 'openai_mini') {
    return { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens: 1024, temperature: 0.1 };
  }
  if (normalized === 'local_embedding') {
    return localEmbeddingEntry();
  }
  if (normalized === 'gemini_flash') {
    return { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2048, temperature: 0.1 };
  }
  if (normalized === 'gemini_flash_lite') {
    return { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 };
  }
  if (normalized === 'groq_scout') {
    return { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 };
  }
  if (normalized === 'qwen_deep') {
    return { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2048, temperature: 0.1 };
  }
  if (normalized.includes('opus')) {
    if (selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4) {
      return { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2048, temperature: 0.1 };
    }
    return { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 2048, temperature: 0.1 };
  }
  if (normalized.includes('sonnet')) {
    if (selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4) {
      return { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2048, temperature: 0.1 };
    }
    return { provider: 'openai-oauth', model: OPENAI_PERF_MODEL, maxTokens: 2048, temperature: 0.1 };
  }
  if (normalized.includes('haiku')) {
    if (selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4) {
      return { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 };
    }
    return { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 };
  }
  if (selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4) {
    return { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens: 1024, temperature: 0.1 };
  }
  return { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 };
}

function buildAbstractRoutePolicy(route: string, fallbacks: string[] = [], selectorVersion: TeamSelectorVersion = TEAM_SELECTOR_VERSION_LEGACY): any {
  const chain = [route, ...fallbacks].map((item) => routeEntryFromAbstractRoute(item, selectorVersion));
  return {
    route,
    primary: chain[0] || null,
    fallbacks: chain.slice(1),
    fallbackChain: chain,
  };
}

function buildSelectorRegistry(): Record<string, any> {
  return {
    'hub._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub._default', options),
    'hub.alarm.classifier': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.alarm.classifier', options),
    'hub.alarm.interpreter.work': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.alarm.interpreter.work', options),
    'hub.alarm.interpreter.report': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.alarm.interpreter.report', options),
    'hub.alarm.interpreter.error': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.alarm.interpreter.error', options),
    'hub.alarm.interpreter.critical': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.alarm.interpreter.critical', options),
    'hub.roundtable.jay': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.roundtable.jay', options),
    'hub.roundtable.claude_lead': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.roundtable.claude_lead', options),
    'hub.roundtable.team_commander': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.roundtable.team_commander', options),
    'hub.roundtable.judge': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.roundtable.judge', options),
    'hub.control.planner': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.control.planner', options),
    'hub.session.compaction': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.session.compaction', options),
    'hub.oauth.gemini_cli.expiry_probe': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.oauth.gemini_cli.expiry_probe', options),
    'hub.gemini.cli.adapter.smoke': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.gemini.cli.adapter.smoke', options),
    'hub.gemini.cli.readiness.live': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.gemini.cli.readiness.live', options),
    'hub.unified.oauth.openai.smoke': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.unified.oauth.openai.smoke', options),
    'hub.unified.oauth.gemini.smoke': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.unified.oauth.gemini.smoke', options),
    'hub.load_test.fast': (options: SelectorOptions = {}) => resolveFromTeamDefault('hub.load_test.fast', options),
    'elsa._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('elsa._default', options),
    'elsa.chat.answer': (options: SelectorOptions = {}) => resolveFromTeamDefault('elsa.chat.answer', options),
    'elsa.chat.card_gen': (options: SelectorOptions = {}) => resolveFromTeamDefault('elsa.chat.card_gen', options),

    'claude._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude._default', options),
    'claude.archer.tech_analysis': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.archer.tech_analysis', options),
    'claude.lead.system_issue_triage': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.lead.system_issue_triage', options),
    'claude.dexter.ai_analyst': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.dexter.ai_analyst', options),
    'claude.refactorer.code_refactor': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.refactorer.code_refactor', options),
    'claude.auto_dev.code_fix': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.auto_dev.code_fix', options),
    'claude.reviewer.code_review': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.reviewer.code_review', options),
    'claude.doctor.recovery': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.doctor.recovery', options),
    'claude.guardian.safety': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.guardian.safety', options),

    'orchestrator.jay.intent': ({ intentPrimary, intentFallback }: SelectorOptions = {}) => ({
      primary: {
        provider: intentPrimary ? inferProviderFromModel(intentPrimary) : 'gemini-cli-oauth',
        model: intentPrimary || GEMINI_CLI_FLASH_LITE_MODEL,
      },
      fallback: {
        provider: intentFallback ? inferProviderFromModel(intentFallback) : 'groq',
        model: intentFallback
          ? (intentFallback.startsWith('gemini-cli-oauth/')
              ? intentFallback
              : `gemini-cli-oauth/${intentFallback.replace(/^google-gemini-cli\//, '').replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`)
          : GROQ_FAST_MODEL,
      },
    }),

    'orchestrator.jay.chat_fallback': ({ chatFallbackChain }: SelectorOptions = {}) => {
      if (Array.isArray(chatFallbackChain) && chatFallbackChain.length > 0) {
        return chatFallbackChain.map((item) => ({
          provider: item.provider,
          model: item.model,
          maxTokens: item.maxTokens ?? 300,
          temperature: item.temperature ?? 0.5,
        }));
      }
      return [
        { provider: 'groq', model: 'openai/gpt-oss-20b', maxTokens: 300, temperature: 0.5 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 300, temperature: 0.7 },
      ];
    },

    'orchestrator.jay.summary': ({ maxTokens = 700 }: SelectorOptions = {}) => [
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.2, timeoutMs: 30_000 },
      { provider: 'groq', model: GROQ_FAST_MODEL, maxTokens, temperature: 0.2, timeoutMs: 10_000 },
      { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens, temperature: 0.2, timeoutMs: 12_000 },
    ],

    'orchestrator.steward.digest': ({ maxTokens = 220 }: SelectorOptions = {}) => [
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens, temperature: 0.1, timeoutMs: 20_000 },
    ],

    'orchestrator.steward.work': ({ maxTokens = 320 }: SelectorOptions = {}) => [
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.2, timeoutMs: 30_000 },
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens, temperature: 0.2, timeoutMs: 25_000 },
    ],

    'orchestrator.steward.incident_plan': ({ maxTokens = 700 }: SelectorOptions = {}) => [
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.2, timeoutMs: 45_000 },
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens, temperature: 0.2, timeoutMs: 30_000 },
    ],

    'orchestrator.steward.pro_canary': ({ maxTokens = 128 }: SelectorOptions = {}) => [
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.2, timeoutMs: 45_000 },
      { provider: 'openai-oauth', model: OPENAI_MINI_MODEL, maxTokens, temperature: 0.2, timeoutMs: 15_000 },
    ],

    'blog._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog._default', options),
    'blog.pos.writer': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.pos.writer', options),
    'blog.gems.writer': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.gems.writer', options),
    'blog.social.summarize': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.social.summarize', options),
    'blog.social.caption': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.social.caption', options),
    'blog.star.summarize': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.star.summarize', options),
    'blog.star.caption': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.star.caption', options),
    'blog.curriculum.recommend': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.curriculum.recommend', options),
    'blog.curriculum.generate': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.curriculum.generate', options),
    'blog.feedback.analyze': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.feedback.analyze', options),
    'blog.commenter.reply': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.commenter.reply', options),
    'blog.commenter.neighbor': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.commenter.neighbor', options),
    'blog.book_review.preview': (options: SelectorOptions = {}) => resolveFromTeamDefault('blog.book_review.preview', options),


    'core._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('core._default', options),
    'core.chunked.gpt4o': (options: SelectorOptions = {}) => resolveFromTeamDefault('core.chunked.gpt4o', options),
    'core.chunked.default': (options: SelectorOptions = {}) => resolveFromTeamDefault('core.chunked.default', options),

    'justin._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('justin._default', options),
    'justin.stage-3': (options: SelectorOptions = {}) => resolveFromTeamDefault('justin.stage-3', options),
    'justin.analysis': (options: SelectorOptions = {}) => resolveFromTeamDefault('justin.analysis', options),
    'justin.citation': (options: SelectorOptions = {}) => resolveFromTeamDefault('justin.citation', options),
    'justin.opinion': (options: SelectorOptions = {}) => resolveFromTeamDefault('justin.opinion', options),
    'justin.simple-qa': (options: SelectorOptions = {}) => resolveFromTeamDefault('justin.simple-qa', options),

    'ska._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska._default', options),
    'ska.parsing.level3': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska.parsing.level3', options),
    'ska.selector.generate': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska.selector.generate', options),
    'ska.classify': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska.classify', options),

    'sigma.agent_policy': (options: SelectorOptions = {}) => {
      const { agentName } = options;
      const SIGMA_ROUTES: Record<string, { route: string; fallback: string[] }> = {
        commander:                  { route: 'openai_perf', fallback: ['anthropic_sonnet', 'anthropic_haiku'] },
        'pod.risk':                 { route: 'qwen_deep', fallback: ['gemini_flash', 'openai_mini'] },
        'pod.growth':               { route: 'anthropic_haiku', fallback: [] },
        'pod.trend':                { route: 'anthropic_haiku', fallback: [] },
        'skill.data_quality':       { route: 'anthropic_haiku', fallback: [] },
        'skill.causal':             { route: 'qwen_deep', fallback: ['gemini_flash', 'openai_mini'] },
        'skill.experiment_design':  { route: 'gemini_flash', fallback: ['anthropic_sonnet', 'anthropic_haiku'] },
        'skill.feature_planner':    { route: 'anthropic_haiku', fallback: [] },
        'skill.observability':      { route: 'anthropic_haiku', fallback: [] },
        'principle.self_critique':  { route: 'anthropic_opus', fallback: ['anthropic_sonnet'] },
        reflexion:                  { route: 'gemini_flash', fallback: ['qwen_deep', 'openai_mini'] },
        espl:                       { route: 'gemini_flash', fallback: ['anthropic_sonnet', 'anthropic_haiku'] },
        self_rewarding_judge:       { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'mapek.monitor':            { route: 'anthropic_haiku', fallback: [] },
        'rag.query_planner':        { route: 'anthropic_haiku', fallback: [] },
        'rag.retriever':            { route: 'anthropic_haiku', fallback: [] },
        'rag.quality_evaluator':    { route: 'anthropic_haiku', fallback: [] },
        'rag.synthesizer':          { route: 'anthropic_haiku', fallback: [] },
      };
      const key = String(agentName || 'commander');
      const entry = SIGMA_ROUTES[key] || { route: 'anthropic_haiku', fallback: [] };
      const selectorVersion = resolveSelectorVersionForKey('sigma.agent_policy', options);
      return buildAbstractRoutePolicy(entry.route, entry.fallback, selectorVersion);
    },

    'darwin.agent_policy': (options: SelectorOptions = {}) => {
      const { agentName } = options;
      const DARWIN_ROUTES: Record<string, { route: string; fallback: string[] }> = {
        'darwin.scanner':              { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.evaluator':            { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.planner':              { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.edison':               { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.verifier':             { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.commander':            { route: 'anthropic_opus', fallback: ['anthropic_sonnet'] },
        'darwin.reflexion':            { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.espl':                 { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.self_rag':             { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.self_rewarding_judge': { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.rag.query_planner':    { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.rag.synthesizer':      { route: 'openai_mini', fallback: ['groq_scout'] },
        'darwin.synthesis':            { route: 'openai_perf', fallback: ['groq_scout'] },
        research:                      { route: 'openai_mini', fallback: ['groq_scout'] },
        synthesis:                     { route: 'openai_perf', fallback: ['groq_scout'] },
        commander:                     { route: 'openai_perf', fallback: ['anthropic_sonnet', 'anthropic_haiku'] },
        evaluator:                     { route: 'openai_mini', fallback: ['groq_scout'] },
        planner:                       { route: 'openai_mini', fallback: ['groq_scout'] },
        implementor:                   { route: 'openai_perf', fallback: ['groq_scout'] },
        verifier:                      { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        applier:                       { route: 'openai_mini', fallback: ['groq_scout'] },
        learner:                       { route: 'openai_mini', fallback: ['groq_scout'] },
        scanner:                       { route: 'openai_mini', fallback: ['groq_scout'] },
        reflexion:                     { route: 'openai_mini', fallback: ['groq_scout'] },
        'self_rag.retrieve':           { route: 'openai_mini', fallback: ['groq_scout'] },
        'self_rag.relevance':          { route: 'openai_mini', fallback: ['groq_scout'] },
        'espl.crossover':              { route: 'openai_mini', fallback: ['groq_scout'] },
        'espl.mutation':               { route: 'openai_mini', fallback: ['groq_scout'] },
        'principle.critique':          { route: 'openai_perf', fallback: ['groq_scout'] },
      };
      const key = String(agentName || 'commander');
      const entry = DARWIN_ROUTES[key] || { route: 'anthropic_haiku', fallback: [] };
      const selectorVersion = resolveSelectorVersionForKey('darwin.agent_policy', options);
      return buildAbstractRoutePolicy(entry.route, entry.fallback, selectorVersion);
    },

    'investment.agent_policy': (options: SelectorOptions = {}) => {
      const { agentName, agentModel = null, openaiPerfModel = OPENAI_PERF_MODEL, policyOverride } = options;
      const normalizedAgentName = String(agentName || '');
      const defaultRoutesLegacy: Record<string, string> = {
        default: 'openai_perf',
        luna: 'openai_perf',
        nemesis: 'dual_groq',
        oracle: 'groq_scout',
        hermes: 'local_primary',
        sophia: 'local_primary',
        zeus: 'groq_scout',
        athena: 'groq_scout',
        argos: 'groq_scout',
        scout: 'groq_scout',
        chronos: 'openai_perf',
        aria: 'local_fast',
        'adaptive-risk': 'groq_with_local',
        sentinel: 'openai_mini',
        hephaestos: 'local_fast',
        hanul: 'local_fast',
        budget: 'local_fast',
        kairos: 'openai_perf',
        'stock-flow': 'groq_with_local',
        sweeper: 'local_fast',
        reporter: 'market_reporter',
      };
      const defaultRoutesOauth4: Record<string, string> = {
        default: 'groq_with_local',
        luna: 'groq_with_local',
        nemesis: 'groq_with_local',
        oracle: 'groq_scout',
        hermes: 'local_primary',
        sophia: 'local_primary',
        zeus: 'groq_with_local',
        athena: 'groq_scout',
        argos: 'groq_scout',
        scout: 'gemini_flash',
        chronos: 'groq_with_local',
        aria: 'gemini_flash',
        'adaptive-risk': 'groq_with_local',
        sentinel: 'gemini_flash_lite',
        hephaestos: 'local_fast',
        hanul: 'groq_with_local',
        budget: 'local_fast',
        kairos: 'gemini_flash',
        'stock-flow': 'groq_with_local',
        sweeper: 'gemini_flash_lite',
        reporter: 'market_reporter',
      };

      const selectorVersion = resolveSelectorVersionForKey('investment.agent_policy', options);
      const defaultRoutes = selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4 ? defaultRoutesOauth4 : defaultRoutesLegacy;
      const configuredRoutes = isObject(policyOverride?.agentRoutes) ? { ...defaultRoutes, ...policyOverride.agentRoutes } : defaultRoutes;
      const openaiMiniModel = policyOverride?.openaiMiniModel || OPENAI_MINI_MODEL;
      const groqScoutModel = policyOverride?.groqScoutModel || 'llama-3.1-8b-instant';
      const groqCompetitionModels = Array.isArray(policyOverride?.groqCompetitionModels) && policyOverride.groqCompetitionModels.length > 0
        ? clone(policyOverride.groqCompetitionModels)
        : ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];
      const anthropicModel = policyOverride?.anthropicModel || 'claude-haiku-4-5-20251001';
      const modelDerivedRoute = buildRouteFromAgentModel(agentModel, {
        openaiPerfModel,
        openaiMiniModel,
        groqScoutModel,
        groqCompetitionModels,
      });
      const configuredRoute = configuredRoutes[normalizedAgentName] || null;
      const route = selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4
        ? (configuredRoute || modelDerivedRoute || 'groq_scout')
        : (normalizedAgentName === 'argos'
          ? (configuredRoute || modelDerivedRoute || 'groq_scout')
          : (modelDerivedRoute || configuredRoute || 'groq_scout'));
      const routeChains: Record<string, LLMChainEntry[]> = {
        local_embedding: [
          localEmbeddingEntry(),
        ],
        openai_perf: [
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        dual_groq: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'groq', model: groqCompetitionModels[1] || groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        openai_mini: [
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        local_primary: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        groq_scout: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        local_fast: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
        ],
        local_deep: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b', maxTokens: 2048, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2048, temperature: 0.1 },
        ],
        groq_with_local: [
          { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 2048, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 2048, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 2048, temperature: 0.1 },
        ],
        claude_sonnet: [
          { provider: 'openai-oauth', model: openaiPerfModel, maxTokens: 1500, temperature: 0.2 },
          { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 1500, temperature: 0.2 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1500, temperature: 0.2 },
        ],
        claude_haiku: [
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 800, temperature: 0.1 },
          { provider: 'groq', model: groqScoutModel, maxTokens: 800, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 800, temperature: 0.1 },
        ],
        claude_opus: [
          { provider: 'openai-oauth', model: openaiPerfModel, maxTokens: 1500, temperature: 0.1 },
          { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 1500, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1500, temperature: 0.1 },
        ],
        market_reporter: [
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 4096, temperature: 0.2, timeoutMs: 45_000 },
          { provider: 'groq', model: GROQ_DEEP_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 45_000 },
          { provider: 'openai-oauth', model: openaiPerfModel, maxTokens: 4096, temperature: 0.2, timeoutMs: 90_000 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_PRO_MODEL, maxTokens: 4096, temperature: 0.2, timeoutMs: 90_000 },
        ],
        gemini_flash: [
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1000, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 1000, temperature: 0.1 },
          { provider: 'groq', model: 'llama-3.3-70b-versatile', maxTokens: 1000, temperature: 0.1 },
        ],
        gemini_flash_lite: [
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 400, temperature: 0.1 },
          { provider: 'groq', model: groqScoutModel, maxTokens: 400, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 400, temperature: 0.1 },
        ],
      };
      const selectedChain = routeChains[route] || routeChains.groq_scout;
      return {
        route,
        openaiPerfModel,
        openaiMiniModel,
        groqScoutModel,
        groqCompetitionModels,
        anthropicModel,
        selectorVersion,
        primary: selectedChain[0] || null,
        fallbacks: selectedChain.slice(1),
        fallbackChain: selectedChain,
      };
    },
  };
}

const SELECTOR_REGISTRY = buildSelectorRegistry();

const INVESTMENT_EXPLICIT_SELECTOR_AGENTS = [
  'luna',
  'nemesis',
  'oracle',
  'hermes',
  'sophia',
  'zeus',
  'athena',
  'argos',
  'scout',
  'chronos',
  'aria',
  'adaptive-risk',
  'sentinel',
  'hephaestos',
  'hanul',
  'budget',
  'kairos',
  'stock-flow',
  'sweeper',
  'reporter',
];

SELECTOR_REGISTRY['investment._default'] = (options: SelectorOptions = {}) => (
  SELECTOR_REGISTRY['investment.agent_policy']({ ...options, agentName: 'default' })
);

SELECTOR_REGISTRY['chronos.backtest'] = () => ({
  route: 'local_embedding',
  primary: localEmbeddingEntry(),
  fallbacks: [],
  fallbackChain: [localEmbeddingEntry()],
});

SELECTOR_REGISTRY['investment.chronos.backtest'] = SELECTOR_REGISTRY['chronos.backtest'];

for (const agentName of INVESTMENT_EXPLICIT_SELECTOR_AGENTS) {
  SELECTOR_REGISTRY[`investment.${agentName}`] = (options: SelectorOptions = {}) => (
    SELECTOR_REGISTRY['investment.agent_policy']({ ...options, agentName })
  );
}

function normalizeChainFromPolicy(policy: any): LLMChainEntry[] | null {
  if (Array.isArray(policy)) return clone(policy);
  if (policy?.enabled === false) return [];
  if (Array.isArray(policy?.chain)) return clone(policy.chain);
  if (Array.isArray(policy?.fallbackChain)) return clone(policy.fallbackChain);
  if (isObject(policy?.primary)) {
    const chain = [clone(policy.primary)];
    if (isObject(policy.fallback)) chain.push(clone(policy.fallback));
    if (Array.isArray(policy.fallbacks)) chain.push(...clone(policy.fallbacks));
    return chain;
  }
  if (isObject(policy) && typeof policy.model === 'string') return [clone(policy)];
  return null;
}

export function selectLLMPolicy(key: string, options: SelectorOptions = {}): any {
  const entry = SELECTOR_REGISTRY[key];
  if (!entry) throw new Error(`알 수 없는 LLM selector key: ${key}`);
  const resolved = typeof entry === 'function' ? entry(options) : clone(entry);
  return applyPolicyOverride(resolved, options.policyOverride, options);
}

export function selectLLMChain(key: string, options: SelectorOptions = {}): LLMChainEntry[] {
  const resolved = selectLLMPolicy(key, options);
  const normalizedChain = normalizeChainFromPolicy(resolved);
  if (!normalizedChain) throw new Error(`LLM selector key ${key} 는 chain이 아닙니다`);
  return applyProviderRuntimeGuards(normalizedChain, { ...options, selectorKey: key });
}

export function describeLLMSelector(key: string, options: SelectorOptions = {}): any {
  const resolved = selectLLMPolicy(key, options);
  if (resolved?.enabled === false) {
    return { key, kind: 'none', primary: null, fallbacks: [], chain: [], enabled: false };
  }
  const chain = normalizeChainFromPolicy(resolved);
  if (chain) {
    const guardedChain = applyProviderRuntimeGuards(chain, { ...options, selectorKey: key });
    return { key, kind: 'chain', primary: guardedChain[0] || null, fallbacks: guardedChain.slice(1), chain: guardedChain };
  }
  return { key, kind: 'policy', policy: resolved };
}

export function listLLMSelectorKeys(): string[] {
  return Object.keys(SELECTOR_REGISTRY).sort();
}

export function listAgentModelTargets(team: string | null = null): LlmRouteTarget[] {
  return listLlmRouteTargets({
    team,
    includeInternal: true,
    includeAliases: Boolean(team),
    includeBlocked: false,
  }).filter((target) => (
    target.kind === 'visible_agent'
    || target.kind === 'runtime_service'
    || (Boolean(team) && target.kind === 'alias')
  ));
}

export function describeAgentModel(team: string, agentName: string, selectorOptions: Record<string, SelectorOptions> = {}): any {
  const selectorKey = AGENT_MODEL_REGISTRY?.[team]?.[agentName] || null;
  if (!selectorKey) {
    return { team, agent: agentName, selectorKey: null, selected: false, description: null, chain: [] };
  }
  const description = describeLLMSelector(selectorKey, { agentName, ...(selectorOptions[selectorKey] || {}) });
  return {
    team,
    agent: agentName,
    selectorKey,
    selected: Array.isArray(description?.chain) && description.chain.length > 0,
    description,
    chain: Array.isArray(description?.chain) ? description.chain : [],
  };
}
