import fs from 'node:fs';
import path from 'node:path';
import { fetchHubSecrets } from './hub-client.js';

const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');

type ProviderConfig = {
  api_key?: string;
  admin_api_key?: string;
  image_api_key?: string;
};

type BillingConfig = {
  budget_anthropic?: string | number;
  budget_openai?: string | number;
  budget_total?: string | number;
  spike_threshold?: string | number;
};

type GroqConfig = {
  accounts?: unknown[];
};

type LlmConfig = {
  anthropic?: ProviderConfig;
  openai?: ProviderConfig;
  gemini?: ProviderConfig;
  groq?: GroqConfig;
  cerebras?: ProviderConfig;
  sambanova?: ProviderConfig;
  xai?: ProviderConfig;
  billing?: BillingConfig;
};

type BillingBudget = {
  anthropic: number;
  openai: number;
  total: number;
  spike_threshold: number;
};

let _config: LlmConfig | null = null;
let _hubInitDone = false;

function loadConfigLocal(): LlmConfig {
  try {
    const yaml = require('js-yaml') as { load: (content: string) => unknown };
    return (yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as LlmConfig | null) || {};
  } catch {
    return {};
  }
}

export async function initHubConfig(): Promise<boolean> {
  if (_hubInitDone) return !!_config;

  const hubData = (await fetchHubSecrets('llm')) as LlmConfig | null;
  if (hubData) {
    _config = {
      anthropic: hubData.anthropic || {},
      openai: hubData.openai || {},
      gemini: hubData.gemini || {},
      groq: hubData.groq || {},
      cerebras: hubData.cerebras || {},
      sambanova: hubData.sambanova || {},
      xai: hubData.xai || {},
      billing: hubData.billing || {},
    };
    _hubInitDone = true;
    return true;
  }

  _config = loadConfigLocal();
  _hubInitDone = true;
  return false;
}

function loadConfig(): LlmConfig {
  if (_config) return _config;
  _config = loadConfigLocal();
  return _config;
}

function readNumber(value: string | number | undefined, fallback: string): number {
  return parseFloat(String(value ?? fallback));
}

export function getAnthropicKey(): string | null {
  return loadConfig().anthropic?.api_key || process.env.ANTHROPIC_API_KEY || null;
}

export function getAnthropicAdminKey(): string | null {
  return loadConfig().anthropic?.admin_api_key || process.env.ANTHROPIC_ADMIN_API_KEY || null;
}

export function getOpenAIKey(): string | null {
  return loadConfig().openai?.api_key || process.env.OPENAI_API_KEY || null;
}

export function getOpenAIAdminKey(): string | null {
  return loadConfig().openai?.admin_api_key || process.env.OPENAI_ADMIN_API_KEY || null;
}

export function getGeminiKey(): string | null {
  return loadConfig().gemini?.api_key || process.env.GEMINI_API_KEY || null;
}

export function getGeminiImageKey(): string | null {
  return loadConfig().gemini?.image_api_key || process.env.GEMINI_IMAGE_KEY || getGeminiKey();
}

export function getGroqAccounts(): unknown[] {
  return loadConfig().groq?.accounts || [];
}

export function getCerebrasKey(): string | null {
  return loadConfig().cerebras?.api_key || null;
}

export function getSambaNovaKey(): string | null {
  return loadConfig().sambanova?.api_key || null;
}

export function getXAIKey(): string | null {
  return loadConfig().xai?.api_key || null;
}

export function getBillingBudget(): BillingBudget {
  const billing = loadConfig().billing || {};
  return {
    anthropic: readNumber(billing.budget_anthropic, '50'),
    openai: readNumber(billing.budget_openai, '30'),
    total: readNumber(billing.budget_total, '80'),
    spike_threshold: readNumber(billing.spike_threshold, '3.0'),
  };
}
