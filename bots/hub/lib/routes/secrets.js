'use strict';
/**
 * routes/secrets.js — 시크릿 프록시
 *
 * OPS/DEV 모두 Hub를 1순위로 사용, 로컬 config.yaml은 폴백.
 * Hub는 원본을 그대로 반환. DEV 안전은 클라이언트의 env.js
 * (MODE=dev → PAPER_MODE=true) + hostname 체크가 담당.
 * 티어 4(OPS 전용 예약 키)만 마스킹.
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

  // 거래소 키 — 원본 반환 (DEV 안전은 클라이언트 env.js가 담당)
  exchange: () => {
    const c = loadConfigYaml();
    return {
      binance: c.binance || {},
      upbit: c.upbit || {},
      kis: c.kis || {},
      trading_mode: c.trading_mode,
      paper_mode: c.paper_mode,
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

  // config.yaml 전체 — 원본 반환 (DEV 안전은 클라이언트 env.js가 담당)
  config: () => {
    return loadConfigYaml();
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
