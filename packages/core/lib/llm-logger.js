'use strict';

/**
 * packages/core/lib/llm-logger.js — 전체 팀 통합 LLM 사용 추적
 *
 * PostgreSQL reservation 스키마 llm_usage_log 테이블에 기록.
 * 스카팀/클로드팀/루나팀 모든 LLM 호출을 DB에 기록.
 * 기존 cost-tracker.js (루나팀 전용, 파일 기반)와 독립 — 건드리지 않음.
 *
 * 사용법:
 *   const logger = require('../../../packages/core/lib/llm-logger');
 *   logger.logLLMCall({ team: 'ska', bot: 'ska', model: 'groq/llama-4-scout', ... });
 */

const pgPool = require('./pg-pool');

// ── 스키마 초기화 플래그 ───────────────────────────────────────────────
let _initialized = false;

async function _ensureTable() {
  if (_initialized) return;
  await pgPool.run('reservation', `
    CREATE TABLE IF NOT EXISTS llm_usage_log (
      id            SERIAL PRIMARY KEY,
      timestamp     TEXT NOT NULL,
      team          TEXT NOT NULL,
      bot           TEXT NOT NULL,
      model         TEXT NOT NULL,
      request_type  TEXT,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      cache_hit     INTEGER NOT NULL DEFAULT 0,
      latency_ms    INTEGER,
      success       INTEGER NOT NULL DEFAULT 1,
      error_msg     TEXT,
      created_at    TEXT NOT NULL
    )
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_llm_log_team ON llm_usage_log(team, created_at)
  `);
  await pgPool.run('reservation', `
    CREATE INDEX IF NOT EXISTS idx_llm_log_bot ON llm_usage_log(team, bot, created_at)
  `);
  _initialized = true;
}

// ── 모델별 단가 ($ per 1M tokens) ─────────────────────────────────────

const PRICING = {
  'groq/llama-4-scout-17b-16e-instruct':      { input: 0,     output: 0     },
  'meta-llama/llama-4-scout-17b-16e-instruct':{ input: 0,     output: 0     },
  'claude-haiku-4-5-20251001':                { input: 1.00,  output: 5.00  },
  'claude-haiku-4-5':                         { input: 1.00,  output: 5.00  },
  'claude-sonnet-4-6':                        { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':                          { input: 15.00, output: 75.00 },
  'google-gemini-cli/gemini-2.5-flash':       { input: 0,     output: 0     },
  'gemini-2.5-flash':                         { input: 0,     output: 0     },
  'gpt-4o':                                   { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                              { input: 0.15,  output: 0.60  },
};

// ── 헬퍼 ──────────────────────────────────────────────────────────────

function _kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

function _kstDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().split('T')[0];
}

function _calcCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] || { input: 0, output: 0 };
  return ((inputTokens * p.input) + (outputTokens * p.output)) / 1_000_000;
}

// ── 핵심 함수 ─────────────────────────────────────────────────────────

/**
 * LLM 호출 기록
 * @param {object} opts
 * @param {string}  opts.team          'ska' | 'claude' | 'luna'
 * @param {string}  opts.bot           봇명 (ska, aria, dexter, luna, archer ...)
 * @param {string}  opts.model         모델 ID
 * @param {string}  [opts.requestType] 요청 유형 (reservation_check, trade_signal ...)
 * @param {number}  [opts.inputTokens]
 * @param {number}  [opts.outputTokens]
 * @param {number}  [opts.costUsd]     미제공 시 단가표로 자동 계산
 * @param {boolean} [opts.cacheHit]    캐시 히트 여부
 * @param {number}  [opts.latencyMs]   응답 소요 시간
 * @param {boolean} [opts.success]     성공 여부 (기본 true)
 * @param {string}  [opts.errorMsg]    실패 시 에러 메시지
 */
