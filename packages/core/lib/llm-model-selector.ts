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
  [key: string]: any;
};

const GEMINI_OAUTH_FLASH_MODEL = 'gemini-oauth/gemini-2.5-flash';

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
  if (preferredApi === 'claude-code') return { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens, temperature: 0.1 };
  if (preferredApi === 'anthropic') return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 };
  if (preferredApi === 'openai') return { provider: 'openai', model: 'gpt-4o-mini', maxTokens, temperature: 0.1 };
  if (preferredApi === 'gemini' || preferredApi === 'gemini-oauth') return { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens, temperature: 0.1 };
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

const TEAM_SELECTOR_DEFAULTS: Record<string, any> = {
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
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 4096, temperature: 0.2 },
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
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 16000, temperature: 0.82 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.82 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'gems.writer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.85 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 16000, temperature: 0.85 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 12000, temperature: 0.75 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'social.summarize': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
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
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 8000, temperature: 0.5 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 8000, temperature: 0.5 },
      ],
    },
    'feedback.analyze': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 700, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 700, temperature: 0.1 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 700, temperature: 0.1 },
      ],
    },
    'commenter.reply': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 600, temperature: 0.65, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 600, temperature: 0.5, timeoutMs: 12000 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 600, temperature: 0.75, timeoutMs: 12000 },
      ],
    },
    'commenter.neighbor': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 700, temperature: 0.7, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 700, temperature: 0.55, timeoutMs: 12000 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 700, temperature: 0.8, timeoutMs: 15000 },
      ],
    },
    'book_review.preview': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 2600, temperature: 0.7, timeoutMs: 25000 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  worker: {
    'chat.task_intake': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 250, temperature: 0.1 },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 250, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 250, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 1024, temperature: 0.1 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  core: {
    'chunked.gpt4o': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    'chunked.default': {
      primary: { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.75 },
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 4096, temperature: 0.75 },
      ],
    },
  },
  video: {
    'step-proposal': {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 180, temperature: 0.1 },
      fallbacks: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 180, temperature: 0.1 }],
    },
    critic: {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 512, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 512, temperature: 0.1 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 512, temperature: 0.1 },
      ],
    },
    'subtitle-correction': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 4096, temperature: 0.1 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 4096, temperature: 0.1 },
      ],
    },
    'scene-indexer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2048, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 2048, temperature: 0.1 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 2048, temperature: 0.1 },
      ],
    },
    'narration-analyzer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 4096, temperature: 0.1 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 4096, temperature: 0.1 },
      ],
    },
    refiner: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'intro-outro': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.2 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.2 },
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 1024, temperature: 0.2 },
      ],
    },
    _fallback: {
      primary: { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [],
    },
  },
  ska: {
    'parsing.level3': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 2000, temperature: 0.1, timeoutMs: 15000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 2000, temperature: 0.1, timeoutMs: 15000 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 2000, temperature: 0.1, timeoutMs: 10000 },
      ],
    },
    'selector.generate': {
      primary: { provider: 'claude-code', model: 'claude-code/opus', maxTokens: 1000, temperature: 0.1, timeoutMs: 10000 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1000, temperature: 0.1, timeoutMs: 10000 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1000, temperature: 0.1, timeoutMs: 8000 },
      ],
    },
    classify: {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 500, temperature: 0, timeoutMs: 8000 },
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 500, temperature: 0, timeoutMs: 6000 },
        { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 500, temperature: 0, timeoutMs: 8000 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 1000, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1000, temperature: 0.1 },
        { provider: 'groq', model: 'llama-3.1-8b-instant', maxTokens: 1000, temperature: 0.1 },
      ],
    },
  },
};

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
  worker: {
    foreman: null,
    web: null,
    nextjs: null,
    'task-runner': null,
    'task-intake': 'worker.chat.task_intake',
    'ai-fallback': 'worker.ai.fallback',
  },
  core: {
    'chunked-gpt4o': 'core.chunked.gpt4o',
    'chunked-default': 'core.chunked.default',
  },
  video: {
    edi: 'video.step-proposal',
    critic: 'video.critic',
    'subtitle-corrector': 'video.subtitle-correction',
    'scene-indexer': 'video.scene-indexer',
    'narration-analyzer': 'video.narration-analyzer',
    refiner: 'video.refiner',
    'intro-outro-handler': 'video.intro-outro',
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
  },
  ska: {
    'parsing-guard': 'ska.parsing.level3',
    'selector-generator': 'ska.selector.generate',
    'error-classifier': 'ska.classify',
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

function resolveFromTeamDefault(selectorKey: string): any {
  const parts = String(selectorKey || '').split('.');
  const team = parts[0];
  const restKey = parts.slice(1).join('.');
  const shortKey = parts[1] || '';
  const teamDefaults = TEAM_SELECTOR_DEFAULTS[team];
  if (!teamDefaults) return null;
  if (restKey === '_default') return normalizeTeamDefaultEntry(teamDefaults._fallback || null);
  return normalizeTeamDefaultEntry(teamDefaults[restKey] || teamDefaults[shortKey] || teamDefaults._fallback || null);
}

function buildSelectorRegistry(): Record<string, any> {
  return {
    'claude._default': () => resolveFromTeamDefault('claude._default'),
    'claude.archer.tech_analysis': () => resolveFromTeamDefault('claude.archer.tech_analysis'),
    'claude.lead.system_issue_triage': () => resolveFromTeamDefault('claude.lead.system_issue_triage'),
    'claude.dexter.ai_analyst': () => resolveFromTeamDefault('claude.dexter.ai_analyst'),

    'orchestrator.jay.intent': ({ intentPrimary, intentFallback }: SelectorOptions = {}) => ({
      primary: { provider: 'openai-oauth', model: intentPrimary || 'gpt-5-mini' },
      fallback: {
        provider: 'gemini-oauth',
        model: intentFallback
          ? (intentFallback.startsWith('gemini-oauth/')
              ? intentFallback
              : `gemini-oauth/${intentFallback.replace(/^google-gemini-cli\//, '').replace(/^gemini\//, '')}`)
          : GEMINI_OAUTH_FLASH_MODEL,
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
        { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 300, temperature: 0.7 },
      ];
    },

    'worker.ai.fallback': ({
      groqModel = 'llama-3.1-8b-instant',
      preferredApi = 'groq',
      configuredProviders = ['groq', 'claude-code', 'anthropic', 'gemini-oauth', 'openai'],
      maxTokens = 1024,
      policyOverride = null,
    }: SelectorOptions = {}) => {
      const configured = new Set(sanitizeConfiguredProviders(preferredApi, configuredProviders));
      const providerModels = {
        groq: stripGroqPrefix(policyOverride?.providerModels?.groq || groqModel),
        'claude-code': policyOverride?.providerModels?.['claude-code'] || 'claude-code/sonnet',
        anthropic: policyOverride?.providerModels?.anthropic || 'claude-haiku-4-5-20251001',
        'gemini-oauth': policyOverride?.providerModels?.['gemini-oauth'] || policyOverride?.providerModels?.gemini || GEMINI_OAUTH_FLASH_MODEL,
        openai: policyOverride?.providerModels?.openai || 'gpt-4o-mini',
      };
      const primary = resolvePreferredProvider(preferredApi, providerModels.groq, maxTokens);
      if (preferredApi === 'claude-code') primary.model = providerModels['claude-code'];
      if (preferredApi === 'anthropic') primary.model = providerModels.anthropic;
      if (preferredApi === 'openai') primary.model = providerModels.openai;
      if (preferredApi === 'gemini' || preferredApi === 'gemini-oauth') primary.model = providerModels['gemini-oauth'];
      const fallback = [
        { provider: 'groq', model: `groq/${providerModels.groq}`, maxTokens, temperature: 0.1 },
        { provider: 'claude-code', model: providerModels['claude-code'], maxTokens, temperature: 0.1 },
        { provider: 'anthropic', model: providerModels.anthropic, maxTokens, temperature: 0.1 },
        { provider: 'gemini-oauth', model: providerModels['gemini-oauth'], maxTokens, temperature: 0.1 },
        { provider: 'openai', model: providerModels.openai, maxTokens, temperature: 0.1 },
      ].filter((entry) => configured.has(entry.provider));
      const chain = configured.has(primary.provider) ? [primary, ...fallback] : fallback;
      return dedupeByProvider(chain);
    },

    'worker._default': () => resolveFromTeamDefault('worker._default'),
    'worker.chat.task_intake': () => resolveFromTeamDefault('worker.chat.task_intake'),

    'blog._default': () => resolveFromTeamDefault('blog._default'),
    'blog.pos.writer': () => resolveFromTeamDefault('blog.pos.writer'),
    'blog.gems.writer': () => resolveFromTeamDefault('blog.gems.writer'),
    'blog.social.summarize': () => resolveFromTeamDefault('blog.social.summarize'),
    'blog.social.caption': () => resolveFromTeamDefault('blog.social.caption'),
    'blog.star.summarize': () => resolveFromTeamDefault('blog.star.summarize'),
    'blog.star.caption': () => resolveFromTeamDefault('blog.star.caption'),
    'blog.curriculum.recommend': () => resolveFromTeamDefault('blog.curriculum.recommend'),
    'blog.curriculum.generate': () => resolveFromTeamDefault('blog.curriculum.generate'),
    'blog.feedback.analyze': () => resolveFromTeamDefault('blog.feedback.analyze'),
    'blog.commenter.reply': () => resolveFromTeamDefault('blog.commenter.reply'),
    'blog.commenter.neighbor': () => resolveFromTeamDefault('blog.commenter.neighbor'),
    'blog.book_review.preview': () => resolveFromTeamDefault('blog.book_review.preview'),


    'core._default': () => resolveFromTeamDefault('core._default'),
    'core.chunked.gpt4o': () => resolveFromTeamDefault('core.chunked.gpt4o'),
    'core.chunked.default': () => resolveFromTeamDefault('core.chunked.default'),

    'video._default': () => resolveFromTeamDefault('video._default'),
    'video.step-proposal': () => resolveFromTeamDefault('video.step-proposal'),
    'video.critic': () => resolveFromTeamDefault('video.critic'),
    'video.subtitle-correction': () => resolveFromTeamDefault('video.subtitle-correction'),
    'video.scene-indexer': () => resolveFromTeamDefault('video.scene-indexer'),
    'video.narration-analyzer': () => resolveFromTeamDefault('video.narration-analyzer'),
    'video.refiner': () => resolveFromTeamDefault('video.refiner'),
    'video.intro-outro': () => resolveFromTeamDefault('video.intro-outro'),

    'ska._default': () => resolveFromTeamDefault('ska._default'),
    'ska.parsing.level3': () => resolveFromTeamDefault('ska.parsing.level3'),
    'ska.selector.generate': () => resolveFromTeamDefault('ska.selector.generate'),
    'ska.classify': () => resolveFromTeamDefault('ska.classify'),

    'sigma.agent_policy': ({ agentName }: SelectorOptions = {}) => {
      const SIGMA_ROUTES: Record<string, { route: string; chain: LLMChainEntry[] }> = {
        commander:                  { route: 'anthropic_sonnet', chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'pod.risk':                 { route: 'anthropic_sonnet', chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'pod.growth':               { route: 'anthropic_haiku',  chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'pod.trend':                { route: 'anthropic_haiku',  chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'skill.data_quality':       { route: 'anthropic_haiku',  chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'skill.causal':             { route: 'anthropic_sonnet', chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'skill.experiment_design':  { route: 'anthropic_sonnet', chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'skill.feature_planner':    { route: 'anthropic_haiku',  chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'skill.observability':      { route: 'anthropic_haiku',  chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        'principle.self_critique':  { route: 'anthropic_opus',   chain: [{ provider: 'anthropic', model: 'claude-opus-4-7' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }] },
        reflexion:                  { route: 'anthropic_sonnet', chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
        espl:                       { route: 'anthropic_sonnet', chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] },
      };
      const key = String(agentName || 'commander');
      const entry = SIGMA_ROUTES[key] || { route: 'anthropic_haiku', chain: [{ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }] };
      return {
        route: entry.route,
        primary: entry.chain[0] || null,
        fallbacks: entry.chain.slice(1),
        fallbackChain: entry.chain,
      };
    },

    'investment.agent_policy': ({ agentName, agentModel = null, openaiPerfModel = 'gpt-5.4', policyOverride }: SelectorOptions = {}) => {
      const normalizedAgentName = String(agentName || '');
      const defaultRoutes: Record<string, string> = {
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
      };
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
      const route = normalizedAgentName === 'argos'
        ? (configuredRoute || modelDerivedRoute || 'groq_scout')
        : (modelDerivedRoute || configuredRoute || 'groq_scout');
      const routeChains: Record<string, LLMChainEntry[]> = {
        openai_perf: [
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        dual_groq: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'groq', model: groqCompetitionModels[1] || groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        openai_mini: [
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        local_primary: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
        ],
        groq_scout: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 1024, temperature: 0.1 },
          { provider: 'gemini-oauth', model: GEMINI_OAUTH_FLASH_MODEL, maxTokens: 1024, temperature: 0.1 },
        ],
        local_fast: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
        ],
        local_deep: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b', maxTokens: 2048, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 2048, temperature: 0.1 },
        ],
        groq_with_local: [
          { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 2048, temperature: 0.1 },
          { provider: 'openai-oauth', model: openaiMiniModel, maxTokens: 2048, temperature: 0.1 },
          { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 2048, temperature: 0.1 },
        ],
      };
      return {
        route,
        openaiPerfModel,
        openaiMiniModel,
        groqScoutModel,
        groqCompetitionModels,
        anthropicModel,
        primary: routeChains[route][0] || null,
        fallbacks: routeChains[route].slice(1),
        fallbackChain: routeChains[route],
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
