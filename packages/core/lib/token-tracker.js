'use strict';
const kst = require('./kst');

/**
 * lib/token-tracker.js — 전체 봇 LLM 토큰 사용 통합 추적
 *
 * PostgreSQL jay.claude 스키마 token_usage 테이블에 기록.
 * 무료(Groq, Gemini) / 유료(Anthropic) 모두 기록 — 분석용.
 *
 * 사용법:
 *   const { trackTokens, getDailySummary } = require('./token-tracker');
 *   await trackTokens({ bot: 'luna', team: 'investment', model: '...', tokensIn: 100, tokensOut: 50, ... });
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';

// 모델별 단가 ($ per 1M tokens)
const PRICING = {
  'claude-sonnet-4-6':                          { input: 3.00,  output: 15.00,  free: false },
  'claude-opus-4-6':                            { input: 15.00, output: 75.00,  free: false },
  'claude-haiku-4-5-20251001':                  { input: 1.00,  output: 5.00,   free: false },
  'meta-llama/llama-4-scout-17b-16e-instruct':  { input: 0,     output: 0,      free: true  },
  'google-gemini-cli/gemini-2.5-flash':         { input: 0,     output: 0,      free: true  },
  'gemini-2.5-flash':                           { input: 0,     output: 0,      free: true  },
  'groq/llama-3.1-8b-instant':                  { input: 0,     output: 0,      free: true  },
  'gpt-4o':                                     { input: 2.50,  output: 10.00,  free: false },
  'gpt-4o-mini':                                { input: 0.15,  output: 0.60,   free: false },
};

/**
 * 토큰 사용 기록
 */
async function trackTokens({ bot, team, model, provider, taskType = 'unknown', tokensIn = 0, tokensOut = 0, durationMs = 0, costUsd }) {
  try {
    const p       = PRICING[model] || { input: 0, output: 0, free: false };
    const isFree  = p.free || provider === 'groq' || provider === 'google';
    const cost    = costUsd !== undefined ? costUsd
                  : ((tokensIn * p.input) + (tokensOut * p.output)) / 1_000_000;

    const kstDate = kst.today();

    await pgPool.run(SCHEMA, `
      INSERT INTO token_usage
        (bot_name, team, model, provider, is_free, task_type, tokens_in, tokens_out, cost_usd, duration_ms, date_kst)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [bot, team, model, provider, isFree ? 1 : 0, taskType, tokensIn, tokensOut, cost, durationMs, kstDate]);
  } catch (e) {
    console.warn(`[token-tracker] 기록 실패 (${bot}): ${e.message}`);
  }
}

/**
 * 일별 토큰 사용 요약
 */
async function getDailySummary(dateKst) {
  const date = dateKst || kst.today();
  return pgPool.query(SCHEMA, `
    SELECT
      bot_name, team, model, provider, is_free, task_type,
      SUM(tokens_in)::integer              AS total_in,
      SUM(tokens_out)::integer             AS total_out,
      SUM(tokens_in + tokens_out)::integer AS total_tokens,
      SUM(cost_usd)::float                 AS total_cost,
      COUNT(*)::integer                    AS call_count
    FROM token_usage
    WHERE date_kst = $1
    GROUP BY bot_name, team, model, provider, is_free, task_type
    ORDER BY total_tokens DESC
  `, [date]);
}

/**
 * 월별 요약
 */
async function getMonthlySummary(monthKst) {
  const month = monthKst || kst.today().slice(0, 7);
  return pgPool.query(SCHEMA, `
    SELECT
      bot_name, team, model, provider, is_free,
      SUM(tokens_in + tokens_out)::integer AS total_tokens,
      SUM(cost_usd)::float                 AS total_cost,
      COUNT(*)::integer                    AS call_count
    FROM token_usage
    WHERE date_kst LIKE $1
    GROUP BY bot_name, team, model, provider, is_free
    ORDER BY total_cost DESC, total_tokens DESC
  `, [`${month}%`]);
}

/**
 * /cost 명령용 텍스트 생성
 */
async function buildCostReport() {
  const today  = kst.today();
  const month  = today.slice(0, 7);
  const daily  = await getDailySummary(today);
  const monthly = await getMonthlySummary(month);

  const todayCostUsd = daily.reduce((s, r)   => s + (parseFloat(r.total_cost)   || 0), 0);
  const todayTokens  = daily.reduce((s, r)   => s + (parseInt(r.total_tokens)   || 0), 0);
  const monthCostUsd = monthly.reduce((s, r) => s + (parseFloat(r.total_cost)   || 0), 0);
  const monthTokens  = monthly.reduce((s, r) => s + (parseInt(r.total_tokens)   || 0), 0);

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
      const tag = r.is_free ? '무료' : `$${(parseFloat(r.total_cost) || 0).toFixed(4)}`;
      lines.push(`  • ${r.bot_name} [${r.task_type}] ${parseInt(r.total_tokens).toLocaleString()}tok (${tag})`);
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
      const tag = r.is_free ? '무료' : `$${(parseFloat(r.total_cost) || 0).toFixed(4)}`;
      lines.push(`  • ${r.bot_name} (${r.model.split('/').pop()}) ${parseInt(r.total_tokens).toLocaleString()}tok ${tag}`);
    }
  }

  return lines.join('\n');
}

module.exports = { trackTokens, getDailySummary, getMonthlySummary, buildCostReport };
