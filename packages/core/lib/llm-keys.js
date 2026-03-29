'use strict';

/**
 * packages/core/lib/llm-keys.js — 통합 LLM API 키 로더
 *
 * Single Source of Truth: bots/investment/config.yaml
 * config.yaml 없으면 환경변수 fallback
 *
 * 사용법 (CJS):
 *   const { getAnthropicKey, getGroqAccounts } = require('../../../packages/core/lib/llm-keys');
 */

const fs   = require('fs');
const path = require('path');
const { fetchHubSecrets } = require('./hub-client');

const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'bots', 'investment', 'config.yaml');

let _config = null;
let _hubInitDone = false;

function loadConfigLocal() {
  try {
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function initHubConfig() {
  if (_hubInitDone) return !!_config;

  const hubData = await fetchHubSecrets('llm');
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

function loadConfig() {
  if (_config) return _config;
  _config = loadConfigLocal();
  return _config;
}

function getAnthropicKey()      { return loadConfig()?.anthropic?.api_key       || process.env.ANTHROPIC_API_KEY       || null; }
function getAnthropicAdminKey() { return loadConfig()?.anthropic?.admin_api_key  || process.env.ANTHROPIC_ADMIN_API_KEY  || null; }
function getOpenAIKey()         { return loadConfig()?.openai?.api_key           || process.env.OPENAI_API_KEY           || null; }
function getOpenAIAdminKey()    { return loadConfig()?.openai?.admin_api_key      || process.env.OPENAI_ADMIN_API_KEY      || null; }
function getGeminiKey()          { return loadConfig()?.gemini?.api_key           || process.env.GEMINI_API_KEY           || null; }
function getGeminiImageKey()    { return loadConfig()?.gemini?.image_api_key     || process.env.GEMINI_IMAGE_KEY         || getGeminiKey(); }
function getGroqAccounts()      { return loadConfig()?.groq?.accounts            || []; }
function getCerebrasKey()       { return loadConfig()?.cerebras?.api_key         || null; }
function getSambaNovaKey()      { return loadConfig()?.sambanova?.api_key        || null; }
function getXAIKey()            { return loadConfig()?.xai?.api_key             || null; }

// 빌링 예산 설정 (config.yaml billing 섹션 또는 환경변수)
function getBillingBudget() {
  const b = loadConfig()?.billing || {};
  return {
    anthropic: parseFloat(b.budget_anthropic || process.env.BILLING_BUDGET_ANTHROPIC || '50'),
    openai:    parseFloat(b.budget_openai    || process.env.BILLING_BUDGET_OPENAI    || '30'),
    total:     parseFloat(b.budget_total     || process.env.BILLING_BUDGET_TOTAL     || '80'),
    spike_threshold: parseFloat(b.spike_threshold || process.env.BILLING_SPIKE_THRESHOLD || '3.0'),
  };
}

module.exports = {
  initHubConfig,
  getAnthropicKey,
  getAnthropicAdminKey,
  getOpenAIKey,
  getOpenAIAdminKey,
  getGeminiKey,
  getGeminiImageKey,
  getGroqAccounts,
  getCerebrasKey,
  getSambaNovaKey,
  getXAIKey,
  getBillingBudget,
};
