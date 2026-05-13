// @ts-nocheck
/**
 * shared/llm-client.js — Luna/Investment Hub-only LLM client.
 *
 * Runtime LLM 호출은 Hub Gateway가 소유한다. 이 파일은 billing guard,
 * Hub 호출, semantic cache만 담당하고 provider SDK 직접 호출은 보유하지 않는다.
 */

import { createHash }   from 'crypto';
import { createRequire } from 'module';
import { getTradingMode, getInvestmentGuardScope, initHubSecrets } from './secrets.ts';

// CJS billing-guard (긴급 차단)
let _billingGuard = null;
try {
  const require = createRequire(import.meta.url);
  _billingGuard = require('../../../packages/core/lib/billing-guard');
} catch { /* 무음 처리 */ }

// CJS pgPool (LLM 시맨틱 캐시용 — reservation 스키마)
let _pgPool = null;
try {
  const require = createRequire(import.meta.url);
  _pgPool = require('../../../packages/core/lib/pg-pool');
} catch {
  // pgPool 없는 환경에서는 캐시 비활성화
}

const require = createRequire(import.meta.url);

export const PAPER_MODE = getTradingMode() === 'paper';

const {
  selectLLMPolicy,
} = require('../../../packages/core/lib/llm-model-selector.js');

// ─── 모델 상수 ───────────────────────────────────────────────────────

const DEFAULT_INVESTMENT_POLICY = selectLLMPolicy('investment.agent_policy', {
  agentName: 'luna',
});
export const GROQ_SCOUT_MODEL  = DEFAULT_INVESTMENT_POLICY.groqScoutModel;
export const GPT_OSS_20B_MODEL = DEFAULT_INVESTMENT_POLICY.groqCompetitionModels[0];
export const OPENAI_PERF_MODEL = DEFAULT_INVESTMENT_POLICY.openaiPerfModel;
export const HAIKU_MODEL       = DEFAULT_INVESTMENT_POLICY.anthropicModel;
export const OPENAI_MINI_MODEL = DEFAULT_INVESTMENT_POLICY.openaiMiniModel;

// ─── JSON 파싱 헬퍼 ──────────────────────────────────────────────────

