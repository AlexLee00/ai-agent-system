// @ts-nocheck
#!/usr/bin/env node
'use strict';

const pgPool = require('../../packages/core/lib/pg-pool');

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function kstDateDaysAgo(days) {
  const now = Date.now() + 9 * 60 * 60 * 1000;
  return new Date(now - ((days - 1) * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find(arg => arg.startsWith('--days='));
  const days = Math.max(1, Number(daysArg?.split('=')[1] || 1));
  return { days, json: argv.includes('--json') };
}

async function getTokenUsage(days) {
  const fromDate = kstDateDaysAgo(days);
  return pgPool.query('claude', `
    SELECT
      provider,
      model,
      SUM(tokens_in + tokens_out)::bigint AS total_tokens,
      SUM(cost_usd)::float AS total_cost,
      COUNT(*)::int AS calls,
      COALESCE(AVG(duration_ms), 0)::float AS avg_latency_ms
    FROM token_usage
    WHERE date_kst >= $1
    GROUP BY provider, model
    ORDER BY total_tokens DESC, calls DESC
  `, [fromDate]);
}

async function getQualityUsage(days) {
  const fromDate = kstDateDaysAgo(days);
  return pgPool.query('reservation', `
    SELECT
      team,
      bot,
      model,
      request_type,
      COUNT(*)::int AS calls,
      COUNT(*) FILTER (WHERE success = 1)::int AS success_calls,
      COUNT(*) FILTER (WHERE success = 0)::int AS failed_calls,
      COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
      COALESCE(SUM(cost_usd), 0)::float AS total_cost,
      COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms
    FROM llm_usage_log
    WHERE created_at::date >= $1::date
    GROUP BY team, bot, model, request_type
    ORDER BY total_tokens DESC, calls DESC
  `, [fromDate]);
}

function buildRecommendations(rows) {
  const modelAgg = new Map();
  for (const row of rows) {
    const key = row.model;
    if (!modelAgg.has(key)) {
      modelAgg.set(key, {
        model: key,
        calls: 0,
        failed: 0,
        latencySum: 0,
        latencyCalls: 0,
      });
    }
    const target = modelAgg.get(key);
    target.calls += Number(row.calls || 0);
    target.failed += Number(row.failed_calls || 0);
    if (Number(row.avg_latency_ms || 0) > 0) {
      target.latencySum += Number(row.avg_latency_ms || 0) * Number(row.calls || 0);
      target.latencyCalls += Number(row.calls || 0);
    }
  }

  const results = [];
  for (const item of modelAgg.values()) {
    const avgLatency = item.latencyCalls ? item.latencySum / item.latencyCalls : 0;
    const failRate = item.calls ? (item.failed / item.calls) * 100 : 0;
    if (failRate >= 10) {
      results.push(`- \`${item.model}\`은 실패율 ${failRate.toFixed(1)}%로 높아, 폴백 위치나 프롬프트를 점검하는 게 좋습니다.`);
    } else if (avgLatency > 5000) {
      results.push(`- \`${item.model}\`은 평균 ${Math.round(avgLatency)}ms로 느린 편이라, 지연 민감 경로에서는 우선순위를 낮추는 게 좋습니다.`);
    }
  }

  if (!results.length) {
    results.push('- 오늘 기준으로는 치명적인 실패율/지연 모델이 두드러지지 않습니다. 비용 대비 품질 튜닝 위주로 보면 됩니다.');
  }

  return results;
}

async function main() {
  const { days, json } = parseArgs();
  const [tokenRows, qualityRows] = await Promise.all([
    getTokenUsage(days),
    getQualityUsage(days),
  ]);

  const report = {
    periodDays: days,
    tokenUsage: tokenRows,
    qualityUsage: qualityRows,
    recommendations: buildRecommendations(qualityRows),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`📗 전체 LLM 모델 일일 리뷰 (${days}일)`);
  lines.push('');

  if (tokenRows.length) {
    lines.push('사용량 상위 모델:');
    for (const row of tokenRows.slice(0, 10)) {
      lines.push(`- ${row.provider}/${row.model}: ${fmt(row.total_tokens)} tok, ${fmt(row.calls)}회, 평균 ${Math.round(row.avg_latency_ms || 0)}ms`);
    }
  }

  if (qualityRows.length) {
    lines.push('');
    lines.push('품질/성공률 상위 점검:');
    for (const row of qualityRows.slice(0, 10)) {
      lines.push(`- ${row.team}/${row.bot} ${row.model} [${row.request_type || 'unknown'}]: 실패 ${fmt(row.failed_calls)} / ${fmt(row.calls)}, 평균 ${Math.round(row.avg_latency_ms || 0)}ms`);
    }
  }

  lines.push('');
  lines.push('추천:');
  for (const line of report.recommendations) lines.push(line);

  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error) => {
  process.stderr.write(`❌ ${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
