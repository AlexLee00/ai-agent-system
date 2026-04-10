// @ts-nocheck
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const pgPool = require('../../packages/core/lib/pg-pool');
const { parseArgs, collectJayUsage } = require('./lib/jay-usage');

const SNAPSHOT_PATH = path.join(__dirname, '..', '..', 'tmp', 'jay-llm-daily-review-db-snapshot.json');

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

function classifySourceError(errorText) {
  const text = String(errorText || '').toLowerCase();
  if (!text) return 'unknown_error';
  if (text.includes('eperm')) return 'sandbox_restricted';
  if (text.includes('permission denied')) return 'permission_denied';
  if (text.includes('econnrefused') || text.includes('connection refused')) return 'db_unreachable';
  if (text.includes('timeout')) return 'db_timeout';
  return 'db_failed';
}

function ensureSnapshotDir() {
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
}

function persistDbSnapshot(days, data) {
  try {
    ensureSnapshotDir();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
      capturedAt: new Date().toISOString(),
      periodDays: days,
      data,
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

function loadDbSnapshot(days) {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return null;
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null;
    return {
      capturedAt: parsed.capturedAt || null,
      periodDays: Number(parsed.periodDays || days),
      stale: Number(parsed.periodDays || days) !== Number(days),
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

function buildDbSnapshotAgeHours(capturedAt) {
  const ts = new Date(capturedAt || '').getTime();
  if (!Number.isFinite(ts)) return null;
  return Number(((Date.now() - ts) / (1000 * 60 * 60)).toFixed(1));
}

function buildFreshnessMeta({ dbStatsStatus, dbSource, dbSnapshotFallback, dbSnapshotMeta, dbStatsError }) {
  if (dbStatsError || dbSource === 'degraded') {
    return {
      level: 'degraded',
      trust: 'low',
      summary: 'DB 기반 집계를 읽지 못해 degraded 상태입니다.',
      stale: true,
    };
  }

  if (dbSnapshotFallback) {
    const ageHours = Number(dbSnapshotMeta?.ageHours);
    const isStale = Boolean(dbSnapshotMeta?.stale) || (Number.isFinite(ageHours) && ageHours >= 6);
    return {
      level: isStale ? 'snapshot_stale' : 'snapshot_fallback',
      trust: isStale ? 'low' : 'medium',
      summary: isStale
        ? `stale snapshot fallback (${dbSnapshotMeta?.capturedAt || 'capturedAt unknown'})`
        : `snapshot fallback (${dbSnapshotMeta?.capturedAt || 'capturedAt unknown'})`,
      stale: isStale,
    };
  }

  if (dbStatsStatus === 'partial') {
    return {
      level: 'partial_live',
      trust: 'medium',
      summary: '일부 DB source가 실패한 partial live 상태입니다.',
      stale: false,
    };
  }

  return {
    level: 'live',
    trust: 'high',
    summary: 'live DB 기반 집계입니다.',
    stale: false,
  };
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
    errorCodes: {
      llmUsage: errors.llmUsage ? classifySourceError(errors.llmUsage) : 'ok',
      parseHistory: errors.parseHistory ? classifySourceError(errors.parseHistory) : 'ok',
    },
  };
}

function buildRecommendation({ jayUsage, dbStats, dbStatsError, dbAccessError, snapshotFallback }) {
  if (dbStatsError) {
    return [
      '- DB 기반 제이 usage 집계가 실패해 세션 usage만 기준으로 관찰합니다.',
      '- PostgreSQL 접근 권한 또는 자동화 실행 컨텍스트를 먼저 복구하세요.',
    ];
  }

  if (snapshotFallback) {
    return [
      '- live DB query는 실패했지만 최근 snapshot을 읽어 제이 usage/parse history를 유지했습니다.',
      `- 현재 실패 상태는 \`${classifySourceError(dbAccessError)}\`로 보이며, 운영 런타임 DB 접근을 복구하면 snapshot fallback 의존을 줄일 수 있습니다.`,
    ];
  }

  const usageFailed = Boolean(dbStats.errors?.llmUsage);
  const historyFailed = Boolean(dbStats.errors?.parseHistory);

  if (usageFailed && historyFailed) {
    const llmUsageCode = dbStats.errorCodes?.llmUsage || 'db_failed';
    const parseHistoryCode = dbStats.errorCodes?.parseHistory || 'db_failed';
    return [
      `- 제이 DB 집계 소스(llmUsage=${llmUsageCode}, parseHistory=${parseHistoryCode})가 모두 실패해 세션 usage만 기준으로 관찰합니다.`,
      llmUsageCode === 'sandbox_restricted' && parseHistoryCode === 'sandbox_restricted'
        ? '- 현재 실행 컨텍스트 제한 가능성이 커서, 운영 런타임 또는 샌드박스 밖 실행 결과를 함께 확인하세요.'
        : '- PostgreSQL 접근 권한 또는 자동화 실행 컨텍스트를 먼저 복구하세요.',
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
    const data = await getJayDbStats(days);
    const allDbSourcesFailed = Boolean(data.errors?.llmUsage) && Boolean(data.errors?.parseHistory);
    if (allDbSourcesFailed) {
      const snapshot = loadDbSnapshot(days);
      if (snapshot) {
        return {
          ok: true,
          data: snapshot.data,
          error: data.errors.llmUsage || data.errors.parseHistory,
          source: 'snapshot_fallback',
          snapshotPersisted: false,
          snapshotFallback: true,
          snapshotMeta: {
            capturedAt: snapshot.capturedAt,
            ageHours: buildDbSnapshotAgeHours(snapshot.capturedAt),
            stale: snapshot.stale,
          },
        };
      }
    }
    const persisted = persistDbSnapshot(days, data);
    return {
      ok: true,
      data,
      source: 'db',
      snapshotPersisted: persisted,
      snapshotFallback: false,
      snapshotMeta: null,
    };
  } catch (error) {
    const snapshot = loadDbSnapshot(days);
    if (snapshot) {
      return {
        ok: true,
        data: snapshot.data,
        error: error?.stack || error?.message || String(error),
        source: 'snapshot_fallback',
        snapshotPersisted: false,
        snapshotFallback: true,
        snapshotMeta: {
          capturedAt: snapshot.capturedAt,
          ageHours: buildDbSnapshotAgeHours(snapshot.capturedAt),
          stale: snapshot.stale,
        },
      };
    }
    return {
      ok: false,
      error: error?.stack || error?.message || String(error),
      data: { rows: [], history: [], errors: {} },
      source: 'degraded',
      snapshotPersisted: false,
      snapshotFallback: false,
      snapshotMeta: null,
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
    dbAccessError: dbStatsResult.ok && dbStatsResult.snapshotFallback ? dbStatsResult.error : null,
    dbSource: dbStatsResult.source || 'degraded',
    dbSnapshotFallback: Boolean(dbStatsResult.snapshotFallback),
    dbSnapshotPersisted: Boolean(dbStatsResult.snapshotPersisted),
    dbSnapshotMeta: dbStatsResult.snapshotMeta || null,
    dbSourceErrors: dbStats.errors || {},
    dbSourceStatus: dbStats.errorCodes || {},
    llmUsageSource: dbStats.rows.length ? 'db' : 'session_usage_fallback',
    llmUsage: llmUsage,
    parseHistory: dbStats.history,
    recommendations: buildRecommendation({
      jayUsage,
      dbStats,
      dbStatsError: dbStatsResult.ok ? null : dbStatsResult.error,
      dbAccessError: dbStatsResult.ok && dbStatsResult.snapshotFallback ? dbStatsResult.error : null,
      snapshotFallback: Boolean(dbStatsResult.snapshotFallback),
    }),
  };
  report.freshness = buildFreshnessMeta({
    dbStatsStatus: report.dbStatsStatus,
    dbSource: report.dbSource,
    dbSnapshotFallback: report.dbSnapshotFallback,
    dbSnapshotMeta: report.dbSnapshotMeta,
    dbStatsError: report.dbStatsError,
  });

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
  lines.push(`운영 신뢰도: ${report.freshness.trust} (${report.freshness.summary})`);

  if (report.dbStatsError) {
    lines.push('');
    lines.push('DB 집계 상태: degraded');
    lines.push(`- ${report.dbStatsError}`);
  } else if (report.dbSnapshotFallback) {
    lines.push('');
    lines.push('DB 집계 상태: partial (snapshot_fallback)');
    if (report.dbAccessError) lines.push(`- live query 실패: ${classifySourceError(report.dbAccessError)}`);
    if (report.dbSnapshotMeta?.capturedAt) lines.push(`- snapshot capturedAt: ${report.dbSnapshotMeta.capturedAt}`);
    if (report.dbSnapshotMeta?.ageHours != null) lines.push(`- snapshot age: ${report.dbSnapshotMeta.ageHours}h`);
    if (report.dbSnapshotMeta?.stale) lines.push('- snapshot 기간이 현재 요청 일수와 달라 해석 시 주의가 필요합니다.');
    if (report.freshness.stale) lines.push('- 현재 결과는 stale snapshot 기반이므로 live 운영 판단보다 참고용으로 해석해야 합니다.');
  } else if (report.dbStatsStatus === 'partial') {
    lines.push('');
    lines.push('DB 집계 상태: partial');
    if (report.dbSourceErrors.llmUsage) lines.push(`- llmUsage: ${report.dbSourceStatus.llmUsage || 'failed'}`);
    if (report.dbSourceErrors.parseHistory) lines.push(`- parseHistory: ${report.dbSourceStatus.parseHistory || 'failed'}`);
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