export function parseJSON(text) {
  if (!text) return null;
  let clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = clean.search(/[\[{]/);
  const end   = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(clean.slice(start, end + 1)); } catch {}
  try { return JSON.parse(clean); } catch { return null; }
}

// ─── Hub LLM 클라이언트 (지연 로드) ─────────────────────────────────

let _hubLLM = null;
function getHubLLM() {
  if (!_hubLLM) {
    try {
      _hubLLM = require('./hub-llm-client.ts');
    } catch {
      _hubLLM = { isHubEnabled: () => false, isHubShadow: () => false, callViaHub: async () => ({ ok: false }) };
    }
  }
  return _hubLLM;
}

// ─── 통합 LLM 호출 ───────────────────────────────────────────────────

/**
 * @param {string} agentName  'luna'|'nemesis'|'zeus'|'athena'|'oracle'|'hermes'|'sophia'
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=512]
 * @returns {Promise<string>}  LLM 응답 텍스트
 */
export async function callLLM(agentName, systemPrompt, userPrompt, maxTokens = 512, options = {}) {
  await initHubSecrets();
  const guardScope = resolveInvestmentLLMGuardScope(options);
  if (_billingGuard?.isBlocked(guardScope)) {
    const r = _billingGuard.getBlockReason(guardScope);
    throw new Error(`LLM 긴급 차단 중: ${r?.reason || '알 수 없음'} — 마스터 해제 필요`);
  }

  const hub = getHubLLM();
  const hubEnabled = hub.isHubEnabled();
  const hubShadow  = hub.isHubShadow();

  if (!hubEnabled && !hubShadow) {
    throw new Error('Investment LLM Hub routing is disabled; provider 직접 폴백은 제거됨. INVESTMENT_LLM_HUB_ENABLED=true로 Hub를 복구해야 한다.');
  }

  const result = await hub.callViaHub(agentName, systemPrompt, userPrompt, {
    maxTokens,
    symbol:   options.symbol,
    market:   options.market || getCurrentInvestmentMarket(),
    urgency:  agentName === 'luna' ? 'high' : 'normal',
    taskType: options.taskType || options.purpose || 'trade_signal',
    incidentKey: options.incidentKey,
    timeoutMs: options.timeoutMs,
  });
  if (result.ok) return result.text;
  throw new Error(`Hub LLM 호출 실패: ${result.error || 'unknown'} — provider 직접 폴백은 제거됨. Hub route/secret/selector를 복구해야 한다.`);
}

function normalizeScopeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveInvestmentLLMGuardScope(options = {}) {
  const baseScope = getInvestmentGuardScope();
  const explicit = normalizeScopeToken(options.guardScopeSuffix || options.scopeSuffix || '');
  if (explicit) return `${baseScope}.${explicit}`;

  const symbolToken = normalizeScopeToken(options.symbol || '');
  if (symbolToken) return `${baseScope}.${symbolToken}`;

  return baseScope;
}

function getCurrentInvestmentMarket() {
  const market = String(process.env.INVESTMENT_MARKET || '').trim().toLowerCase();
  return ['crypto', 'domestic', 'overseas'].includes(market) ? market : null;
}

// ─── 시맨틱 캐싱 (SHA256 해시, PostgreSQL reservation.llm_cache) ──────

let _cacheReady = false;

async function ensureLLMCache() {
  if (_cacheReady || !_pgPool) return;
  try {
    await _pgPool.run('reservation', `
      CREATE TABLE IF NOT EXISTS llm_cache (
        cache_key  TEXT PRIMARY KEY,
        response   TEXT NOT NULL,
        model      TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await _pgPool.run('reservation',
      `CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache (expires_at)`
    );
    _cacheReady = true;
  } catch {
    // 캐시 테이블 생성 실패 시 조용히 비활성화
  }
}

/**
 * 캐싱 래퍼 — 동일 프롬프트는 TTL 내에서 DB 캐시 반환
 *
 * @param {string} agentName
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {number} [maxTokens=512]
 * @param {object} [opts]
 * @param {number} [opts.cacheTTL=300]  캐시 유효 시간(초) — 루나팀 기본 5분
 * @param {boolean} [opts.skipCache]    true: 캐시 우회 (긴급 시)
 * @returns {Promise<string>}
 */
export async function cachedCallLLM(agentName, systemPrompt, userPrompt, maxTokens = 512, opts = {}) {
  const ttl = Math.max(60, Math.min(86400, Math.floor(opts.cacheTTL ?? 300)));  // 1분~24시간

  if (opts.skipCache || !_pgPool) {
    return callLLM(agentName, systemPrompt, userPrompt, maxTokens, opts);
  }

  await ensureLLMCache();
  if (!_cacheReady) {
    return callLLM(agentName, systemPrompt, userPrompt, maxTokens, opts);
  }

  const key = createHash('sha256')
    .update(agentName + systemPrompt + userPrompt)
    .digest('hex');

  // 캐시 조회
  try {
    const rows = await _pgPool.query('reservation',
      'SELECT response FROM llm_cache WHERE cache_key = $1 AND expires_at > NOW()',
      [key],
    );
    if (rows.length > 0) {
      console.log(`  💾 [${agentName}] LLM 캐시 히트 (${key.slice(0, 8)}...)`);
      return rows[0].response;
    }
  } catch { /* 조회 실패 → API 직접 호출 */ }

  // 캐시 미스 → API 호출
  const result = await callLLM(agentName, systemPrompt, userPrompt, maxTokens, opts);

  // 캐시 저장 (실패해도 결과는 반환)
  try {
    await _pgPool.run('reservation',
      `INSERT INTO llm_cache (cache_key, response, model, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${ttl} seconds')
       ON CONFLICT (cache_key) DO UPDATE
         SET response = $2, expires_at = NOW() + INTERVAL '${ttl} seconds'`,
      [key, result, agentName],
    );
  } catch { /* 저장 실패 → 무시 */ }

  return result;
}
