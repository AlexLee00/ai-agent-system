// @ts-nocheck
'use strict';

const { execSync } = require('child_process');

const kst = require('../../../../packages/core/lib/kst');
const env = require('../../../../packages/core/lib/env');
const hub = require('../../../../packages/core/lib/hub-client');

const ROOT = env.PROJECT_ROOT;

const REPORT_JOBS = [
  {
    key: 'luna',
    label: '루나',
    args: ['bots/investment/scripts/health-report.ts', '--json'],
  },
  {
    key: 'claude',
    label: '클로드',
    args: ['bots/claude/scripts/health-report.ts', '--json'],
  },
  {
    key: 'ska',
    label: '스카',
    args: ['bots/reservation/auto/scheduled/pickko-daily-summary.ts'],
  },
  {
    key: 'common',
    label: '공용',
    args: ['scripts/api-usage-report.ts'],
  },
];

function runLocalNode(args) {
  return execSync(`/opt/homebrew/bin/tsx ${args.map((arg) => JSON.stringify(arg)).join(' ')}`, {
    cwd: ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 120000,
  }).trim();
}

function collectLocal(job) {
  try {
    const stdout = runLocalNode(job.args || []);
    return {
      key: job.key,
      label: job.label,
      ok: true,
      output: stdout || '(출력 없음)',
    };
  } catch (error) {
    console.warn(`[write/report-aggregator] 수집 실패: ${job.key} — ${error.message}`);
    return {
      key: job.key,
      label: job.label,
      ok: false,
      output: String(error.stdout || error.stderr || error.message || '').trim() || '리포트 수집 실패',
    };
  }
}

function firstRowValue(payload, key, fallback = 'N/A') {
  const row = payload?.rows?.[0] || {};
  const value = row?.[key];
  return value == null ? fallback : value;
}

function buildHubSection(key, label, payload, formatter) {
  if (!payload || payload.ok === false || payload.error || payload.reason) {
    return {
      key,
      label,
      ok: false,
      output: payload?.reason || payload?.error || 'OPS Hub 조회 실패',
    };
  }
  return {
    key,
    label,
    ok: true,
    output: formatter(payload),
  };
}

async function collectViaHub() {
  const [lunaPositions, lunaTrades, claudeEvents, skaReservations, opsErrors] = await Promise.all([
    hub.queryOpsDb("select count(*)::int as open_positions from positions where amount > 0", 'investment'),
    hub.queryOpsDb("select count(*)::int as trades_today from trades where executed_at::date = (now() at time zone 'Asia/Seoul')::date", 'investment'),
    hub.queryOpsDb("select count(*)::int as system_events_today from mainbot_queue where created_at::date = (now() at time zone 'Asia/Seoul')::date", 'claude'),
    hub.queryOpsDb("select count(*)::int as reservations_today from reservations where date = to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD')", 'reservation'),
    hub.fetchOpsErrors(180),
  ]);

  return {
    collectedAt: kst.datetimeStr(),
    luna: buildHubSection(
      'luna',
      '루나',
      lunaPositions?.ok === false || lunaTrades?.ok === false
        ? (lunaPositions?.ok === false ? lunaPositions : lunaTrades)
        : { ok: true, rows: [{}] },
      () => `OPS Hub 요약 — open_positions=${firstRowValue(lunaPositions, 'open_positions', 0)}, trades_today=${firstRowValue(lunaTrades, 'trades_today', 0)}`,
    ),
    claude: buildHubSection(
      'claude',
      '클로드',
      claudeEvents,
      () => `OPS Hub 요약 — system_events_today=${firstRowValue(claudeEvents, 'system_events_today', 0)}`,
    ),
    ska: buildHubSection(
      'ska',
      '스카',
      skaReservations,
      () => `OPS Hub 요약 — reservations_today=${firstRowValue(skaReservations, 'reservations_today', 0)}`,
    ),
    common: buildHubSection(
      'common',
      '공용',
      opsErrors,
      () => `OPS Hub 에러 요약 — total_services=${Number(opsErrors?.total_services || 0)}, total_errors=${Number(opsErrors?.total_errors || 0)}`,
    ),
  };
}

async function collectAll() {
  if (env.IS_DEV) {
    return collectViaHub();
  }

  const result = {
    collectedAt: kst.datetimeStr(),
  };
  REPORT_JOBS.forEach((job) => {
    result[job.key] = collectLocal(job);
  });
  return result;
}

function summarizeSection(section) {
  if (!section) return '- 수집 결과 없음';
  if (!section.ok) return `- ${section.label}: 수집 실패`;
  const firstLine = String(section.output || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '출력 없음';
  return `- ${section.label}: ${firstLine}`;
}

function formatDailyReport(collected) {
  const lines = [`📊 일일 통합 리포트 (${kst.today()})`, `- 수집 시각: ${collected.collectedAt}`, ''];
  lines.push(summarizeSection(collected.luna));
  lines.push(summarizeSection(collected.claude));
  lines.push(summarizeSection(collected.ska));
  lines.push(summarizeSection(collected.common));
  return lines.join('\n');
}

module.exports = { collectAll, formatDailyReport };
