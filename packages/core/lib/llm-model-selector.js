'use strict';

/**
 * packages/core/lib/llm-model-selector.js
 *
 * 목적:
 * - 현재 시스템에 흩어진 LLM 모델/폴백 체인을 한 곳에서 관리
 * - 팀별·봇별·작업유형별 기본 체인을 selector key로 조회
 * - 각 팀의 개별 정책은 유지하되, 모델 선택만 공용 레이어로 표준화
 *
 * 설계 원칙:
 * - 지금 당장 필요한 구조: "한 곳에서 관리되는 기본 모델/폴백 레지스트리"
 * - 나중에 확장할 구조: runtime_config / workspace / tenant별 정책 주입
 */

function _clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function _isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function _deepMerge(base, override) {
  if (!_isObject(base) || !_isObject(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = _isObject(value) && _isObject(base[key])
      ? _deepMerge(base[key], value)
      : _clone(value);
  }
  return merged;
}

function inferProviderFromModel(model = '') {
  if (!model) return 'anthropic';
  if (model.startsWith('claude-code/')) return 'claude-code';
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
  if (model.startsWith('gemini-') || model.startsWith('google-gemini-cli/')) return 'gemini';
  return 'anthropic';
}

function buildSingleChain(model, maxTokens = 1024, temperature = 0.1) {
  return [{
    provider: inferProviderFromModel(model),
    model,
    maxTokens,
    temperature,
  }];
}

function _applyChainOverrides(chain, options = {}) {
  const maxTokens = Number.isFinite(Number(options.maxTokens)) ? Number(options.maxTokens) : null;
  const temperature = Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : null;
  return chain.map((entry) => ({
    ...entry,
    maxTokens: maxTokens ?? entry.maxTokens,
    temperature: temperature ?? entry.temperature,
  }));
}

function _applyPolicyOverride(resolved, policyOverride, options = {}) {
  if (!policyOverride) return Array.isArray(resolved) ? _applyChainOverrides(resolved, options) : resolved;
  if (Array.isArray(resolved)) {
    if (Array.isArray(policyOverride)) return _applyChainOverrides(_clone(policyOverride), options);
    if (Array.isArray(policyOverride.chain)) return _applyChainOverrides(_clone(policyOverride.chain), options);
    return _applyChainOverrides(resolved, options);
  }
  if (_isObject(resolved) && _isObject(policyOverride)) {
    return _deepMerge(resolved, policyOverride);
  }
  return policyOverride;
}

function _resolvePreferredProvider(preferredApi, groqModel, maxTokens) {
  if (preferredApi === 'claude-code') {
    return { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens, temperature: 0.1 };
  }
  if (preferredApi === 'anthropic') {
    return { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 };
  }
  if (preferredApi === 'openai') {
    return { provider: 'openai', model: 'gpt-4o-mini', maxTokens, temperature: 0.1 };
  }
  if (preferredApi === 'gemini') {
    return { provider: 'gemini', model: 'gemini-2.5-flash', maxTokens, temperature: 0.1 };
  }
  return { provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 };
}

function _buildRouteFromAgentModel(agentModel, {
  openaiPerfModel = 'gpt-5.4',
  openaiMiniModel = 'gpt-4o-mini',
  groqScoutModel = 'meta-llama/llama-4-scout-17b-16e-instruct',
  groqCompetitionModels = ['openai/gpt-oss-20b', 'meta-llama/llama-4-scout-17b-16e-instruct'],
} = {}) {
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
  if (normalized.startsWith('gemini/')) return 'openai_mini';
  if (normalized.startsWith('google-gemini-cli/')) return 'openai_mini';
  if (normalized === openaiPerfModel) return 'openai_perf';
  if (normalized === openaiMiniModel) return 'openai_mini';
  if (normalized === groqScoutModel) return 'groq_scout';
  if (groqCompetitionModels.includes(normalized)) return 'dual_groq';
  return null;
}

function _sanitizeConfiguredProviders(preferredApi, configuredProviders = []) {
  const list = Array.isArray(configuredProviders) ? configuredProviders.slice() : [];
  if (preferredApi === 'claude-code') {
    return list.filter((provider) => provider !== 'anthropic');
  }
  return list;
}

function _stripGroqPrefix(model = '') {
  return model.startsWith('groq/') ? model.slice(5) : model;
}

function _dedupeByProvider(chain) {
  return chain.filter((entry, index, array) =>
    array.findIndex((candidate) => candidate.provider === entry.provider) === index
  );
}

const TEAM_SELECTOR_DEFAULTS = {
  claude: {
    dexter: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 300, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 300, temperature: 0.1 },
      ],
    },
    archer: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.2 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 4096, temperature: 0.2 },
        { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 4096, temperature: 0.3 },
      ],
    },
    lead: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 300, temperature: 0.1 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 300, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 300, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  blog: {
    'pos.writer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.82 },
      fallbacks: [
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'gems.writer': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 16000, temperature: 0.85 },
      fallbacks: [
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
        { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 12000, temperature: 0.75 },
      ],
    },
    'social.summarize': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'social.caption': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.summarize': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
      ],
    },
    'star.caption': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
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
      ],
    },
    _fallback: {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  worker: {
    'chat.task_intake': {
      primary: { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 250, temperature: 0.1 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 250, temperature: 0.1 },
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 250, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 1024, temperature: 0.1 },
      ],
    },
  },
  core: {
    'chunked.gpt4o': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 4096, temperature: 0.75 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    'chunked.default': {
      primary: { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.75 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 4096, temperature: 0.75 },
      ],
    },
    _fallback: {
      primary: { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 4096, temperature: 0.75 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 4096, temperature: 0.75 },
      ],
    },
  },
  video: {
    'step-proposal': {
      primary: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 180, temperature: 0.1 },
      fallbacks: [
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 180, temperature: 0.1 },
      ],
    },
    critic: {
      primary: { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 512, temperature: 0.1 },
      fallbacks: [
        { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 512, temperature: 0.1 },
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 512, temperature: 0.1 },
      ],
    },
    'subtitle-correction': {
      primary: { provider: 'openai-oauth', model: 'gpt-5.4', maxTokens: 4096, temperature: 0.1 },
      fallbacks: [
        { provider: 'claude-code', model: 'claude-code/sonnet', maxTokens: 4096, temperature: 0.1 },
        { provider: 'local', model: 'qwen2.5-7b', maxTokens: 4096, temperature: 0.1 },
      ],
    },
    _fallback: {
      primary: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
      fallbacks: [],
    },
  },
};

