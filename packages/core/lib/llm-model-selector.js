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

function inferProviderFromModel(model = '') {
  if (!model) return 'anthropic';
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

function _resolvePreferredProvider(preferredApi, groqModel, maxTokens) {
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

function _dedupeByProvider(chain) {
  return chain.filter((entry, index, array) =>
    array.findIndex((candidate) => candidate.provider === entry.provider) === index
  );
}

function _buildSelectorRegistry() {
  return {
    'claude.archer.tech_analysis': [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 4096, temperature: 0.2 },
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 4096, temperature: 0.3 },
      { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 4096, temperature: 0.3 },
    ],

    'claude.lead.system_issue_triage': [
      { provider: 'openai', model: 'gpt-4o', maxTokens: 300, temperature: 0.1 },
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 300, temperature: 0.1 },
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 300, temperature: 0.1 },
    ],

    'claude.dexter.ai_analyst': ({ level = 2 }) => ({
      provider: 'openai',
      model: level >= 4 ? 'gpt-4o' : 'gpt-4o-mini',
      maxTokens: 300,
      temperature: 0.1,
    }),

    'orchestrator.jay.intent': ({ intentPrimary, intentFallback } = {}) => ({
      primary: {
        provider: 'openai',
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
      configuredProviders = ['groq', 'anthropic', 'gemini', 'openai'],
      maxTokens = 1024,
    } = {}) => {
      const configured = new Set(configuredProviders || []);
      const primary = _resolvePreferredProvider(preferredApi, groqModel, maxTokens);
      const fallback = [
        { provider: 'groq', model: `groq/${groqModel}`, maxTokens, temperature: 0.1 },
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens, temperature: 0.1 },
        { provider: 'gemini', model: 'gemini-2.5-flash', maxTokens, temperature: 0.1 },
        { provider: 'openai', model: 'gpt-4o-mini', maxTokens, temperature: 0.1 },
      ].filter((entry) => configured.has(entry.provider));
      const chain = configured.has(primary.provider) ? [primary, ...fallback] : fallback;
      return _dedupeByProvider(chain);
    },

    'worker.chat.task_intake': [
      { provider: 'groq', model: 'llama-4-scout-17b-16e-instruct', maxTokens: 250, temperature: 0.1 },
      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 250, temperature: 0.1 },
    ],

    'blog.pos.writer': [
      { provider: 'openai', model: 'gpt-4o', maxTokens: 16000, temperature: 0.82 },
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16000, temperature: 0.82 },
      { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
    ],

    'blog.gems.writer': [
      { provider: 'openai', model: 'gpt-4o', maxTokens: 16000, temperature: 0.85 },
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 16000, temperature: 0.85 },
      { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 12000, temperature: 0.75 },
    ],

    'blog.social.summarize': [
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
    ],

    'blog.social.caption': [
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
    ],

    'blog.star.summarize': [
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
    ],

    'blog.star.caption': [
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024, temperature: 0.1 },
      { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct', maxTokens: 1024, temperature: 0.1 },
    ],

    'blog.curriculum.recommend': [
      { provider: 'openai', model: 'gpt-4o', maxTokens: 2000, temperature: 0.7 },
      { provider: 'groq', model: 'qwen/qwen3-32b', maxTokens: 2000, temperature: 0.7 },
    ],

    'blog.curriculum.generate': [
      { provider: 'openai', model: 'gpt-4o', maxTokens: 8000, temperature: 0.5 },
    ],

    'core.chunked.gpt4o': [
      { provider: 'openai', model: 'gpt-4o', maxTokens: 4096, temperature: 0.75 },
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 4096, temperature: 0.75 },
      { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 4096, temperature: 0.75 },
    ],

    'core.chunked.default': [
      { provider: 'gemini', model: 'google-gemini-cli/gemini-2.5-flash', maxTokens: 4096, temperature: 0.75 },
      { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 4096, temperature: 0.75 },
      { provider: 'openai', model: 'gpt-4o', maxTokens: 4096, temperature: 0.75 },
    ],

    'investment.agent_policy': ({ agentName, openaiPerfModel = 'gpt-4o' } = {}) => {
      const route =
        agentName === 'luna' ? 'openai_perf'
          : ['nemesis', 'oracle'].includes(agentName) ? 'dual_groq'
            : ['hermes', 'sophia', 'zeus', 'athena'].includes(agentName) ? 'openai_mini'
              : 'groq_scout';
      return {
        route,
        openaiPerfModel,
        openaiMiniModel: 'gpt-4o-mini',
        groqScoutModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
        groqCompetitionModels: [
          'openai/gpt-oss-20b',
          'meta-llama/llama-4-scout-17b-16e-instruct',
        ],
        anthropicModel: 'claude-haiku-4-5-20251001',
      };
    },
  };
}

const SELECTOR_REGISTRY = _buildSelectorRegistry();

function selectLLMPolicy(key, options = {}) {
  const entry = SELECTOR_REGISTRY[key];
  if (!entry) throw new Error(`알 수 없는 LLM selector key: ${key}`);
  const resolved = typeof entry === 'function' ? entry(options) : _clone(entry);
  if (Array.isArray(resolved)) return _applyChainOverrides(resolved, options);
  return resolved;
}

function selectLLMChain(key, options = {}) {
  const resolved = selectLLMPolicy(key, options);
  if (!Array.isArray(resolved)) {
    throw new Error(`LLM selector key ${key} 는 chain이 아닙니다`);
  }
  return resolved;
}

module.exports = {
  inferProviderFromModel,
  buildSingleChain,
  selectLLMPolicy,
  selectLLMChain,
};
