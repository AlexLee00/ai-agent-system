import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import * as env from '../../../../packages/core/lib/env.js';
import { getProviderRecord } from '../oauth/token-store';

const CONFIG_YAML = path.join(env.PROJECT_ROOT, 'bots/investment/config.yaml');
const SECRETS_STORE = path.join(env.PROJECT_ROOT, 'bots/hub/secrets-store.json');

type Dict = Record<string, any>;

type SecretsRequest = {
  params?: {
    category?: string;
  };
};

type SecretsResponse = {
  status: (code: number) => SecretsResponse;
  json: (payload: unknown) => SecretsResponse | void;
};

let _configCache: Dict | null = null;
let _configMtime = 0;
let _secretsCache: Dict | null = null;
let _secretsMtime = 0;

function sanitizeKisConfig(kis: unknown): Dict {
  if (!kis || typeof kis !== 'object' || Array.isArray(kis)) return (kis as Dict) || {};
  const { paper_trading, ...rest } = kis as Dict;
  void paper_trading;
  return rest;
}

function sanitizeConfig(config: unknown): Dict {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const typedConfig = config as Dict;
  return {
    ...typedConfig,
    kis: sanitizeKisConfig(typedConfig.kis),
  };
}

function loadConfigYaml(): Dict {
  try {
    const stat = fs.statSync(CONFIG_YAML);
    if (_configCache && stat.mtimeMs === _configMtime) return _configCache;
    _configCache = (yaml.load(fs.readFileSync(CONFIG_YAML, 'utf8')) as Dict) || {};
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[secrets] config.yaml 로드 실패:', message);
    return {};
  }
}

function loadSecretsStore(): Dict | null {
  try {
    const stat = fs.statSync(SECRETS_STORE);
    if (_secretsCache && stat.mtimeMs === _secretsMtime) return _secretsCache;
    _secretsCache = JSON.parse(fs.readFileSync(SECRETS_STORE, 'utf8')) as Dict;
    _secretsMtime = stat.mtimeMs;
    return _secretsCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[secrets] secrets-store.json 로드 실패:', message);
    return null;
  }
}

function mergeRuntimeAndSecrets(runtime: unknown, secrets: unknown): Dict {
  const merged: Dict = { ...((runtime as Dict) || {}) };
  const source = ((secrets as Dict) || {});

  Object.keys(source).forEach((key) => {
    const left = merged[key];
    const right = source[key];
    if (
      left && right
      && typeof left === 'object' && !Array.isArray(left)
      && typeof right === 'object' && !Array.isArray(right)
    ) {
      merged[key] = { ...left, ...right };
      return;
    }
    merged[key] = right;
  });

  return merged;
}

type CategoryHandler = () => Dict;

