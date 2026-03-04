'use strict';

/**
 * lib/token-tracker.js — 전체 봇 LLM 토큰 사용 통합 추적
 *
 * claude-team.db token_usage 테이블에 기록.
 * 무료(Groq, Gemini) / 유료(Anthropic) 모두 기록 — 분석용.
 *
 * 사용법:
 *   const { trackTokens, getDailySummary } = require('./token-tracker');
 *   await trackTokens({ bot: 'luna', team: 'investment', model: '...', tokensIn: 100, tokensOut: 50, ... });
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

// 모델별 단가 ($ per 1M tokens)
const PRICING = {
  'claude-sonnet-4-6':                          { input: 3.00,  output: 15.00,  free: false },
  'claude-opus-4-6':                            { input: 15.00, output: 75.00,  free: false },
  'claude-haiku-4-5-20251001':                  { input: 1.00,  output: 5.00,   free: false },
  'meta-llama/llama-4-scout-17b-16e-instruct':  { input: 0,     output: 0,      free: true  },
  'google-gemini-cli/gemini-2.5-flash':         { input: 0,     output: 0,      free: true  },
  'gemini-2.5-flash':                           { input: 0,     output: 0,      free: true  },
  'groq/llama-3.1-8b-instant':                  { input: 0,     output: 0,      free: true  },
};

let _db = null;

function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

/**
 * 토큰 사용 기록
 * @param {object} opts
 * @param {string} opts.bot       봇명 (archer, luna, jason, 제이...)
 * @param {string} opts.team      팀명 (claude|investment|orchestrator|reservation)
 * @param {string} opts.model     모델 ID
 * @param {string} opts.provider  anthropic|groq|google|openclaw
 * @param {string} opts.taskType  업무 유형 (tech_analysis|trade_signal|command_parse|report...)
 * @param {number} opts.tokensIn  입력 토큰
 * @param {number} opts.tokensOut 출력 토큰
 * @param {number} [opts.costUsd] 비용 (미제공 시 단가표로 계산)
 */
function trackTokens({ bot, team, model, provider, taskType = 'unknown', tokensIn = 0, tokensOut = 0, costUsd }) {
  try {
    const p       = PRICING[model] || { input: 0, output: 0, free: false };
    const isFree  = p.free || provider === 'groq' || provider === 'google';
    const cost    = costUsd !== undefined ? costUsd
                  : ((tokensIn * p.input) + (tokensOut * p.output)) / 1_000_000;

    // KST 날짜
    const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().split('T')[0];

    getDb().prepare(`
      INSERT INTO token_usage
        (bot_name, team, model, provider, is_free, task_type, tokens_in, tokens_out, cost_usd, date_kst)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(bot, team, model, provider, isFree ? 1 : 0, taskType, tokensIn, tokensOut, cost, kstDate);
  } catch (e) {
    // 추적 실패는 무음 처리 — 본 기능 방해 안 함
    console.warn(`[token-tracker] 기록 실패 (${bot}): ${e.message}`);
  }
}

/**
 * 일별 토큰 사용 요약
 * @param {string} [dateKst] 날짜 (미제공 시 오늘)
 * @returns {object[]} 봇별 집계
 */
function getDailySummary(dateKst) {
  const date = dateKst || new Date(Date.now() + 9 * 3600 * 1000).toISOString().split('T')[0];
  return getDb().prepare(`
    SELECT
      bot_name,
      team,
      model,
      provider,
      is_free,
      task_type,
      SUM(tokens_in)  AS total_in,
      SUM(tokens_out) AS total_out,
      SUM(tokens_in + tokens_out) AS total_tokens,
      SUM(cost_usd)   AS total_cost,
      COUNT(*)        AS call_count
    FROM token_usage
    WHERE date_kst = ?
    GROUP BY bot_name, model, task_type
    ORDER BY total_tokens DESC
  `).all(date);
}

/**
 * 월별 요약
 * @param {string} [monthKst] 'YYYY-MM' (미제공 시 이번 달)
 */
function getMonthlySummary(monthKst) {
  const month = monthKst || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
  return getDb().prepare(`
    SELECT
      bot_name,
      team,
      model,
      provider,
      is_free,
      SUM(tokens_in + tokens_out) AS total_tokens,
      SUM(cost_usd)               AS total_cost,
      COUNT(*)                    AS call_count
    FROM token_usage
    WHERE date_kst LIKE ?
    GROUP BY bot_name, model
    ORDER BY total_cost DESC, total_tokens DESC
  `).all(`${month}%`);
}

/**
 * /cost 명령용 텍스트 생성
 */
function buildCostReport() {
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().split('T')[0];
  const month = today.slice(0, 7);
  const daily  = getDailySummary(today);
  const monthly = getMonthlySummary(month);

  // 오늘 유료 비용
  const todayCostUsd = daily.reduce((s, r) => s + (r.total_cost || 0), 0);
  const todayTokens  = daily.reduce((s, r) => s + (r.total_tokens || 0), 0);

  // 이번 달 유료 비용
  const monthCostUsd = monthly.reduce((s, r) => s + (r.total_cost || 0), 0);
  const monthTokens  = monthly.reduce((s, r) => s + (r.total_tokens || 0), 0);

  const lines = [
    `💰 LLM 토큰 리포트`,
    ``,
    `📅 오늘 (${today})`,
    `  총 토큰: ${todayTokens.toLocaleString()}`,
    `  유료 비용: $${todayCostUsd.toFixed(4)}`,
  ];

  if (daily.length > 0) {
    lines.push(``, `  봇별:`);
    for (const r of daily.slice(0, 6)) {
      const tag = r.is_free ? '무료' : `$${(r.total_cost || 0).toFixed(4)}`;
      lines.push(`  • ${r.bot_name} [${r.task_type}] ${r.total_tokens.toLocaleString()}tok (${tag})`);
    }
  }

  lines.push(
    ``,
    `📆 이번 달 (${month})`,
    `  총 토큰: ${monthTokens.toLocaleString()}`,
    `  유료 비용: $${monthCostUsd.toFixed(4)}`,
  );

  if (monthly.length > 0) {
    lines.push(``, `  모델별:`);
    for (const r of monthly.slice(0, 5)) {
      const tag = r.is_free ? '무료' : `$${(r.total_cost || 0).toFixed(4)}`;
      lines.push(`  • ${r.bot_name} (${r.model.split('/').pop()}) ${r.total_tokens.toLocaleString()}tok ${tag}`);
    }
  }

  return lines.join('\n');
}

module.exports = { trackTokens, getDailySummary, getMonthlySummary, buildCostReport };
