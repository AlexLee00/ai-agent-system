'use strict';

/**
 * packages/core/lib/llm-timeouts.js — LLM API 타임아웃 중앙 관리
 *
 * 기본값: API별 실측 기반 초기값 (Groq LPU 초고속, Claude Opus 장문 추론 등)
 *
 * 자동 업데이트:
 *   scripts/speed-test.js --update-timeouts 실행 시
 *   → ~/.openclaw/workspace/llm-timeouts.json 에 측정값 저장
 *   → 다음 프로세스 시작 시 override 파일 로드
 *
 * 우선순위: llm-timeouts.json(있으면) > 아래 기본값
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const OVERRIDE_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'llm-timeouts.json');

const DEFAULTS = {
  'meta-llama/llama-4-scout-17b-16e-instruct': 5_000,
  'meta-llama/llama-4-maverick-17b-128e-instruct': 8_000,
  'llama-4-scout-17b-16e-instruct': 5_000,
  'llama-4-maverick-17b-128e-instruct': 8_000,
  'openai/gpt-oss-20b': 5_000,
  groq: 5_000,
  'claude-haiku-4-5-20251001': 15_000,
  'claude-sonnet-4-6': 30_000,
  'claude-opus-4-6': 60_000,
  haiku: 15_000,
  sonnet: 30_000,
  opus: 60_000,
  'gpt-4o': 30_000,
  'gpt-4o-mini': 20_000,
  openai: 30_000,
  'gemini-2.5-flash': 20_000,
  'gemini-2.5-flash-lite': 15_000,
  'gemini-2.5-pro': 60_000,
  'google-gemini-cli/gemini-2.5-flash': 20_000,
  'google-gemini-cli/gemini-2.5-flash-lite': 15_000,
  'google-gemini-cli/gemini-2.5-pro': 60_000,
  gemini: 20_000,
  default: 30_000,
};

let _overrides = {};
try {
  if (fs.existsSync(OVERRIDE_FILE)) {
    _overrides = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
  }
} catch {}

const LLM_TIMEOUTS = { ...DEFAULTS, ..._overrides };

function getTimeout(modelOrProvider) {
  if (!modelOrProvider) return LLM_TIMEOUTS.default;
  if (LLM_TIMEOUTS[modelOrProvider] !== undefined) return LLM_TIMEOUTS[modelOrProvider];
  const shortName = modelOrProvider.split('/').pop();
  if (LLM_TIMEOUTS[shortName] !== undefined) return LLM_TIMEOUTS[shortName];
  return LLM_TIMEOUTS.default;
}

function updateTimeouts(updates) {
  if (!updates || typeof updates !== 'object') return;
  Object.assign(_overrides, updates);
  Object.assign(LLM_TIMEOUTS, updates);
  try {
    const dir = path.dirname(OVERRIDE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(_overrides, null, 2));
  } catch (e) {
    console.warn('[llm-timeouts] 파일 저장 실패:', e.message);
  }
}

function calcTimeout(model, measuredMs) {
  const raw = measuredMs * 3;
  const rounded = Math.ceil(raw / 1000) * 1000;
  const minMap = { groq: 3_000, gemini: 5_000, openai: 10_000, anthropic: 10_000 };
  let minMs = 5_000;
  for (const [prov, min] of Object.entries(minMap)) {
    if (model.toLowerCase().includes(prov)) {
      minMs = min;
      break;
    }
  }
  return Math.max(rounded, minMs);
}

module.exports = { LLM_TIMEOUTS, getTimeout, updateTimeouts, calcTimeout, OVERRIDE_FILE };
