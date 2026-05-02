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

const GEMINI_CLI_FLASH_LITE_MODEL = 'gemini-cli-oauth/gemini-2.5-flash-lite';
const GEMINI_CLI_FLASH_MODEL = 'gemini-cli-oauth/gemini-2.5-flash';
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

function parseRolloutPercent(options: SelectorOptions = {}): number {
  const optionPercent = Number(options.rolloutPercent);
  if (Number.isFinite(optionPercent)) {
    return Math.max(0, Math.min(100, Math.floor(optionPercent)));
  }
  const envPercent = Number(process.env.LLM_TEAM_SELECTOR_AB_PERCENT || '');
  if (Number.isFinite(envPercent)) {
    return Math.max(0, Math.min(100, Math.floor(envPercent)));
  }
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
  const envVersion = normalizeSelectorVersion(process.env.LLM_TEAM_SELECTOR_VERSION);
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
  if (!model) return 'anthropic';
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
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  if (model.startsWith('gemini-codeassist-oauth/') || model.startsWith('gemini-code-assist-oauth/')) return 'gemini-codeassist-oauth';
  if (model.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  if (model.startsWith('gemini-oauth/')) return 'gemini-oauth';
  if (model.startsWith('gemini-') || model.startsWith('google-gemini-cli/')) return 'gemini';
  return 'anthropic';
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
  if (preferredApi === 'anthropic') return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 };
  if (preferredApi === 'openai') return { provider: 'openai', model: 'gpt-4o-mini', maxTokens, temperature: 0.1 };
  if (preferredApi === 'gemini' || preferredApi === 'gemini-oauth' || preferredApi === 'gemini-cli-oauth') {
    return { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.1 };
  }
  return { provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 };
}

function buildRouteFromAgentModel(agentModel: string | null | undefined, {
  openaiPerfModel = 'gpt-5.4',
  openaiMiniModel = 'gpt-4o-mini',
  groqScoutModel = 'llama-3.1-8b-instant',
  groqCompetitionModels = ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
}: {
  openaiPerfModel?: string;
  openaiMiniModel?: string;
  groqScoutModel?: string;
  groqCompetitionModels?: string[];
} = {}): string | null {
  const normalized = String(agentModel || '').trim();
  if (!normalized) return null;
  if (normalized === 'openai-oauth/gpt-5.4') return 'openai_perf';
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
  if (preferredApi === 'claude-code') return list.filter((provider) => provider !== 'anthropic');
  return list;
}

function stripGroqPrefix(model = ''): string {
  return model.startsWith('groq/') ? model.slice(5) : model;
}

function dedupeByProvider(chain: LLMChainEntry[]): LLMChainEntry[] {
  return chain.filter((entry, index, array) => array.findIndex((candidate) => candidate.provider === entry.provider) === index);
}

