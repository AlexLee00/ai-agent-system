// @ts-nocheck
'use strict';

const path = require('path');
const os = require('os');

const AI_AGENT_HOME = process.env.AI_AGENT_HOME
  || process.env.JAY_HOME
  || path.join(os.homedir(), '.ai-agent-system');
const LLM_CONTROL_DIR = process.env.HUB_LLM_CONTROL_DIR
  || process.env.JAY_LLM_CONTROL_DIR
  || path.join(AI_AGENT_HOME, 'llm-control');
const LLM_CONTROL_CONFIG = process.env.HUB_LLM_CONTROL_CONFIG
  || path.join(LLM_CONTROL_DIR, 'models.json');
const AUTH_PROFILES_FILE = process.env.HUB_LLM_AUTH_PROFILES_FILE
  || path.join(LLM_CONTROL_DIR, 'auth-profiles.json');
const SPEED_TEST_KEYS_FILE = process.env.HUB_LLM_SPEED_TEST_KEYS_FILE
  || path.join(LLM_CONTROL_DIR, 'speed-test-keys.json');
const INVEST_SECRETS_FILE = path.resolve(__dirname, '../../../../bots/investment/secrets.json');

const PROVIDER_ENV_KEYS = {
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  sambanova: 'SAMBANOVA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  together: 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
};

const SUPPORTED_MODEL_ALIASES = {};

const SPEED_TEST_MODEL_CATALOG = {
  'google-gemini-cli': new Set([
    'google-gemini-cli/gemini-2.5-flash-lite',
    'google-gemini-cli/gemini-2.5-flash',
    'google-gemini-cli/gemini-2.5-pro',
  ]),
  openai: new Set([
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'openai/o4-mini',
    'openai/o3-mini',
  ]),
  groq: new Set([
    'groq/llama-3.1-8b-instant',
    'groq/llama-3.3-70b-versatile',
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
    'groq/qwen/qwen3-32b',
    'groq/openai/gpt-oss-20b',
  ]),
  cerebras: new Set([
    'cerebras/llama3.1-8b',
    'cerebras/gpt-oss-120b',
  ]),
};

function buildDefaultModelsConfig() {
  const models = {};
  for (const ids of Object.values(SPEED_TEST_MODEL_CATALOG)) {
    for (const id of ids) models[id] = {};
  }
  return { agents: { defaults: { models, model: { primary: null, fallbacks: [] } } } };
}

function readJsonOrDefault(fs, filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(fs, filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
}

function loadModels(fs, { modelArg } = {}) {
  const cfg = readJsonOrDefault(fs, LLM_CONTROL_CONFIG, buildDefaultModelsConfig());
  const allModels = cfg?.agents?.defaults?.models ?? {};

  const supported = Object.keys(allModels)
    .map((id) => SUPPORTED_MODEL_ALIASES[id] || id)
    .filter((id) =>
      id.startsWith('google-gemini-cli/') ||
      id.startsWith('ollama/') ||
      id.startsWith('openai/') ||
      id.startsWith('groq/') ||
      id.startsWith('cerebras/') ||
      id.startsWith('sambanova/') ||
      id.startsWith('openrouter/') ||
      id.startsWith('xai/') ||
      id.startsWith('mistral/') ||
      id.startsWith('together/') ||
      id.startsWith('fireworks/') ||
      id.startsWith('deepinfra/')
    )
    .filter((id, index, arr) => arr.indexOf(id) === index)
    .filter((id) => {
      const provider = id.split('/')[0];
      const catalog = SPEED_TEST_MODEL_CATALOG[provider];
      return !catalog || catalog.has(id);
    });

  if (modelArg) {
    const filter = modelArg.split(',');
    return supported.filter((id) => filter.some((item) => id.includes(item)));
  }
  return supported;
}

function classifySpeedTestError(provider, modelId, errorMessage = '') {
  const message = String(errorMessage || '');
  const lower = message.toLowerCase();

  if (lower.includes('enotfound') || lower.includes('eai_again')) return 'network_unavailable';
  if (lower.includes('eperm: operation not permitted')) return 'snapshot_write_failed';
  if (lower.includes('http 429') || lower.includes('rate limit') || lower.includes('exhausted your capacity')) return 'rate_limited';
  if (provider === 'google-gemini-cli' && lower.includes('does not support setting thinking_budget to 0')) return 'gemini_thinking_budget_unsupported';
  if (lower.includes('does not exist or you do not have access to it')) return 'unsupported_or_no_access';
  if (lower.includes('unsupported model') || lower.includes('model not found')) return 'unsupported_model';
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('forbidden')) return 'auth_or_access_failed';
  return 'request_failed';
}

function loadSpeedTestKeys(fs) {
  try { return JSON.parse(fs.readFileSync(SPEED_TEST_KEYS_FILE, 'utf-8')); }
  catch { return {}; }
}

function loadOpenAIKey(fs) {
  const profiles = readJsonOrDefault(fs, AUTH_PROFILES_FILE, { profiles: {} });
  const profile = Object.values(profiles.profiles ?? {}).find((item) => item.provider === 'openai');
  return profile?.key ?? process.env.OPENAI_API_KEY ?? null;
}

function loadInvestSecretKeys(fs) {
  const INVEST_KEY_MAP = {
    groq: 'groq_api_key',
    cerebras: 'cerebras_api_key',
    sambanova: 'sambanova_api_key',
  };
  try {
    const secrets = JSON.parse(fs.readFileSync(INVEST_SECRETS_FILE, 'utf-8'));
    const result = {};
    for (const [provider, field] of Object.entries(INVEST_KEY_MAP)) {
      if (secrets[field]) result[provider] = secrets[field];
    }
    return result;
  } catch {
    return {};
  }
}

function loadProviderKey(fs, provider) {
  if (provider === 'openai') return loadOpenAIKey(fs);
  const keys = loadSpeedTestKeys(fs);
  if (keys[provider]) return keys[provider];
  const envVar = PROVIDER_ENV_KEYS[provider];
  if (envVar && process.env[envVar]) return process.env[envVar];
  const investKeys = loadInvestSecretKeys(fs);
  if (investKeys[provider]) return investKeys[provider];
  return null;
}

function applyFastest(fs, results) {
  const cfg = readJsonOrDefault(fs, LLM_CONTROL_CONFIG, buildDefaultModelsConfig());
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = cfg.agents.defaults.model || {};
  const geminiValid = results.filter((item) => item.ok && item.provider === 'google-gemini-cli');
  if (geminiValid.length === 0) return null;

  cfg.agents.defaults.model.primary = geminiValid[0].modelId;
  const geminiRest = geminiValid.slice(1).map((item) => item.modelId);
  const ollamaList = results.filter((item) => item.ok && item.provider === 'ollama').map((item) => item.modelId);
  const otherList = results.filter((item) => item.ok && !['google-gemini-cli', 'ollama'].includes(item.provider)).map((item) => item.modelId);
  cfg.agents.defaults.model.fallbacks = [...geminiRest, ...ollamaList, ...otherList];

  writeJsonFile(fs, LLM_CONTROL_CONFIG, cfg);
  return geminiValid[0].modelId;
}

module.exports = {
  AI_AGENT_HOME,
  LLM_CONTROL_DIR,
  LLM_CONTROL_CONFIG,
  AUTH_PROFILES_FILE,
  SPEED_TEST_KEYS_FILE,
  INVEST_SECRETS_FILE,
  loadModels,
  classifySpeedTestError,
  loadSpeedTestKeys,
  loadOpenAIKey,
  loadInvestSecretKeys,
  loadProviderKey,
  applyFastest,
};
