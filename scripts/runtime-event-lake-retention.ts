#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool.ts'));
const kst = require(path.join(PROJECT_ROOT, 'packages/core/lib/kst.js'));

export const DEFAULT_POLICY = Object.freeze({
  barDays: 30,
  otherDays: 90,
  batchSize: 10_000,
  batchSleepMs: 500,
  archiveBatchSize: 5_000,
  archiveDir: '/Volumes/DATA/migrated/archives/event_lake',
});

const EVENT_PREFIX_SQL = `
  CASE
    WHEN event_type LIKE 'luna.tv.bar.%' THEN 'luna.tv.bar.*'
    WHEN event_type LIKE 'luna.%' THEN 'luna.*'
    WHEN position('.' in event_type) > 0 THEN split_part(event_type, '.', 1) || '.*'
    WHEN position('_' in event_type) > 0 THEN split_part(event_type, '_', 1) || '_*'
    ELSE event_type
  END
`;

const RETENTION_CONDITION_SQL = `
  (
    (event_type LIKE 'luna.tv.bar.%' AND created_at < $1::timestamptz)
    OR
    (event_type NOT LIKE 'luna.tv.bar.%' AND created_at < $2::timestamptz)
  )
`;

const ARCHIVE_COLUMNS = [
  'id',
  'event_type',
  'team',
  'bot_name',
  'severity',
  'trace_id',
  'title',
  'message',
  'tags',
  'metadata',
  'feedback_score',
  'feedback',
  'created_at',
  'updated_at',
];

