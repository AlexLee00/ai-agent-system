'use strict';

/**
 * packages/core/lib/llm-logger.js — 전체 팀 통합 LLM 사용 추적
 *
 * state.db llm_usage_log 테이블에 기록.
 * 스카팀/클로드팀/루나팀 모든 LLM 호출을 DB에 기록.
 * 기존 cost-tracker.js (루나팀 전용, 파일 기반)와 독립 — 건드리지 않음.
 *
 * 사용법:
 *   const logger = require('../../../packages/core/lib/llm-logger');
 *   logger.logLLMCall({ team: 'ska', bot: 'ska', model: 'groq/llama-4-scout', ... });
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'state.db');

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

// ── DB 연결 ───────────────────────────────────────────────────────────

let _db = null;

function _getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
    );
    CREATE INDEX IF NOT EXISTS idx_llm_log_team
      ON llm_usage_log(team, created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_log_bot
      ON llm_usage_log(team, bot, created_at);
  `);
  return _db;
}

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
function logLLMCall({
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
    const cost = costUsd !== undefined ? costUsd : _calcCost(model, inputTokens, outputTokens);
    const now  = _kstNow();

    _getDb().prepare(`
      INSERT INTO llm_usage_log
        (timestamp, team, bot, model, request_type,
         input_tokens, output_tokens, cost_usd,
         cache_hit, latency_ms, success, error_msg, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      now, team, bot, model, requestType,
      inputTokens, outputTokens, cost,
      cacheHit ? 1 : 0, latencyMs,
      success ? 1 : 0, errorMsg, now,
    );
  } catch (e) {
    // 로깅 실패는 무음 — 본 기능 방해 안 함
    console.warn(`[llm-logger] 기록 실패 (${bot}): ${e.message}`);
  }
}

/**
 * 팀별 일간 비용 집계
 * @param {string} [team]    생략 시 전체 팀 배열 반환
 * @param {string} [dateKst] 'YYYY-MM-DD', 생략 시 오늘
 */
function getDailyCost(team, dateKst) {
  const date = dateKst || _kstDate();
  const db   = _getDb();

  if (team) {
    const row = db.prepare(`
      SELECT SUM(cost_usd)   AS total,
             SUM(cache_hit)  AS cache_hits,
             COUNT(*)        AS calls
      FROM llm_usage_log
      WHERE team = ? AND date(created_at) = ?
    `).get(team, date);
    return { team, date, total: row?.total || 0, cacheHits: row?.cache_hits || 0, calls: row?.calls || 0 };
  }

  return db.prepare(`
    SELECT team,
           SUM(cost_usd)   AS total,
           SUM(cache_hit)  AS cache_hits,
           COUNT(*)        AS calls
    FROM llm_usage_log
    WHERE date(created_at) = ?
    GROUP BY team
    ORDER BY total DESC
  `).all(date);
}

/**
 * 팀별/봇별 비용 상세 (최근 N일)
 * @param {string} [team] 생략 시 전체
 * @param {number} [days] 기간 (기본 7일)
 */
function getCostBreakdown(team, days = 7) {
  const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - days * 86400 * 1000)
    .toISOString().split('T')[0];

  if (team) {
    return _getDb().prepare(`
      SELECT team, bot, model, request_type,
             SUM(cost_usd)                    AS total_cost,
             SUM(input_tokens + output_tokens) AS total_tokens,
             SUM(cache_hit)                   AS cache_hits,
             COUNT(*)                         AS calls,
             CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
      FROM llm_usage_log
      WHERE team = ? AND date(created_at) >= ?
      GROUP BY team, bot, model, request_type
      ORDER BY total_cost DESC, total_tokens DESC
    `).all(team, cutoff);
  }

  return _getDb().prepare(`
    SELECT team, bot, model, request_type,
           SUM(cost_usd)                    AS total_cost,
           SUM(input_tokens + output_tokens) AS total_tokens,
           SUM(cache_hit)                   AS cache_hits,
           COUNT(*)                         AS calls,
           CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
    FROM llm_usage_log
    WHERE date(created_at) >= ?
    GROUP BY team, bot, model, request_type
    ORDER BY total_cost DESC, total_tokens DESC
  `).all(cutoff);
}

/**
 * 텔레그램 일간 비용 리포트 텍스트 생성
 */
function buildDailyCostReport() {
  const today = _kstDate();
  const rows  = getDailyCost(null, today);

  if (!Array.isArray(rows) || rows.length === 0) {
    return `💰 LLM 일간 비용 리포트 (${today})\n  데이터 없음`;
  }

  const totalCost   = rows.reduce((s, r) => s + (r.total      || 0), 0);
  const totalCalls  = rows.reduce((s, r) => s + (r.calls      || 0), 0);
  const totalCached = rows.reduce((s, r) => s + (r.cache_hits || 0), 0);
  const savedPct    = totalCalls > 0 ? Math.round(totalCached / totalCalls * 100) : 0;

  const TEAM_LABEL = { ska: '스카팀', claude: '클로드팀', luna: '루나팀' };

  const teamLines = rows.map(r => {
    const label = TEAM_LABEL[r.team] || r.team;
    const tag   = r.total < 0.0001 ? '무료' : `$${r.total.toFixed(4)}`;
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
