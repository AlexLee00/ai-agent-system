import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const env = require('../../../../packages/core/lib/env');

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
    if (store?.binance || store?.upbit || store?.kis) {
      const runtime = loadConfigYaml();
      return {
        binance: mergeRuntimeAndSecrets(runtime.binance, store.binance),
        upbit: store.upbit || {},
        kis: sanitizeKisConfig(mergeRuntimeAndSecrets(runtime.kis, store.kis)),
        trading_mode: runtime.trading_mode,
        paper_mode: runtime.paper_mode,
      };
    }

    const c = loadConfigYaml();
    return {
      binance: c.binance || {},
      upbit: c.upbit || {},
      kis: sanitizeKisConfig(c.kis),
      trading_mode: c.trading_mode,
      paper_mode: c.paper_mode,
    };
  },

  openclaw: () => {
    const store = loadSecretsStore();
    const d = store?.openclaw || {};
    return {
      gateway_token: d.gateway_token || '',
      hooks_token: d.hooks_token || '',
    };
  },

  openai_oauth: () => {
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

  // NOTE:
  // Instagram Graph API 자격증명은 아직 운영 시크릿으로 등록되지 않았습니다.
  // 토큰과 IG User ID를 공식 경로로 주입하기 전까지는 허브 secrets 라우트에서
  // `instagram` 카테고리를 열어두지 않습니다. 그렇지 않으면 "지원되는 시크릿"처럼
  // 보이지만 실제로는 빈 값만 반환해 혼선을 만들 수 있습니다.
  //
  // 재활성화 시 아래 핸들러를 되살리고, `packages/core/lib/instagram-graph.ts`의
  // 허브 fetch 경로도 함께 다시 켜면 됩니다.
  //
  // instagram: () => {
  //   const store = loadSecretsStore();
  //   const d = store?.instagram || {};
  //   return {
  //     access_token: d.access_token || '',
  //     ig_user_id: d.ig_user_id || '',
  //     api_version: d.api_version || 'v21.0',
  //     base_url: d.base_url || 'https://graph.facebook.com',
  //     app_id: d.app_id || '',
  //     app_secret: d.app_secret || '',
  //     business_account_id: d.business_account_id || '',
  //   };
  // },

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

export { secretsRoute };