const AGENT_MODEL_REGISTRY = {
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
  },
  worker: {
    lead: null,
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
  },
};

function _normalizeTeamDefaultEntry(entry) {
  if (_isObject(entry) && entry.enabled === false) {
    return {
      enabled: false,
      primary: null,
      fallbacks: [],
      chain: [],
    };
  }
  if (!_isObject(entry) || !_isObject(entry.primary)) return null;
  return {
    enabled: true,
    primary: _clone(entry.primary),
    fallbacks: Array.isArray(entry.fallbacks) ? _clone(entry.fallbacks) : [],
    chain: [_clone(entry.primary), ...(Array.isArray(entry.fallbacks) ? _clone(entry.fallbacks) : [])],
  };
}

function _resolveFromTeamDefault(selectorKey) {
  const parts = String(selectorKey || '').split('.');
  const team = parts[0];
  const restKey = parts.slice(1).join('.');
  const shortKey = parts[1] || '';
  const teamDefaults = TEAM_SELECTOR_DEFAULTS[team];
  if (!teamDefaults) return null;

  if (restKey === '_default') {
    return _normalizeTeamDefaultEntry(teamDefaults._fallback || null);
  }

  return _normalizeTeamDefaultEntry(
    teamDefaults[restKey]
    || teamDefaults[shortKey]
    || teamDefaults._fallback
    || null
  );
}