export const QUERY_AUDIT_TARGETS = Object.freeze([
  {
    name: 'luna_scout',
    role: 'write_only_error_trail',
    file: 'bots/investment/team/scout.ts',
    lines: '316-322, 383-400',
    timeWindow: 'no event_lake read window; initializes/writes scout_error only on non-dry failure',
    retentionFloorDays: 30,
  },
  {
    name: 'luna_bottleneck',
    role: 'operational report fan-in',
    file: 'bots/investment/scripts/runtime-luna-bottleneck-autonomy-operator.ts',
    lines: '17, 494-515',
    timeWindow: 'default 6h operator window; delegated reports include 6h/24h/7d windows',
    retentionFloorDays: 30,
  },
  {
    name: 'luna_health',
    role: 'Elixir-owned runtime health',
    file: 'bots/investment/scripts/health-report.ts',
    lines: '300-319',
    timeWindow: "6h over port_agent_started/run/completed/failed for investment bots",
    retentionFloorDays: 30,
  },
  {
    name: 'luna_kis_overseas_funnel_trace',
    role: 'overseas funnel trace',
    file: 'bots/investment/scripts/runtime-kis-overseas-funnel-trace.ts',
    lines: '8, 171-186',
    timeWindow: 'default 168h over Luna/investment/kis_overseas event_lake rows',
    retentionFloorDays: 30,
  },
  {
    name: 'claude_commander',
    role: 'legacy approval/rejection audit writes',
    file: 'bots/claude/src/claude-commander.ts',
    lines: '771-800',
    timeWindow: 'no event_lake read window in commander; writes codex_approval/rejection audit events',
    retentionFloorDays: 90,
  },
]);

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function intArg(name, fallback, argv = process.argv.slice(2)) {
  const value = Number.parseInt(String(argValue(name, '', argv)), 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function daysAgoIso(days, now = new Date()) {
  return new Date(now.getTime() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
}

export function normalizePolicy(input = {}) {
  return {
    barDays: positiveInt(input.barDays ?? process.env.EVENT_LAKE_BAR_RETENTION_DAYS, DEFAULT_POLICY.barDays),
    otherDays: positiveInt(input.otherDays ?? process.env.EVENT_LAKE_OTHER_RETENTION_DAYS, DEFAULT_POLICY.otherDays),
    batchSize: positiveInt(input.batchSize ?? process.env.EVENT_LAKE_RETENTION_BATCH_SIZE, DEFAULT_POLICY.batchSize),
    batchSleepMs: positiveInt(input.batchSleepMs ?? process.env.EVENT_LAKE_RETENTION_BATCH_SLEEP_MS, DEFAULT_POLICY.batchSleepMs),
    archiveBatchSize: positiveInt(input.archiveBatchSize ?? process.env.EVENT_LAKE_ARCHIVE_BATCH_SIZE, DEFAULT_POLICY.archiveBatchSize),
    archiveDir: String(input.archiveDir || process.env.EVENT_LAKE_ARCHIVE_DIR || DEFAULT_POLICY.archiveDir),
  };
}

export function buildRetentionCutoffs(policy = DEFAULT_POLICY, now = new Date()) {
  return {
    barCutoff: daysAgoIso(policy.barDays, now),
    otherCutoff: daysAgoIso(policy.otherDays, now),
  };
}

export function classifyEventType(eventType = '') {
  return String(eventType || '').startsWith('luna.tv.bar.') ? 'bar' : 'other';
}

export function isRetentionCandidate(row = {}, policy = DEFAULT_POLICY, now = new Date()) {
  const createdAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  if (!Number.isFinite(createdAt)) return false;
  const ageDays = (now.getTime() - createdAt) / (24 * 60 * 60 * 1000);
  return classifyEventType(row.event_type) === 'bar'
    ? ageDays > policy.barDays
    : ageDays > policy.otherDays;
}

function monthRange(month) {
  if (!/^[0-9]{4}-[0-9]{2}$/.test(String(month || ''))) {
    throw new Error(`invalid_archive_month: ${month || 'missing'}`);
  }
  const start = new Date(`${month}-01T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime())) throw new Error(`invalid_archive_month: ${month}`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString(), month };
}

function csvCell(value) {
  if (value == null) return '';
  const normalized = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function csvRow(row) {
  return ARCHIVE_COLUMNS.map((column) => csvCell(row[column])).join(',');
}

function telemetryPath(env = process.env) {
  return env.EVENT_LAKE_RETENTION_TELEMETRY_PATH
    || path.join(os.homedir(), '.ai-agent-system/workspace/event-lake-retention/retention-telemetry.jsonl');
}

function appendTelemetry(payload, env = process.env) {
  try {
    const target = telemetryPath(env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(payload)}\n`, 'utf8');
    return { ok: true, path: target };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function sleep(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectDistribution({ queryReadonly = pgPool.queryReadonly, limit = 30, dailyDays = 7 } = {}) {
  const relationRows = await queryReadonly('agent', `
      SELECT
        pg_total_relation_size('agent.event_lake')::bigint AS total_bytes,
        pg_relation_size('agent.event_lake')::bigint AS heap_bytes,
        (pg_total_relation_size('agent.event_lake') - pg_relation_size('agent.event_lake'))::bigint AS index_bytes
    `, []);
  const totalRows = await queryReadonly('agent', `SELECT COUNT(*)::bigint AS total_rows FROM agent.event_lake`, []);
  const prefixRows = await queryReadonly('agent', `
      SELECT
        ${EVENT_PREFIX_SQL} AS prefix,
        COUNT(*)::bigint AS rows,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::bigint AS rows_24h,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::bigint AS rows_7d,
        MIN(created_at) AS oldest_at,
        MAX(created_at) AS newest_at
      FROM agent.event_lake
      GROUP BY 1
      ORDER BY rows DESC
      LIMIT $1
    `, [limit]);
  const dailyRows = await queryReadonly('agent', `
      SELECT
        date_trunc('day', created_at)::date AS day,
        CASE WHEN event_type LIKE 'luna.tv.bar.%' THEN 'bar' ELSE 'other' END AS kind,
        COUNT(*)::bigint AS rows
      FROM agent.event_lake
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY 1, 2
      ORDER BY day DESC, kind
    `, [dailyDays]);

  const relation = relationRows[0] || {};
  const total = toNumber(totalRows[0]?.total_rows);
  const totalBytes = toNumber(relation.total_bytes);
  const prefixes = prefixRows.map((row) => {
    const rows = toNumber(row.rows);
    return {
      prefix: row.prefix,
      rows,
      rowShare: total > 0 ? rows / total : 0,
      estimatedBytes: total > 0 ? Math.round(totalBytes * (rows / total)) : 0,
      rows24h: toNumber(row.rows_24h),
      rows7d: toNumber(row.rows_7d),
      oldestAt: row.oldest_at,
      newestAt: row.newest_at,
    };
  });

  return {
    totalRows: total,
    relationBytes: {
      total: totalBytes,
      heap: toNumber(relation.heap_bytes),
      indexes: toNumber(relation.index_bytes),
      note: 'prefix bytes are estimated by row share; total/index bytes come from pg_total_relation_size',
    },
    prefixes,
    dailyIngest: dailyRows.map((row) => ({ day: row.day, kind: row.kind, rows: toNumber(row.rows) })),
  };
}

export async function collectRetentionCounts({ queryReadonly = pgPool.queryReadonly, policy = DEFAULT_POLICY, now = new Date() } = {}) {
  const cutoffs = buildRetentionCutoffs(policy, now);
  const rows = await queryReadonly('agent', `
    SELECT
      CASE WHEN event_type LIKE 'luna.tv.bar.%' THEN 'bar' ELSE 'other' END AS kind,
      COUNT(*)::bigint AS rows,
      MIN(created_at) AS oldest_at,
      MAX(created_at) AS newest_at
    FROM agent.event_lake
    WHERE ${RETENTION_CONDITION_SQL}
    GROUP BY 1
    ORDER BY rows DESC
  `, [cutoffs.barCutoff, cutoffs.otherCutoff]);
  return {
    policy: {
      barDays: policy.barDays,
      otherDays: policy.otherDays,
      barCutoff: cutoffs.barCutoff,
      otherCutoff: cutoffs.otherCutoff,
    },
    candidates: rows.map((row) => ({
      kind: row.kind,
      rows: toNumber(row.rows),
      oldestAt: row.oldest_at,
      newestAt: row.newest_at,
    })),
  };
}

async function findOldestCandidateMonth({ queryReadonly, policy, now }) {
  const cutoffs = buildRetentionCutoffs(policy, now);
  const rows = await queryReadonly('agent', `
    SELECT to_char(date_trunc('month', MIN(created_at)), 'YYYY-MM') AS month
    FROM agent.event_lake
    WHERE ${RETENTION_CONDITION_SQL}
  `, [cutoffs.barCutoff, cutoffs.otherCutoff]);
  return rows[0]?.month || null;
}

export async function archiveCandidates({
  queryReadonly = pgPool.queryReadonly,
  policy = DEFAULT_POLICY,
  archiveDir = policy.archiveDir,
  archiveMonth = null,
  archiveLimit = 0,
  overwrite = false,
  now = new Date(),
} = {}) {
  const month = archiveMonth || await findOldestCandidateMonth({ queryReadonly, policy, now });
  if (!month) return { ok: true, skipped: true, reason: 'no_retention_candidates' };

  const range = monthRange(month);
  const cutoffs = buildRetentionCutoffs(policy, now);
  const params = [cutoffs.barCutoff, cutoffs.otherCutoff, range.start, range.end];
  const countRows = await queryReadonly('agent', `
    SELECT COUNT(*)::bigint AS rows
    FROM agent.event_lake
    WHERE ${RETENTION_CONDITION_SQL}
      AND created_at >= $3::timestamptz
      AND created_at < $4::timestamptz
  `, params);
  const totalRows = toNumber(countRows[0]?.rows);
  const expectedRows = archiveLimit > 0 ? Math.min(totalRows, archiveLimit) : totalRows;
  const target = path.join(archiveDir, `${range.month}.csv.gz`);
  const tmp = `${target}.tmp-${process.pid}`;

  if (fs.existsSync(target) && !overwrite) {
    return { ok: false, error: 'archive_exists', path: target, expectedRows, totalRows };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const gzip = zlib.createGzip();
  const output = fs.createWriteStream(tmp);
  gzip.pipe(output);
  gzip.write(`${ARCHIVE_COLUMNS.join(',')}\n`);

  let writtenRows = 0;
  let lastId = 0;
  while (writtenRows < expectedRows) {
    const remaining = expectedRows - writtenRows;
    const batchSize = Math.min(policy.archiveBatchSize, remaining || policy.archiveBatchSize);
    const rows = await queryReadonly('agent', `
      SELECT ${ARCHIVE_COLUMNS.join(', ')}
      FROM agent.event_lake
      WHERE ${RETENTION_CONDITION_SQL}
        AND created_at >= $3::timestamptz
        AND created_at < $4::timestamptz
        AND id > $5::bigint
      ORDER BY id ASC
      LIMIT $6::int
    `, [...params, lastId, batchSize]);

    if (!rows.length) break;
    for (const row of rows) {
      gzip.write(`${csvRow(row)}\n`);
      lastId = Math.max(lastId, toNumber(row.id));
      writtenRows += 1;
    }
  }

  gzip.end();
  await new Promise((resolve, reject) => {
    output.on('finish', resolve);
    output.on('error', reject);
    gzip.on('error', reject);
  });
  fs.renameSync(tmp, target);

  return {
    ok: writtenRows === expectedRows,
    month: range.month,
    range,
    path: target,
    totalRows,
    expectedRows,
    writtenRows,
    limited: archiveLimit > 0,
    bytes: fs.statSync(target).size,
  };
}

export async function applyRetention({
  run = pgPool.run,
  policy = DEFAULT_POLICY,
  apply = false,
  env = process.env,
  now = new Date(),
} = {}) {
  if (!apply) return { ok: true, skipped: true, reason: 'dry_run_default', deletedRows: 0 };
  if (env.EVENT_LAKE_RETENTION_ENABLED !== 'true') {
    return { ok: true, skipped: true, reason: 'EVENT_LAKE_RETENTION_ENABLED_not_true', deletedRows: 0 };
  }

  const cutoffs = buildRetentionCutoffs(policy, now);
  let deletedRows = 0;
  let batches = 0;
  while (true) {
    const result = await run('agent', `
      WITH target AS (
        SELECT id
        FROM agent.event_lake
        WHERE ${RETENTION_CONDITION_SQL}
        ORDER BY created_at ASC, id ASC
        LIMIT $3::int
      )
      DELETE FROM agent.event_lake event
      USING target
      WHERE event.id = target.id
      RETURNING event.id
    `, [cutoffs.barCutoff, cutoffs.otherCutoff, policy.batchSize]);
    const rowCount = Number(result?.rowCount || result?.rows?.length || 0);
    if (rowCount <= 0) break;
    deletedRows += rowCount;
    batches += 1;
    await sleep(policy.batchSleepMs);
  }

  return {
    ok: true,
    skipped: false,
    deletedRows,
    batches,
    vacuumAdvice: 'Run VACUUM (ANALYZE) agent.event_lake in a separate master-gated maintenance window.',
  };
}

export function renderRetentionMarkdown(result) {
  const lines = [
    '# Event Lake Retention Report',
    '',
    `- Generated: ${result.generatedAtKst || result.generatedAt}`,
    `- Mode: ${result.mode}`,
    `- Policy: tv.bar ${result.policy.barDays}d / other ${result.policy.otherDays}d`,
    `- DELETE executed: ${result.apply?.deletedRows > 0 ? 'YES' : 'NO'}`,
    '',
    '## Distribution',
    '',
    `- Total rows: ${result.distribution?.totalRows ?? 'n/a'}`,
    `- Total relation bytes: ${result.distribution?.relationBytes?.total ?? 'n/a'}`,
    '',
    '| Prefix | Rows | 24h | 7d | Est bytes | Oldest | Newest |',
    '|---|---:|---:|---:|---:|---|---|',
    ...((result.distribution?.prefixes || []).slice(0, 20).map((row) =>
      `| ${row.prefix} | ${row.rows} | ${row.rows24h} | ${row.rows7d} | ${row.estimatedBytes} | ${row.oldestAt || ''} | ${row.newestAt || ''} |`)),
    '',
    '## Retention Candidates',
    '',
    '| Kind | Rows | Oldest | Newest |',
    '|---|---:|---|---|',
    ...((result.retention?.candidates || []).map((row) =>
      `| ${row.kind} | ${row.rows} | ${row.oldestAt || ''} | ${row.newestAt || ''} |`)),
    '',
    '## Query Window Audit',
    '',
    '| Target | Window | Evidence |',
    '|---|---|---|',
    ...QUERY_AUDIT_TARGETS.map((target) =>
      `| ${target.name} | ${target.timeWindow} | ${target.file}:${target.lines} |`),
    '',
    '## Archive',
    '',
    `- ${JSON.stringify(result.archive || { skipped: true })}`,
    '',
    '## Apply',
    '',
    `- ${JSON.stringify(result.apply || { skipped: true })}`,
    '',
  ];
  return lines.join('\n');
}

export async function runEventLakeRetention(options = {}) {
  const startedAt = Date.now();
  const now = options.now || new Date();
  const policy = normalizePolicy(options.policy || {});
  const queryReadonly = options.queryReadonly || pgPool.queryReadonly;
  const run = options.run || pgPool.run;
  const applyRequested = options.apply === true;
  const archiveRequested = options.archive === true;
  const mode = applyRequested ? 'apply' : archiveRequested ? 'archive' : 'dry-run';

  const [distribution, retention] = await Promise.all([
    options.skipDistribution
      ? Promise.resolve({ skipped: true })
      : collectDistribution({ queryReadonly, limit: options.limit || 30, dailyDays: options.dailyDays || 7 }),
    collectRetentionCounts({ queryReadonly, policy, now }),
  ]);

  const archive = archiveRequested
    ? await archiveCandidates({
        queryReadonly,
        policy,
        archiveDir: options.archiveDir || policy.archiveDir,
        archiveMonth: options.archiveMonth || null,
        archiveLimit: options.archiveLimit || 0,
        overwrite: options.archiveOverwrite === true,
        now,
      })
    : { ok: true, skipped: true, reason: 'archive_not_requested' };

  const apply = await applyRetention({
    run,
    policy,
    apply: applyRequested,
    env: options.env || process.env,
    now,
  });

  const result = {
    ok: (archive.ok !== false) && (apply.ok !== false),
    generatedAt: now.toISOString(),
    generatedAtKst: typeof kst.datetimeStr === 'function' ? kst.datetimeStr() : now.toISOString(),
    durationMs: Date.now() - startedAt,
    mode,
    policy,
    distribution,
    retention,
    queryAuditTargets: QUERY_AUDIT_TARGETS,
    sourceAudit: {
      tvBarPublisher: {
        file: 'bots/investment/services/tradingview-ws/src/index.js',
        lines: '838-855',
        topic: 'luna.tv.bar.${symbol}.${timeframe}',
        recommendation: 'move high-frequency OHLCV bars to a dedicated time-series store in a follow-up spec',
      },
    },
    archive,
    apply,
    safety: {
      dryRunDefault: true,
      deleteRequiresApplyAndEnv: true,
      ddlExecuted: false,
      launchctlMutation: false,
    },
  };

  result.telemetry = appendTelemetry({
    type: 'event_lake_retention',
    generatedAt: result.generatedAt,
    mode,
    ok: result.ok,
    retention: retention.candidates,
    archive: {
      skipped: archive.skipped === true,
      month: archive.month,
      expectedRows: archive.expectedRows,
      writtenRows: archive.writtenRows,
    },
    apply: {
      skipped: apply.skipped === true,
      deletedRows: apply.deletedRows || 0,
    },
  }, options.env || process.env);

  result.markdown = renderRetentionMarkdown(result);
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const result = await runEventLakeRetention({
    apply: hasFlag('apply', argv),
    archive: hasFlag('archive', argv),
    archiveMonth: argValue('archive-month', null, argv),
    archiveLimit: intArg('archive-limit', 0, argv),
    archiveDir: argValue('archive-dir', null, argv),
    archiveOverwrite: hasFlag('archive-overwrite', argv),
    skipDistribution: hasFlag('skip-distribution', argv),
    limit: intArg('limit', 30, argv),
    dailyDays: intArg('daily-days', 7, argv),
    policy: {
      barDays: intArg('bar-days', 0, argv) || undefined,
      otherDays: intArg('other-days', 0, argv) || undefined,
      batchSize: intArg('batch-size', 0, argv) || undefined,
      batchSleepMs: intArg('batch-sleep-ms', 0, argv) || undefined,
      archiveBatchSize: intArg('archive-batch-size', 0, argv) || undefined,
    },
  });

  const reportOut = argValue('report-out', null, argv);
  if (reportOut) {
    fs.mkdirSync(path.dirname(path.resolve(reportOut)), { recursive: true });
    fs.writeFileSync(reportOut, result.markdown, 'utf8');
  }

  if (hasFlag('json', argv)) console.log(JSON.stringify({ ...result, markdown: undefined }, null, 2));
  else console.log(result.markdown);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  });
}

export default {
  DEFAULT_POLICY,
  QUERY_AUDIT_TARGETS,
  applyRetention,
  archiveCandidates,
  buildRetentionCutoffs,
  classifyEventType,
  collectDistribution,
  collectRetentionCounts,
  isRetentionCandidate,
  normalizePolicy,
  renderRetentionMarkdown,
  runEventLakeRetention,
};
