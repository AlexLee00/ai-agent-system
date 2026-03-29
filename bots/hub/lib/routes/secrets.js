'use strict';
/**
 * routes/secrets.js — 시크릿 프록시
 *
 * DEV에서 OPS의 API 키를 Hub를 통해 안전하게 조회.
 * 카테고리별로 필요한 키만 반환, 티어 4(OPS 전용)는 마스킹.
 *
 * 카테고리:
 *   llm         — LLM API 키 (Anthropic/OpenAI/Gemini/Groq 등)
 *   telegram    — bot_token + chat_id
 *   exchange    — Binance/Upbit/KIS (DEV: paper/testnet 강제)
 *   reservation-shared — reservation 공유 가능 키
 *   reservation — 공유키만, OPS전용 마스킹
 *   config      — config.yaml 전체 (DEV 안전 오버라이드)
 */

const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const CONFIG_YAML = path.join(env.PROJECT_ROOT, 'bots/investment/config.yaml');
const RSV_SECRETS = path.join(env.PROJECT_ROOT, 'bots/reservation/secrets.json');
const WKR_SECRETS = path.join(env.PROJECT_ROOT, 'bots/worker/secrets.json');

let _configCache = null;
let _configMtime = 0;

function loadConfigYaml() {
  try {
    const yaml = require('js-yaml');
    const stat = fs.statSync(CONFIG_YAML);
    if (_configCache && stat.mtimeMs === _configMtime) return _configCache;
    _configCache = yaml.load(fs.readFileSync(CONFIG_YAML, 'utf8')) || {};
    _configMtime = stat.mtimeMs;
    return _configCache;
  } catch (err) {
    console.warn('[secrets] config.yaml 로드 실패:', err.message);
    return {};
  }
}

function loadJson(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
  catch { return {}; }
}

const CATEGORY_HANDLERS = {

  // LLM API 키 (티어 2: 공유)
  llm: () => {
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

  // 텔레그램 (티어 2: 공유)
  telegram: () => {
    const c = loadConfigYaml();
    return {
      bot_token: c.telegram?.bot_token,
      chat_id: String(c.telegram?.chat_id || process.env.TELEGRAM_CHAT_ID || ''),
    };
  },

  // 거래소 키 (티어 3: DEV는 paper/testnet 강제)
  exchange: () => {
    const c = loadConfigYaml();
    return {
      binance: {
        api_key: c.binance?.api_key,
        api_secret: c.binance?.api_secret,
        testnet: true,
        symbols: c.binance?.symbols || [],
      },
      upbit: {
        access_key: c.upbit?.access_key,
        secret_key: c.upbit?.secret_key,
      },
      kis: {
        app_key: c.kis?.paper_app_key || c.kis?.app_key,
        app_secret: c.kis?.paper_app_secret || c.kis?.app_secret,
        account_number: c.kis?.paper_account_number || c.kis?.account_number,
        paper_trading: true,
      },
      trading_mode: 'paper',
      paper_mode: true,
    };
  },

  // 예약 시크릿 (티어 2 공유 + 티어 4 마스킹)
  'reservation-shared': () => {
    const d = loadJson(RSV_SECRETS);
    return {
      telegram_bot_token: d.telegram_bot_token || '',
      telegram_chat_id: d.telegram_chat_id || '',
      telegram_group_id: d.telegram_group_id || '',
      telegram_topic_ids: d.telegram_topic_ids || {},
    };
  },

  // 하위 호환용 reservation 묶음
  reservation: () => {
    const d = loadJson(RSV_SECRETS);
    return {
      telegram_bot_token: d.telegram_bot_token || '',
      telegram_chat_id: d.telegram_chat_id || '',
      telegram_group_id: d.telegram_group_id || '',
      telegram_topic_ids: d.telegram_topic_ids || {},
      // 티어 4: OPS 전용 — 마스킹
      naver_id: '', naver_pw: '',
      pickko_id: '', pickko_pw: '',
      naver_url: '', pickko_url: '',
      db_encryption_key: '', db_key_pepper: '',
      datagokr_holiday_key: '', datagokr_weather_key: '',
      datagokr_neis_key: '', datagokr_festival_key: '',
    };
  },

  // config.yaml 전체 (DEV 안전 오버라이드)
  config: () => {
    const c = loadConfigYaml();
    return {
      ...c,
      trading_mode: 'paper',
      paper_mode: true,
      binance: { ...(c.binance || {}), testnet: true },
      kis: { ...(c.kis || {}), paper_trading: true },
    };
  },
};

async function secretsRoute(req, res) {
  const { category } = req.params;
  const handler = CATEGORY_HANDLERS[category];
  if (!handler) {
    return res.status(404).json({
      error: `unknown secrets category: ${category}`,
      available: Object.keys(CATEGORY_HANDLERS),
    });
  }
  try {
    const data = handler();
    res.json({ category, data });
  } catch (err) {
    res.status(500).json({ error: 'secrets load failed', detail: err.message });
  }
}

module.exports = { secretsRoute };