const TEAM_SELECTOR_DEFAULTS_LEGACY: Record<string, any> = {
  hub: {
    'alarm.classifier': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 200, temperature: 0 },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 200, temperature: 0 },
      ],
    },
    'alarm.interpreter.work': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 200, temperature: 0.1 },
      fallbacks: [],
    },
    'alarm.interpreter.report': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 300, temperature: 0.1 },
      fallbacks: [],
    },
    'alarm.interpreter.error': {
      primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 400, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 400, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.critical': {
      primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 400, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 400, temperature: 0.1 },
      ],
    },
    'roundtable.jay': {
      primary: { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.claude_lead': {
      primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 500, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 500, temperature: 0.1 },
      ],
    },
    'roundtable.team_commander': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.judge': {
      primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 600, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 600, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 300, temperature: 0.1 },
      fallbacks: [],
    },
  },
  claude: {
    dexter: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 300, temperature: 0.1 },
      ],
    },
    archer: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.2 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 4096, temperature: 0.3 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4096, temperature: 0.2 },
      ],
    },
    lead: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 300, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 300, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  blog: {
    'pos.writer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.82 },
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 12000, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 8000, temperature: 0.72 },
      ],
    },
    'gems.writer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.85 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 8000, temperature: 0.75 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'social.summarize': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'social.caption': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.summarize': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.caption': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'curriculum.recommend': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2000, temperature: 0.7 },
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 2000, temperature: 0.7 },
      ],
    },
    'curriculum.generate': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 8000, temperature: 0.5 },
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 8000, temperature: 0.5 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4000, temperature: 0.5 },
      ],
    },
    'feedback.analyze': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 700, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 700, temperature: 0.1 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 700, temperature: 0.1 },
      ],
    },
    'commenter.reply': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 600, temperature: 0.65, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 600, temperature: 0.5, timeoutMs: 12000 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 600, temperature: 0.75, timeoutMs: 12000 },
      ],
    },
    'commenter.neighbor': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 700, temperature: 0.7, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 700, temperature: 0.55, timeoutMs: 12000 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 700, temperature: 0.8, timeoutMs: 15000 },
      ],
    },
    'book_review.preview': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  core: {
    'chunked.gpt4o': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    'chunked.default': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 4096, temperature: 0.75 },
      ],
    },
  },
  ska: {
    'parsing.level3': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 2000, temperature: 0.1, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2000, temperature: 0.1, timeoutMs: 15000 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 2000, temperature: 0.1, timeoutMs: 10000 },
      ],
    },
    'selector.generate': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 1000, temperature: 0.1, timeoutMs: 10000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1000, temperature: 0.1, timeoutMs: 10000 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1000, temperature: 0.1, timeoutMs: 8000 },
      ],
    },
    classify: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 500, temperature: 0, timeoutMs: 8000 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 500, temperature: 0, timeoutMs: 6000 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 500, temperature: 0, timeoutMs: 8000 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1000, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1000, temperature: 0.1 },
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
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 200, temperature: 0 },
        { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 200, temperature: 0 },
      ],
    },
    'alarm.interpreter.work': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 200, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 200, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.report': {
      primary: { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 300, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.error': {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 400, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 400, temperature: 0.1 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 400, temperature: 0.1 },
      ],
    },
    'alarm.interpreter.critical': {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 400, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 400, temperature: 0.1 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 400, temperature: 0.1 },
      ],
    },
    'roundtable.jay': {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 500, temperature: 0.2 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.claude_lead': {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 500, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 500, temperature: 0.1 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 500, temperature: 0.1 },
      ],
    },
    'roundtable.team_commander': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 500, temperature: 0.2 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 500, temperature: 0.2 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 500, temperature: 0.2 },
      ],
    },
    'roundtable.judge': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 600, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 600, temperature: 0.1 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 600, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 300, temperature: 0.1 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 300, temperature: 0.1 },
      ],
    },
  },
  claude: {
    dexter: {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1500, temperature: 0.2 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1500, temperature: 0.2 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1500, temperature: 0.2 },
      ],
    },
    archer: {
      primary: { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 800, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 800, temperature: 0.1 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 800, temperature: 0.1 },
      ],
    },
    lead: {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1500, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1500, temperature: 0.1 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 1500, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 2000, temperature: 0.2 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2000, temperature: 0.2 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2000, temperature: 0.2 },
      ],
    },
  },
  blog: {
    'book_review.preview': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 2600, temperature: 0.7, timeoutMs: 45_000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2600, temperature: 0.7, timeoutMs: 25_000 },
        { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25_000 },
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
    reviewer: null,
    guardian: null,
    builder: null,
    'quality-report': null,
    dexter: 'claude.dexter.ai_analyst',
    archer: 'claude.archer.tech_analysis',
    lead: 'claude.lead.system_issue_triage',
    commander: null,
  },
  blog: {
    blo: null,
    richer: null,
    pos: 'blog.pos.writer',
    gems: 'blog.gems.writer',
    publ: null,
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
    default: 'investment.agent_policy',
    luna: 'investment.agent_policy',
    analyst: 'investment.agent_policy',
    validator: 'investment.agent_policy',
    commander: 'investment.agent_policy',
    nemesis: 'investment.agent_policy',
    oracle: 'investment.agent_policy',
    hermes: 'investment.agent_policy',
    sophia: 'investment.agent_policy',
    zeus: 'investment.agent_policy',
    athena: 'investment.agent_policy',
    argos: 'investment.agent_policy',
    scout: 'investment.agent_policy',
    chronos: 'investment.agent_policy',
    aria: 'investment.agent_policy',
    'adaptive-risk': 'investment.agent_policy',
    sentinel: 'investment.agent_policy',
    hephaestos: 'investment.agent_policy',
    hanul: 'investment.agent_policy',
    budget: 'investment.agent_policy',
    kairos: 'investment.agent_policy',
    'stock-flow': 'investment.agent_policy',
    sweeper: 'investment.agent_policy',
  },
  investment: {
    luna: 'investment.agent_policy',
    nemesis: 'investment.agent_policy',
    oracle: 'investment.agent_policy',
    hermes: 'investment.agent_policy',
    sophia: 'investment.agent_policy',
    zeus: 'investment.agent_policy',
    athena: 'investment.agent_policy',
    argos: 'investment.agent_policy',
    scout: 'investment.agent_policy',
    chronos: 'investment.agent_policy',
    aria: 'investment.agent_policy',
    'adaptive-risk': 'investment.agent_policy',
    sentinel: 'investment.agent_policy',
    hephaestos: 'investment.agent_policy',
    hanul: 'investment.agent_policy',
    budget: 'investment.agent_policy',
    kairos: 'investment.agent_policy',
    'stock-flow': 'investment.agent_policy',
    sweeper: 'investment.agent_policy',
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

function routeEntryFromAbstractRoute(route: string, selectorVersion: TeamSelectorVersion = TEAM_SELECTOR_VERSION_LEGACY): LLMChainEntry {
  const normalized = String(route || 'anthropic_haiku');
  if (normalized.includes('opus')) {
    return { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 2048, temperature: 0.1 };
  }
  if (normalized.includes('sonnet')) {
    if (selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4) {
      return { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 2048, temperature: 0.1 };
    }
    return { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2048, temperature: 0.1 };
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

    'claude._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude._default', options),
    'claude.archer.tech_analysis': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.archer.tech_analysis', options),
    'claude.lead.system_issue_triage': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.lead.system_issue_triage', options),
    'claude.dexter.ai_analyst': (options: SelectorOptions = {}) => resolveFromTeamDefault('claude.dexter.ai_analyst', options),

    'orchestrator.jay.intent': ({ intentPrimary, intentFallback }: SelectorOptions = {}) => ({
      primary: { provider: 'openai-oauth', model: intentPrimary || 'gpt-5.4-mini' },
      fallback: {
        provider: 'gemini-cli-oauth',
        model: intentFallback
          ? (intentFallback.startsWith('gemini-cli-oauth/')
              ? intentFallback
              : `gemini-cli-oauth/${intentFallback.replace(/^google-gemini-cli\//, '').replace(/^gemini-oauth\//, '').replace(/^gemini\//, '')}`)
          : GEMINI_CLI_FLASH_MODEL,
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
      { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens, temperature: 0.2, timeoutMs: 12_000 },
      { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens, temperature: 0.2, timeoutMs: 30_000 },
      { provider: 'claude-code', model: 'claude-code/haiku', maxTokens, temperature: 0.2, timeoutMs: 15_000 },
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
      { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens, temperature: 0.2, timeoutMs: 15_000 },
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

    'ska._default': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska._default', options),
    'ska.parsing.level3': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska.parsing.level3', options),
    'ska.selector.generate': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska.selector.generate', options),
    'ska.classify': (options: SelectorOptions = {}) => resolveFromTeamDefault('ska.classify', options),

    'sigma.agent_policy': (options: SelectorOptions = {}) => {
      const { agentName } = options;
      const SIGMA_ROUTES: Record<string, { route: string; fallback: string[] }> = {
        commander:                  { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'pod.risk':                 { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'pod.growth':               { route: 'anthropic_haiku', fallback: [] },
        'pod.trend':                { route: 'anthropic_haiku', fallback: [] },
        'skill.data_quality':       { route: 'anthropic_haiku', fallback: [] },
        'skill.causal':             { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'skill.experiment_design':  { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'skill.feature_planner':    { route: 'anthropic_haiku', fallback: [] },
        'skill.observability':      { route: 'anthropic_haiku', fallback: [] },
        'principle.self_critique':  { route: 'anthropic_opus', fallback: ['anthropic_sonnet'] },
        reflexion:                  { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        espl:                       { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
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
        'darwin.scanner':              { route: 'anthropic_haiku', fallback: ['anthropic_sonnet'] },
        'darwin.evaluator':            { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.planner':              { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.edison':               { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.verifier':             { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.commander':            { route: 'anthropic_opus', fallback: ['anthropic_sonnet'] },
        'darwin.reflexion':            { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'darwin.espl':                 { route: 'anthropic_haiku', fallback: ['anthropic_sonnet'] },
        'darwin.self_rag':             { route: 'anthropic_haiku', fallback: [] },
        'darwin.self_rewarding_judge': { route: 'anthropic_haiku', fallback: ['anthropic_sonnet'] },
        'darwin.rag.query_planner':    { route: 'anthropic_haiku', fallback: [] },
        'darwin.rag.synthesizer':      { route: 'anthropic_haiku', fallback: ['anthropic_sonnet'] },
        commander:                     { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        evaluator:                     { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        planner:                       { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        implementor:                   { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        verifier:                      { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        applier:                       { route: 'anthropic_haiku', fallback: [] },
        learner:                       { route: 'anthropic_haiku', fallback: [] },
        scanner:                       { route: 'anthropic_haiku', fallback: [] },
        reflexion:                     { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'self_rag.retrieve':           { route: 'anthropic_haiku', fallback: [] },
        'self_rag.relevance':          { route: 'anthropic_haiku', fallback: [] },
        'espl.crossover':              { route: 'anthropic_sonnet', fallback: ['anthropic_haiku'] },
        'espl.mutation':               { route: 'anthropic_haiku', fallback: [] },
        'principle.critique':          { route: 'anthropic_opus', fallback: ['anthropic_sonnet'] },
      };
      const key = String(agentName || 'commander');
      const entry = DARWIN_ROUTES[key] || { route: 'anthropic_haiku', fallback: [] };
      const selectorVersion = resolveSelectorVersionForKey('darwin.agent_policy', options);
      return buildAbstractRoutePolicy(entry.route, entry.fallback, selectorVersion);
    },

    'investment.agent_policy': (options: SelectorOptions = {}) => {
      const { agentName, agentModel = null, openaiPerfModel = 'gpt-5.4', policyOverride } = options;
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
      };
      const defaultRoutesOauth4: Record<string, string> = {
        default: 'claude_sonnet',
        luna: 'claude_sonnet',
        nemesis: 'claude_haiku',
        oracle: 'groq_scout',
        hermes: 'gemini_flash_lite',
        sophia: 'openai_mini',
        zeus: 'claude_opus',
        athena: 'claude_sonnet',
        argos: 'openai_mini',
        scout: 'gemini_flash',
        chronos: 'openai_perf',
        aria: 'gemini_flash',
        'adaptive-risk': 'claude_sonnet',
        sentinel: 'openai_mini',
        hephaestos: 'claude_sonnet',
        hanul: 'claude_opus',
        budget: 'openai_mini',
        kairos: 'claude_sonnet',
        'stock-flow': 'groq_with_local',
        sweeper: 'gemini_flash_lite',
      };

      const selectorVersion = resolveSelectorVersionForKey('investment.agent_policy', options);
      const defaultRoutes = selectorVersion === TEAM_SELECTOR_VERSION_OAUTH4 ? defaultRoutesOauth4 : defaultRoutesLegacy;
      const configuredRoutes = isObject(policyOverride?.agentRoutes) ? { ...defaultRoutes, ...policyOverride.agentRoutes } : defaultRoutes;
      const openaiMiniModel = policyOverride?.openaiMiniModel || 'gpt-4o-mini';
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
        openai_perf: [
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        dual_groq: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'groq', model: groqCompetitionModels[1] || groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        openai_mini: [
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        local_primary: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
        ],
        groq_scout: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        local_fast: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
        ],
        local_deep: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b', maxTokens: 2048, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 2048, temperature: 0.1 },
        ],
        groq_with_local: [
          { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 2048, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 2048, temperature: 0.1 },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 2048, temperature: 0.1 },
        ],
        claude_sonnet: [
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1500, temperature: 0.2 },
          { provider: 'openai-oauth', model: openaiPerfModel, maxTokens: 1500, temperature: 0.2 },
          { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 1500, temperature: 0.2 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1500, temperature: 0.2 },
        ],
        claude_haiku: [
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 800, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 800, temperature: 0.1 },
          { provider: 'groq', model: groqScoutModel, maxTokens: 800, temperature: 0.1 },
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_LITE_MODEL, maxTokens: 800, temperature: 0.1 },
        ],
        claude_opus: [
          { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 1500, temperature: 0.1 },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1500, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiPerfModel, maxTokens: 1500, temperature: 0.1 },
          { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 1500, temperature: 0.1 },
        ],
        gemini_flash: [
          { provider: 'gemini-cli-oauth', model: GEMINI_CLI_FLASH_MODEL, maxTokens: 1000, temperature: 0.1 },
          { provider: 'claude-code', model: 'claude-code/haiku', maxTokens: 1000, temperature: 0.1 },
          { provider: 'groq', model: 'llama-3.3-70b-versatile', maxTokens: 1000, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 1000, temperature: 0.1 },
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
  return normalizedChain;
}

export function describeLLMSelector(key: string, options: SelectorOptions = {}): any {
  const resolved = selectLLMPolicy(key, options);
  if (resolved?.enabled === false) {
    return { key, kind: 'none', primary: null, fallbacks: [], chain: [], enabled: false };
  }
  const chain = normalizeChainFromPolicy(resolved);
  if (chain) {
    return { key, kind: 'chain', primary: chain[0] || null, fallbacks: chain.slice(1), chain };
  }
  return { key, kind: 'policy', policy: resolved };
}

export function listLLMSelectorKeys(): string[] {
  return Object.keys(SELECTOR_REGISTRY).sort();
}

export function listAgentModelTargets(team: string | null = null): Array<{ team: string; agent: string; selectorKey: string | null; selected: boolean }> {
  const teams = team ? { [team]: AGENT_MODEL_REGISTRY[team] || {} } : AGENT_MODEL_REGISTRY;
  const entries: Array<{ team: string; agent: string; selectorKey: string | null; selected: boolean }> = [];
  for (const [teamName, agents] of Object.entries(teams)) {
    for (const [agentName, selectorKey] of Object.entries(agents || {})) {
      entries.push({
        team: teamName,
        agent: agentName,
        selectorKey: selectorKey || null,
        selected: Boolean(selectorKey),
      });
    }
  }
  return entries.sort((a, b) => `${a.team}.${a.agent}`.localeCompare(`${b.team}.${b.agent}`));
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