function _buildSelectorRegistry() {
  return {
    'claude._default': () => _resolveFromTeamDefault('claude._default'),
    'claude.archer.tech_analysis': () => _resolveFromTeamDefault('claude.archer.tech_analysis'),
    'claude.lead.system_issue_triage': () => _resolveFromTeamDefault('claude.lead.system_issue_triage'),
    'claude.dexter.ai_analyst': () => _resolveFromTeamDefault('claude.dexter.ai_analyst'),

    'orchestrator.jay.intent': ({ intentPrimary, intentFallback } = {}) => ({
      primary: {
        provider: 'openai-oauth',
        model: intentPrimary || 'gpt-5-mini',
      },
      fallback: {
        provider: 'google',
        model: intentFallback || 'gemini-2.5-flash',
      },
    }),

    'orchestrator.jay.chat_fallback': ({ chatFallbackChain } = {}) => {
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
        { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 300, temperature: 0.7 },
      ];
    },

    'worker.ai.fallback': ({
      groqModel = 'llama-4-scout-17b-16e-instruct',
      preferredApi = 'groq',
      configuredProviders = ['groq', 'local', 'claude-code', 'anthropic', 'gemini', 'openai'],
      maxTokens = 1024,
      policyOverride = null,
    } = {}) => {
      const configured = new Set(_sanitizeConfiguredProviders(preferredApi, configuredProviders));
      const providerModels = {
        groq: _stripGroqPrefix(policyOverride?.providerModels?.groq || groqModel),
        local: policyOverride?.providerModels?.local || 'qwen2.5-7b',
        'claude-code': policyOverride?.providerModels?.['claude-code'] || 'claude-code/sonnet',
        anthropic: policyOverride?.providerModels?.anthropic || 'claude-haiku-4-5-20251001',
        gemini: policyOverride?.providerModels?.gemini || 'gemini-2.5-flash',
        openai: policyOverride?.providerModels?.openai || 'gpt-4o-mini',
      };
      const primary = _resolvePreferredProvider(preferredApi, providerModels.groq, maxTokens);
      if (preferredApi === 'local') primary.provider = 'local';
      if (preferredApi === 'local') primary.model = providerModels.local;
      if (preferredApi === 'claude-code') primary.model = providerModels['claude-code'];
      if (preferredApi === 'anthropic') primary.model = providerModels.anthropic;
      if (preferredApi === 'openai') primary.model = providerModels.openai;
      if (preferredApi === 'gemini') primary.model = providerModels.gemini;
      const fallback = [
        { provider: 'groq', model: `groq/${providerModels.groq}`, maxTokens, temperature: 0.1 },
        { provider: 'local', model: providerModels.local, maxTokens, temperature: 0.1 },
        { provider: 'claude-code', model: providerModels['claude-code'], maxTokens, temperature: 0.1 },
        { provider: 'anthropic', model: providerModels.anthropic, maxTokens, temperature: 0.1 },
        { provider: 'gemini', model: providerModels.gemini, maxTokens, temperature: 0.1 },
        { provider: 'openai', model: providerModels.openai, maxTokens, temperature: 0.1 },
      ].filter((entry) => configured.has(entry.provider));
      const chain = configured.has(primary.provider) ? [primary, ...fallback] : fallback;
      return _dedupeByProvider(chain);
    },

    'worker._default': () => _resolveFromTeamDefault('worker._default'),
    'worker.chat.task_intake': () => _resolveFromTeamDefault('worker.chat.task_intake'),

    'blog._default': () => _resolveFromTeamDefault('blog._default'),
    'blog.pos.writer': () => _resolveFromTeamDefault('blog.pos.writer'),
    'blog.gems.writer': () => _resolveFromTeamDefault('blog.gems.writer'),
    'blog.social.summarize': () => _resolveFromTeamDefault('blog.social.summarize'),
    'blog.social.caption': () => _resolveFromTeamDefault('blog.social.caption'),
    'blog.star.summarize': () => _resolveFromTeamDefault('blog.star.summarize'),
    'blog.star.caption': () => _resolveFromTeamDefault('blog.star.caption'),
    'blog.curriculum.recommend': () => _resolveFromTeamDefault('blog.curriculum.recommend'),
    'blog.curriculum.generate': () => _resolveFromTeamDefault('blog.curriculum.generate'),

    'core._default': () => _resolveFromTeamDefault('core._default'),
    'core.chunked.gpt4o': () => _resolveFromTeamDefault('core.chunked.gpt4o'),
    'core.chunked.default': () => _resolveFromTeamDefault('core.chunked.default'),

    'video._default': () => _resolveFromTeamDefault('video._default'),
    'video.step-proposal': () => _resolveFromTeamDefault('video.step-proposal'),

    'investment.agent_policy': ({ agentName, agentModel = null, openaiPerfModel = 'gpt-5.4', policyOverride } = {}) => {
      const defaultRoutes = {
        luna: 'openai_perf',
        nemesis: 'dual_groq',
        oracle: 'groq_scout',
        hermes: 'local_primary',
        sophia: 'local_primary',
        zeus: 'openai_mini',
        athena: 'openai_mini',
        argos: 'local_fast',
      };
      const configuredRoutes = _isObject(policyOverride?.agentRoutes)
        ? { ...defaultRoutes, ...policyOverride.agentRoutes }
        : defaultRoutes;
      const openaiMiniModel = policyOverride?.openaiMiniModel || 'gpt-4o-mini';
      const groqScoutModel = policyOverride?.groqScoutModel || 'meta-llama/llama-4-scout-17b-16e-instruct';
      const groqCompetitionModels = Array.isArray(policyOverride?.groqCompetitionModels) && policyOverride.groqCompetitionModels.length > 0
        ? _clone(policyOverride.groqCompetitionModels)
        : [
            'openai/gpt-oss-20b',
            'meta-llama/llama-4-scout-17b-16e-instruct',
          ];
      const anthropicModel = policyOverride?.anthropicModel || 'claude-haiku-4-5-20251001';
      const route = _buildRouteFromAgentModel(agentModel, {
        openaiPerfModel,
        openaiMiniModel,
        groqScoutModel,
        groqCompetitionModels,
      }) || configuredRoutes[agentName] || 'groq_scout';
      const routeChains = {
        openai_perf: [
          { provider: 'openai-oauth', model: openaiPerfModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
        ],
        dual_groq: [
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'groq', model: groqCompetitionModels[1] || groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
        ],
        openai_mini: [
          { provider: 'openai-oauth', model: openaiMiniModel },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiPerfModel },
        ],
        local_primary: [
          { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
          { provider: 'groq', model: groqScoutModel },
          { provider: 'openai-oauth', model: openaiMiniModel },
        ],
        groq_scout: [
          { provider: 'groq', model: groqScoutModel },
          { provider: 'groq', model: groqCompetitionModels[0] || 'openai/gpt-oss-20b' },
          { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
        ],
        local_fast: [
          { provider: 'local', model: 'qwen2.5-7b', maxTokens: 1024, temperature: 0.1 },
          { provider: 'groq', model: groqScoutModel },
        ],
        local_deep: [
          { provider: 'local', model: 'deepseek-r1-32b', maxTokens: 2048, temperature: 0.1 },
          { provider: 'groq', model: groqScoutModel },
        ],
        groq_with_local: [
          { provider: 'groq', model: 'moonshotai/kimi-k2-instruct-0905', maxTokens: 2048, temperature: 0.1 },
          { provider: 'local', model: 'deepseek-r1-32b', maxTokens: 2048, temperature: 0.1 },
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

const SELECTOR_REGISTRY = _buildSelectorRegistry();

function _normalizeChainFromPolicy(policy) {
  if (Array.isArray(policy)) return _clone(policy);
  if (policy?.enabled === false) return [];
  if (Array.isArray(policy?.chain)) return _clone(policy.chain);
  if (Array.isArray(policy?.fallbackChain)) return _clone(policy.fallbackChain);
  if (_isObject(policy?.primary)) {
    const chain = [_clone(policy.primary)];
    if (_isObject(policy.fallback)) chain.push(_clone(policy.fallback));
    if (Array.isArray(policy.fallbacks)) chain.push(..._clone(policy.fallbacks));
    return chain;
  }
  if (_isObject(policy) && typeof policy.model === 'string') {
    return [_clone(policy)];
  }
  return null;
}

function selectLLMPolicy(key, options = {}) {
  const entry = SELECTOR_REGISTRY[key];
  if (!entry) throw new Error(`알 수 없는 LLM selector key: ${key}`);
  const resolved = typeof entry === 'function' ? entry(options) : _clone(entry);
  return _applyPolicyOverride(resolved, options.policyOverride, options);
}

function selectLLMChain(key, options = {}) {
  const resolved = selectLLMPolicy(key, options);
  const normalizedChain = _normalizeChainFromPolicy(resolved);
  if (!normalizedChain) {
    throw new Error(`LLM selector key ${key} 는 chain이 아닙니다`);
  }
  return normalizedChain;
}

function describeLLMSelector(key, options = {}) {
  const resolved = selectLLMPolicy(key, options);
  if (resolved?.enabled === false) {
    return {
      key,
      kind: 'none',
      primary: null,
      fallbacks: [],
      chain: [],
      enabled: false,
    };
  }
  const chain = _normalizeChainFromPolicy(resolved);
  if (chain) {
    return {
      key,
      kind: 'chain',
      primary: chain[0] || null,
      fallbacks: chain.slice(1),
      chain,
    };
  }
  return {
    key,
    kind: 'policy',
    policy: resolved,
  };
}

function listLLMSelectorKeys() {
  return Object.keys(SELECTOR_REGISTRY).sort();
}

function listAgentModelTargets(team = null) {
  const teams = team ? { [team]: AGENT_MODEL_REGISTRY[team] || {} } : AGENT_MODEL_REGISTRY;
  const entries = [];
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

function describeAgentModel(team, agentName, selectorOptions = {}) {
  const selectorKey = AGENT_MODEL_REGISTRY?.[team]?.[agentName] || null;
  if (!selectorKey) {
    return {
      team,
      agent: agentName,
      selectorKey: null,
      selected: false,
      description: null,
      chain: [],
    };
  }
  const description = describeLLMSelector(selectorKey, selectorOptions[selectorKey] || {});
  return {
    team,
    agent: agentName,
    selectorKey,
    selected: Array.isArray(description?.chain) && description.chain.length > 0,
    description,
    chain: Array.isArray(description?.chain) ? description.chain : [],
  };
}

module.exports = {
  inferProviderFromModel,
  buildSingleChain,
  selectLLMPolicy,
  selectLLMChain,
  describeLLMSelector,
  listLLMSelectorKeys,
  listAgentModelTargets,
  describeAgentModel,
};