async function logLLMCall({
  team, bot, model,
  requestType  = 'unknown',
  inputTokens  = 0,
  outputTokens = 0,
  costUsd,
  cacheHit     = false,
  latencyMs    = null,
  success      = true,
  errorMsg     = null,
}) {
  try {
    await _ensureTable();
    const cost = costUsd !== undefined ? costUsd : _calcCost(model, inputTokens, outputTokens);
    const now  = _kstNow();

    await pgPool.run('reservation', `
      INSERT INTO llm_usage_log
        (timestamp, team, bot, model, request_type,
         input_tokens, output_tokens, cost_usd,
         cache_hit, latency_ms, success, error_msg, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      now, team, bot, model, requestType,
      inputTokens, outputTokens, cost,
      cacheHit ? 1 : 0, latencyMs,
      success ? 1 : 0, errorMsg, now,
    ]);
  } catch (e) {
    console.warn(`[llm-logger] 기록 실패 (${bot}): ${e.message}`);
  }
}

/**
 * 팀별 일간 비용 집계
 * @param {string} [team]    생략 시 전체 팀 배열 반환
 * @param {string} [dateKst] 'YYYY-MM-DD', 생략 시 오늘
 */
async function getDailyCost(team, dateKst) {
  await _ensureTable();
  const date = dateKst || _kstDate();

  if (team) {
    const row = await pgPool.get('reservation', `
      SELECT SUM(cost_usd)::float   AS total,
             SUM(cache_hit)         AS cache_hits,
             COUNT(*)               AS calls
      FROM llm_usage_log
      WHERE team = $1 AND created_at::date = $2::date
    `, [team, date]);
    return {
      team,
      date,
      total:      parseFloat(row?.total      || 0),
      cacheHits:  parseInt(row?.cache_hits   || 0),
      calls:      parseInt(row?.calls        || 0),
    };
  }

  return pgPool.query('reservation', `
    SELECT team,
           SUM(cost_usd)::float AS total,
           SUM(cache_hit)       AS cache_hits,
           COUNT(*)             AS calls
    FROM llm_usage_log
    WHERE created_at::date = $1::date
    GROUP BY team
    ORDER BY total DESC
  `, [date]);
}

/**
 * 팀별/봇별 비용 상세 (최근 N일)
 * @param {string} [team] 생략 시 전체
 * @param {number} [days] 기간 (기본 7일)
 */
async function getCostBreakdown(team, days = 7) {
  await _ensureTable();
  const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - days * 86400 * 1000)
    .toISOString().split('T')[0];

  if (team) {
    return pgPool.query('reservation', `
      SELECT team, bot, model, request_type,
             SUM(cost_usd)::float                AS total_cost,
             SUM(input_tokens + output_tokens)   AS total_tokens,
             SUM(cache_hit)                      AS cache_hits,
             COUNT(*)                            AS calls,
             AVG(latency_ms)::integer            AS avg_latency_ms
      FROM llm_usage_log
      WHERE team = $1 AND created_at::date >= $2::date
      GROUP BY team, bot, model, request_type
      ORDER BY total_cost DESC, total_tokens DESC
    `, [team, cutoff]);
  }

  return pgPool.query('reservation', `
    SELECT team, bot, model, request_type,
           SUM(cost_usd)::float                AS total_cost,
           SUM(input_tokens + output_tokens)   AS total_tokens,
           SUM(cache_hit)                      AS cache_hits,
           COUNT(*)                            AS calls,
           AVG(latency_ms)::integer            AS avg_latency_ms
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model, request_type
    ORDER BY total_cost DESC, total_tokens DESC
  `, [cutoff]);
}

/**
 * 텔레그램 일간 비용 리포트 텍스트 생성
 */
async function buildDailyCostReport() {
  const today = _kstDate();
  const rows  = await getDailyCost(null, today);

  if (!Array.isArray(rows) || rows.length === 0) {
    return `💰 LLM 일간 비용 리포트 (${today})\n  데이터 없음`;
  }

  const totalCost   = rows.reduce((s, r) => s + (parseFloat(r.total)      || 0), 0);
  const totalCalls  = rows.reduce((s, r) => s + (parseInt(r.calls)        || 0), 0);
  const totalCached = rows.reduce((s, r) => s + (parseInt(r.cache_hits)   || 0), 0);
  const savedPct    = totalCalls > 0 ? Math.round(totalCached / totalCalls * 100) : 0;

  const TEAM_LABEL = { ska: '스카팀', claude: '클로드팀', luna: '루나팀' };

  const teamLines = rows.map(r => {
    const label = TEAM_LABEL[r.team] || r.team;
    const tag   = parseFloat(r.total) < 0.0001 ? '무료' : `$${parseFloat(r.total).toFixed(4)}`;
    return `  ${label}: ${tag} (${r.calls}회)`;
  });

  return [
    `💰 팀 제이 LLM 일간 비용 (${today})`,
    `──────────────────────`,
    ...teamLines,
    `──────────────────────`,
    `총계: $${totalCost.toFixed(4)}`,
    `캐시 절감: ${totalCached}회 (${savedPct}%)`,
  ].join('\n');
}

module.exports = { logLLMCall, getDailyCost, getCostBreakdown, buildDailyCostReport };
