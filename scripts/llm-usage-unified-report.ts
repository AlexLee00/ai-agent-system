// @ts-nocheck
'use strict';

const pgPool = require('../packages/core/lib/pg-pool');
const { parseArgs, collectJayUsage } = require('./reviews/lib/jay-usage');

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function cutoffDate(days) {
  const now = Date.now() + 9 * 60 * 60 * 1000;
  return new Date(now - ((days - 1) * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

async function getTokenTrackerSummary(days) {
  const fromDate = cutoffDate(days);
  return pgPool.query('claude', `
    SELECT
      team,
      bot_name AS bot,
      model,
      provider,
      SUM(tokens_in)::bigint AS input_tokens,
      SUM(tokens_out)::bigint AS output_tokens,
      SUM(tokens_in + tokens_out)::bigint AS total_tokens,
      SUM(cost_usd)::float AS total_cost,
      COUNT(*)::int AS calls
    FROM token_usage
    WHERE date_kst >= $1
    GROUP BY team, bot_name, model, provider
    ORDER BY total_tokens DESC
  `, [fromDate]);
}

async function getLlmLoggerSummary(days) {
  const fromDate = cutoffDate(days);
  return pgPool.query('reservation', `
    SELECT
      team,
      bot,
      model,
      request_type,
      SUM(input_tokens)::bigint AS input_tokens,
      SUM(output_tokens)::bigint AS output_tokens,
      SUM(input_tokens + output_tokens)::bigint AS total_tokens,
      SUM(cost_usd)::float AS total_cost,
      COUNT(*)::int AS calls
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model, request_type
    ORDER BY total_tokens DESC
  `, [fromDate]);
}

async function main() {
  const { days, json } = parseArgs();
  const [tokenTrackerRows, llmLoggerRows] = await Promise.all([
    getTokenTrackerSummary(days),
    getLlmLoggerSummary(days),
  ]);
  const jayReport = collectJayUsage({ days });

  const report = {
    periodDays: days,
    tokenTracker: tokenTrackerRows,
    llmLogger: llmLoggerRows,
    jay: jayReport,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`📈 통합 LLM 사용량 리포트 (${days}일)`);
  lines.push('');
  lines.push(`제이(OpenClaw): ${fmt(jayReport.total.totalTokens)} tok / ${fmt(jayReport.total.calls)}회`);

  const tokenTop = tokenTrackerRows.slice(0, 8);
  if (tokenTop.length) {
    lines.push('');
    lines.push('token_usage 상위:');
    for (const row of tokenTop) {
      lines.push(`- ${row.team}/${row.bot} ${row.model}: ${fmt(row.total_tokens)} tok (${fmt(row.calls)}회)`);
    }
  }

  const loggerTop = llmLoggerRows.slice(0, 8);
  if (loggerTop.length) {
    lines.push('');
    lines.push('llm_usage_log 상위:');
    for (const row of loggerTop) {
      lines.push(`- ${row.team}/${row.bot} ${row.model} [${row.request_type || 'unknown'}]: ${fmt(row.total_tokens)} tok (${fmt(row.calls)}회)`);
    }
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
