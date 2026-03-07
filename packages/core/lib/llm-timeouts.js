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
 *
 * 시스템 내 실제 사용 모델 (2026-03-07 기준):
 *   스카팀:    meta-llama/llama-4-scout-17b-16e-instruct (Groq, 무료)
 *   루나팀:    meta-llama/llama-4-scout-17b-16e-instruct (Groq, 속도우선)
 *              gpt-4o (OpenAI, 성능우선 — luna/nemesis/zeus/athena/oracle)
 *              claude-haiku-4-5-20251001 (Anthropic, HAIKU_MODEL)
 *   클로드팀:  gpt-4o / gpt-4o-mini (OpenAI, ai-analyst.js 덱스터 진단)
 *   제이팀:    gemini-2.5-flash (OpenClaw 기본), groq fallback
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const OVERRIDE_FILE = path.join(os.homedir(), '.openclaw', 'workspace', 'llm-timeouts.json');

// ── 기본 타임아웃 (ms) ────────────────────────────────────────────────

const DEFAULTS = {
  // ── Groq (LPU 초고속, TTFT ~300ms, 500토큰 ~300ms) ──────────────
  'meta-llama/llama-4-scout-17b-16e-instruct':   5_000,   // 5초
  'meta-llama/llama-4-maverick-17b-128e-instruct': 8_000, // 8초 (1M ctx)
  'llama-4-scout-17b-16e-instruct':               5_000,
  'llama-4-maverick-17b-128e-instruct':           8_000,
  'openai/gpt-oss-20b':                           5_000,  // Groq 경유
  groq:                                           5_000,  // Groq 전체 기본값

  // ── Anthropic ────────────────────────────────────────────────────
  'claude-haiku-4-5-20251001':  15_000,  // 속도 최적화 모델
  'claude-sonnet-4-6':          30_000,  // 범용
  'claude-opus-4-6':            60_000,  // 깊은 추론 (장문 응답 가능)
  haiku:                        15_000,
  sonnet:                       30_000,
  opus:                         60_000,

  // ── OpenAI ───────────────────────────────────────────────────────
  'gpt-4o':                     30_000,
  'gpt-4o-mini':                20_000,
  openai:                       30_000,  // OpenAI 전체 기본값

  // ── Google Gemini ─────────────────────────────────────────────────
  'gemini-2.5-flash':           20_000,
  'gemini-2.5-flash-lite':      15_000,
  'gemini-2.5-pro':             60_000,
  'google-gemini-cli/gemini-2.5-flash':      20_000,
  'google-gemini-cli/gemini-2.5-flash-lite': 15_000,
  'google-gemini-cli/gemini-2.5-pro':        60_000,
  gemini:                       20_000,

  // ── 기본값 ────────────────────────────────────────────────────────
  default:                      30_000,
};

// ── 오버라이드 파일 로드 ──────────────────────────────────────────────

let _overrides = {};
try {
  if (fs.existsSync(OVERRIDE_FILE)) {
    _overrides = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
  }
} catch { /* 오버라이드 없으면 기본값 사용 */ }

const LLM_TIMEOUTS = { ...DEFAULTS, ..._overrides };

// ── 헬퍼 함수 ─────────────────────────────────────────────────────────

/**
 * 모델명 또는 provider명으로 타임아웃(ms) 반환
 * @param {string} modelOrProvider  예: 'gpt-4o', 'groq', 'claude-haiku-4-5-20251001'
 * @returns {number} 타임아웃 ms
 */
function getTimeout(modelOrProvider) {
  if (!modelOrProvider) return LLM_TIMEOUTS.default;
  // 정확한 키 매칭
  if (LLM_TIMEOUTS[modelOrProvider] !== undefined) return LLM_TIMEOUTS[modelOrProvider];
  // provider/modelName 형식에서 modelName만 추출
  const shortName = modelOrProvider.split('/').pop();
  if (LLM_TIMEOUTS[shortName] !== undefined) return LLM_TIMEOUTS[shortName];
  return LLM_TIMEOUTS.default;
}

/**
 * 타임아웃 오버라이드 업데이트 (speed-test.js에서 호출)
 * 파일에 저장되며 다음 프로세스 시작 시 로드됨
 * @param {Object} updates  { 'gpt-4o': 25000, ... }
 */
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

/**
 * 측정된 응답 시간으로 타임아웃 계산
 * 공식: max(measured * 3, providerMin) 단위를 1000ms로 올림 처리
 * @param {string} model     모델 ID
 * @param {number} measuredMs 실측 총 응답 시간 (ms)
 * @returns {number} 새 타임아웃 ms
 */
function calcTimeout(model, measuredMs) {
  const raw     = measuredMs * 3;
  const rounded = Math.ceil(raw / 1000) * 1000;
  // provider별 최솟값 (실측값이 아무리 작아도 보장)
  const minMap  = { groq: 3_000, gemini: 5_000, openai: 10_000, anthropic: 10_000 };
  let minMs = 5_000;
  for (const [prov, min] of Object.entries(minMap)) {
    if (model.toLowerCase().includes(prov)) { minMs = min; break; }
  }
  return Math.max(rounded, minMs);
}

module.exports = { LLM_TIMEOUTS, getTimeout, updateTimeouts, calcTimeout, OVERRIDE_FILE };
