#!/usr/bin/env node
'use strict';

const pgPool = require('../../packages/core/lib/pg-pool');
const { parseArgs, collectJayUsage } = require('./lib/jay-usage');

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function pct(part, whole) {
  if (!whole) return '0.0';
  return ((Number(part || 0) / Number(whole || 0)) * 100).toFixed(1);
}

function kstDateDaysAgo(days) {
  const now = Date.now() + 9 * 60 * 60 * 1000;
  return new Date(now - ((days - 1) * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

async function getJayDbStats(days) {
  const fromDate = kstDateDaysAgo(days);
  const [usageResult, historyResult] = await Promise.allSettled([
    pgPool.query('reservation', `
      SELECT
        model,
        request_type,
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE success = 1)::int AS success_calls,
        COUNT(*) FILTER (WHERE success = 0)::int AS failed_calls,
        COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
        COALESCE(AVG(latency_ms), 0)::float AS avg_latency_ms
      FROM llm_usage_log
      WHERE team = 'orchestrator'
        AND bot = 'jay'
        AND created_at::date >= $1::date
      GROUP BY model, request_type
      ORDER BY total_tokens DESC, calls DESC
    `, [fromDate]),
    pgPool.query('claude', `
      SELECT
        parse_source,
        COUNT(*)::int AS count
      FROM command_history
      WHERE created_at::date >= $1::date
      GROUP BY parse_source
      ORDER BY count DESC
    `, [fromDate]),
  ]);

  const errors = {};
  const rows = usageResult.status === 'fulfilled'
    ? usageResult.value
    : [];
  const history = historyResult.status === 'fulfilled'
    ? historyResult.value
    : [];

  if (usageResult.status !== 'fulfilled') {
    errors.llmUsage = usageResult.reason?.stack || usageResult.reason?.message || String(usageResult.reason);
  }
  if (historyResult.status !== 'fulfilled') {
    errors.parseHistory = historyResult.reason?.stack || historyResult.reason?.message || String(historyResult.reason);
  }

  return {
    rows,
    history,
    errors,
  };
}

function buildRecommendation({ jayUsage, dbStats, dbStatsError }) {
  if (dbStatsError) {
    return [
      '- DB 기반 제이 usage 집계가 실패해 세션 usage만 기준으로 관찰합니다.',
      '- PostgreSQL 접근 권한 또는 자동화 실행 컨텍스트를 먼저 복구하세요.',
    ];
  }

  const usageFailed = Boolean(dbStats.errors?.llmUsage);
  const historyFailed = Boolean(dbStats.errors?.parseHistory);

  if (usageFailed && historyFailed) {
    return [
      '- 제이 DB 집계 소스(llmUsage, parseHistory)가 모두 실패해 세션 usage만 기준으로 관찰합니다.',
      '- PostgreSQL 접근 권한 또는 자동화 실행 컨텍스트를 먼저 복구하세요.',
    ];
  }

  if (usageFailed && !historyFailed) {
    return [
      '- LLM usage DB 집계는 실패했지만 parse history는 확인 가능합니다. llm_usage_log 권한 또는 reservation 스키마 접근을 우선 복구하세요.',
      '- 명령 파싱 통계는 유지되므로, usage 비용·지연 분석만 임시 보류하면 됩니다.',
    ];
  }

  if (!usageFailed && historyFailed) {
    return [
      '- llm_usage_log 집계는 정상이나 parse history가 비어 있습니다. command_history 접근 권한 또는 claude 스키마 상태를 먼저 확인하세요.',
      '- 제이 모델 사용량 판단은 가능하므로 parse source 분석만 임시 보류하면 됩니다.',
    ];
  }

  const commandParseRows = dbStats.rows.filter(row => row.request_type === 'command_parse');
  const chatRows = dbStats.rows.filter(row => row.request_type === 'chat_fallback');
  const openAIParse = commandParseRows.find(row => row.model === 'gpt-5-mini');
  const geminiParse = commandParseRows.find(row => row.model === 'gemini-2.5-flash');
  const ossChat = chatRows.find(row => row.model === 'openai/gpt-oss-20b');
  const geminiChat = chatRows.find(row => row.model === 'gemini-2.5-flash');

  const lines = [];

  if (openAIParse && Number(openAIParse.failed_calls || 0) === 0) {
    lines.push(`- 명령형은 \`gpt-5-mini\` 유지가 적절합니다. 최근 ${fmt(openAIParse.calls)}회에서 실패 기록이 없습니다.`);
  } else if (openAIParse) {
    lines.push(`- 명령형 \`gpt-5-mini\`는 실패 ${fmt(openAIParse.failed_calls)}회가 있어, 실패 원인 점검이 필요합니다.`);
  } else {
    lines.push('- 명령형 OpenAI 사용량이 아직 적어, 며칠 더 관찰이 필요합니다.');
  }

  if (ossChat && (!geminiChat || Number(ossChat.calls) >= Number(geminiChat.calls))) {
    lines.push(`- 대화형은 \`gpt-oss-20b\`가 주력 후보입니다. 최근 ${fmt(ossChat.calls)}회, 평균 ${Math.round(ossChat.avg_latency_ms || 0)}ms입니다.`);
  } else if (geminiChat) {
    lines.push(`- 대화형은 아직 Gemini 폴백 비중이 높아, \`gpt-oss-20b\` 정착 여부를 더 봐야 합니다.`);
  }

  if (Number(jayUsage.total.totalTokens || 0) > 5_000_000) {
    lines.push('- 제이 총 토큰이 높은 날은 세션 누적 컨텍스트 영향이 큽니다. 세션 길이와 캐시 읽기 비중을 함께 점검하는 게 좋습니다.');
  }

  return lines;
}

function buildFallbackLlmUsage(jayUsage) {
  return Object.values(jayUsage.byModel || {})
    .sort((a, b) => Number(b.totalTokens || 0) - Number(a.totalTokens || 0))
    .slice(0, 8)
    .map((row) => ({
      model: row.model,
      request_type: 'session_usage_fallback',
      calls: Number(row.calls || 0),
      success_calls: null,
      failed_calls: null,
      total_tokens: Number(row.totalTokens || 0),
      avg_latency_ms: null,
      provider: row.provider || 'unknown',
    }));
}

async function getJayDbStatsSafe(days) {
  try {
    return {
      ok: true,
      data: await getJayDbStats(days),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.stack || error?.message || String(error),
      data: { rows: [], history: [], errors: {} },
    };
  }
}

async function main() {
  const { days, json } = parseArgs();
  const [jayUsage, dbStatsResult] = await Promise.all([
    Promise.resolve(collectJayUsage({ days })),
    getJayDbStatsSafe(days),
  ]);
  const dbStats = dbStatsResult.data;
  const fallbackLlmUsage = buildFallbackLlmUsage(jayUsage);
  const llmUsage = dbStats.rows.length ? dbStats.rows : fallbackLlmUsage;

  const report = {
    periodDays: days,
    jayUsage,
    dbStatsStatus: dbStatsResult.ok
      ? (Object.keys(dbStats.errors || {}).length ? 'partial' : 'ok')
      : 'degraded',
    dbStatsError: dbStatsResult.ok ? null : dbStatsResult.error,
    dbSourceErrors: dbStats.errors || {},
    llmUsageSource: dbStats.rows.length ? 'db' : 'session_usage_fallback',
    llmUsage: llmUsage,
    parseHistory: dbStats.history,
    recommendations: buildRecommendation({ jayUsage, dbStats, dbStatsError: dbStatsResult.ok ? null : dbStatsResult.error }),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push(`📘 제이 일일 LLM 리뷰 (${days}일)`);
  lines.push('');
  lines.push(`총 호출: ${fmt(jayUsage.total.calls)}회`);
  lines.push(`총 토큰: ${fmt(jayUsage.total.totalTokens)}`);
  lines.push(`입력/출력: ${fmt(jayUsage.total.input)} / ${fmt(jayUsage.total.output)}`);
  lines.push(`캐시 읽기/쓰기: ${fmt(jayUsage.total.cacheRead)} / ${fmt(jayUsage.total.cacheWrite)}`);

  if (report.dbStatsError) {
    lines.push('');
    lines.push('DB 집계 상태: degraded');
    lines.push(`- ${report.dbStatsError}`);
  } else if (report.dbStatsStatus === 'partial') {
    lines.push('');
    lines.push('DB 집계 상태: partial');
    if (report.dbSourceErrors.llmUsage) lines.push('- llmUsage: failed');
    if (report.dbSourceErrors.parseHistory) lines.push('- parseHistory: failed');
  }

  if (dbStats.rows.length) {
    lines.push('');
    lines.push('LLM 경로:');
    for (const row of dbStats.rows.slice(0, 8)) {
      lines.push(`- ${row.request_type || 'unknown'} | ${row.model}: ${fmt(row.calls)}회, 실패 ${fmt(row.failed_calls)}, 평균 ${Math.round(row.avg_latency_ms || 0)}ms`);
    }
  } else if (report.llmUsage.length) {
    lines.push('');
    lines.push('LLM 경로 (session fallback):');
    for (const row of report.llmUsage) {
      lines.push(`- ${row.provider}/${row.model}: ${fmt(row.total_tokens)} tok (${fmt(row.calls)}회)`);
    }
  }

  if (dbStats.history.length) {
    lines.push('');
    lines.push('명령 파싱 소스:');
    for (const row of dbStats.history) {
      lines.push(`- ${row.parse_source}: ${fmt(row.count)}건`);
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