const CATEGORY_HANDLERS: Record<string, CategoryHandler> = {
  llm: () => {
    const store = loadSecretsStore();
    if (store?.anthropic || store?.openai || store?.gemini || store?.groq) {
      return {
        anthropic: store.anthropic || {},
        openai: store.openai || {},
        gemini: store.gemini || {},
        groq: { accounts: store.groq?.accounts || [] },
        cerebras: store.cerebras || {},
        sambanova: store.sambanova || {},
        xai: store.xai || {},
        billing: loadConfigYaml().billing || {},
      };
    }

    const c = loadConfigYaml();
    return {
      anthropic: { api_key: c.anthropic?.api_key, admin_api_key: c.anthropic?.admin_api_key },
      openai: { api_key: c.openai?.api_key, admin_api_key: c.openai?.admin_api_key, model: c.openai?.model },
      gemini: { api_key: c.gemini?.api_key, image_api_key: c.gemini?.image_api_key },
      groq: { accounts: c.groq?.accounts || [] },
      cerebras: { api_key: c.cerebras?.api_key },
      sambanova: { api_key: c.sambanova?.api_key },
      xai: { api_key: c.xai?.api_key },
      billing: c.billing || {},
    };
  },

  telegram: () => {
    const store = loadSecretsStore();
    if (store?.telegram) {
      return {
        bot_token: store.telegram.bot_token,
        chat_id: String(store.telegram.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
        group_id: String(store.telegram.group_id || ''),
        topic_ids: store.telegram.topic_ids || {},
      };
    }

    const c = loadConfigYaml();
    return {
      bot_token: c.telegram?.bot_token,
      chat_id: String(c.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
      group_id: String(c.telegram?.group_id || ''),
      topic_ids: c.telegram?.topic_ids || {},
    };
  },

  exchange: () => {
    const store = loadSecretsStore();
    const accounts = store?.investment_accounts || {};
    if (store?.binance || store?.upbit || store?.kis) {
      const runtime = loadConfigYaml();
      return {
        binance: mergeRuntimeAndSecrets(
          runtime.binance,
          mergeRuntimeAndSecrets(store.binance, accounts.binance),
        ),
        upbit: store.upbit || {},
        kis: sanitizeKisConfig(
          mergeRuntimeAndSecrets(
            runtime.kis,
            mergeRuntimeAndSecrets(store.kis, accounts.kis),
          ),
        ),
        trading_mode: runtime.trading_mode,
        paper_mode: runtime.paper_mode,
      };
    }

    const c = loadConfigYaml();
    return {
      binance: mergeRuntimeAndSecrets(c.binance, accounts.binance),
      upbit: c.upbit || {},
      kis: sanitizeKisConfig(mergeRuntimeAndSecrets(c.kis, accounts.kis)),
      trading_mode: c.trading_mode,
      paper_mode: c.paper_mode,
    };
  },

  openai_oauth: () => {
    const imported = getProviderRecord('openai-codex-oauth');
    const importedToken = imported?.token || {};
    if (typeof importedToken.access_token === 'string' && importedToken.access_token) {
      return {
        access_token: importedToken.access_token,
        model: imported?.metadata?.model || 'gpt-5.4',
        provider: imported?.metadata?.provider_name || 'openai-codex',
        source: imported?.metadata?.source || 'hub_oauth_token_store',
        expires_at: importedToken.expires_at || '',
      };
    }

    const store = loadSecretsStore();
    const d = store?.openai_oauth || {};
    return {
      access_token: d.access_token || '',
      model: d.model || 'gpt-5.4',
      provider: d.provider || 'openai-codex',
    };
  },

  'reservation-shared': () => {
    const store = loadSecretsStore();
    const d = store?.reservation || {};
    return {
      telegram_bot_token: d.telegram_bot_token || '',
      telegram_chat_id: d.telegram_chat_id || '',
      telegram_group_id: d.telegram_group_id || '',
      telegram_topic_ids: d.telegram_topic_ids || {},
    };
  },

  reservation: () => {
    const store = loadSecretsStore();
    const d = store?.reservation || {};
    return {
      telegram_bot_token: d.telegram_bot_token || '',
      telegram_chat_id: d.telegram_chat_id || '',
      telegram_group_id: d.telegram_group_id || '',
      telegram_topic_ids: d.telegram_topic_ids || {},
      naver_id: d.naver_id || '',
      naver_pw: d.naver_pw || '',
      pickko_id: d.pickko_id || '',
      pickko_pw: d.pickko_pw || '',
      naver_url: d.naver_url || '',
      pickko_url: d.pickko_url || '',
      db_encryption_key: d.db_encryption_key || '',
      db_key_pepper: d.db_key_pepper || '',
      datagokr_holiday_key: d.datagokr_holiday_key || '',
      datagokr_weather_key: d.datagokr_weather_key || '',
      datagokr_neis_key: d.datagokr_neis_key || '',
      datagokr_festival_key: d.datagokr_festival_key || '',
    };
  },

  worker: () => {
    const store = loadSecretsStore();
    const d = store?.worker || {};
    return {
      worker_jwt_secret: d.worker_jwt_secret || '',
      worker_webhook_secret: d.worker_webhook_secret || '',
    };
  },

  justin: () => {
    const store = loadSecretsStore();
    const d = store?.justin || {};
    const koreaLaw = d.korea_law || d.korea_law_api || {};
    return {
      korea_law: {
        user_id: koreaLaw.user_id || '',
        user_name: koreaLaw.user_name || '',
        oc: koreaLaw.oc || '',
        base_url: koreaLaw.base_url || 'https://www.law.go.kr',
      },
    };
  },

  instagram: () => {
    const store = loadSecretsStore();
    const d = store?.instagram || {};
    return {
      access_token: d.access_token || '',
      ig_user_id: d.ig_user_id || '',
      api_version: d.api_version || 'v21.0',
      base_url: d.base_url || 'https://graph.facebook.com',
      app_id: d.app_id || '',
      app_secret: d.app_secret || '',
      business_account_id: d.business_account_id || '',
      token_expires_at: d.token_expires_at || '',
      host_mode: d.host_mode || '',
      github_pages_base_url: d.github_pages_base_url || '',
      public_base_url: d.public_base_url || '',
      ops_static_base_url: d.ops_static_base_url || '',
      public_relative_prefix: d.public_relative_prefix || 'blog-assets/instagram',
    };
  },

  config: () => {
    const runtime = loadConfigYaml();
    const store = loadSecretsStore();
    return sanitizeConfig(store ? mergeRuntimeAndSecrets(runtime, store) : runtime);
  },
};

async function secretsRoute(req: SecretsRequest, res: SecretsResponse): Promise<SecretsResponse | void> {
  const { category = '' } = req.params || {};
  const handler = CATEGORY_HANDLERS[category];
  if (!handler) {
    return res.status(404).json({
      error: `unknown secrets category: ${category}`,
      available: Object.keys(CATEGORY_HANDLERS),
    });
  }
  try {
    const data = handler();
    return res.json({ category, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'secrets load failed', detail: message });
  }
}

// ─── Secret Metadata (값 미노출) ─────────────────────────────────────────────

const { isSecretKey, buildFieldMeta, buildCategoryMeta, buildRequiredSummary, summarizeCategoryCompleteness } = require('../secrets-meta.js') as {
  isSecretKey: (key: string) => boolean;
  buildFieldMeta: (key: string, value: unknown) => Record<string, unknown>;
  buildCategoryMeta: (data: Dict) => Record<string, Record<string, unknown>>;
  buildRequiredSummary: (category: string, data: Dict) => { missing: string[]; present: string[] } | null;
  summarizeCategoryCompleteness: (category: string, data: Dict) => {
    present: boolean;
    ready: boolean;
    field_count: number;
    secret_present: boolean;
    required_total: number | null;
    required_present: number | null;
    required_missing: number | null;
  };
};

type MetaRequest = {
  params?: { category?: string };
};

type MetaResponse = {
  status: (code: number) => MetaResponse;
  json: (payload: unknown) => MetaResponse | void;
};

async function secretsMetaRoute(req: MetaRequest, res: MetaResponse): Promise<MetaResponse | void> {
  const { category = '' } = req.params || {};
  const handler = CATEGORY_HANDLERS[category];
  if (!handler) {
    return res.status(404).json({
      error: `unknown secrets category: ${category}`,
      available: Object.keys(CATEGORY_HANDLERS),
    });
  }
  try {
    const data = handler();
    const fields = buildCategoryMeta(data);
    const required = buildRequiredSummary(category, data);
    const payload: Record<string, unknown> = { ok: true, category, values_redacted: true, fields };
    if (required !== null) payload.required = required;
    return res.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: 'secrets meta load failed', detail: message });
  }
}

async function secretsMetaAllRoute(_req: MetaRequest, res: MetaResponse): Promise<MetaResponse | void> {
  const categories: Record<string, {
    present: boolean;
    ready: boolean;
    field_count: number;
    secret_present: boolean;
    required_total: number | null;
    required_present: number | null;
    required_missing: number | null;
  }> = {};
  for (const [name, handler] of Object.entries(CATEGORY_HANDLERS)) {
    try {
      const data = handler();
      categories[name] = summarizeCategoryCompleteness(name, data);
    } catch {
      categories[name] = {
        present: false,
        ready: false,
        field_count: 0,
        secret_present: false,
        required_total: null,
        required_present: null,
        required_missing: null,
      };
    }
  }
  return res.json({ ok: true, values_redacted: true, categories });
}

export {
  secretsRoute,
  secretsMetaRoute,
  secretsMetaAllRoute,
  isSecretKey,
  buildFieldMeta,
  buildCategoryMeta,
  buildRequiredSummary,
  summarizeCategoryCompleteness,
};
