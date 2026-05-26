#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  parseArgs,
  dbQuery,
  ensureDir,
  ensurePublishLogTable,
  OUTPUT_DIR,
  INTEGRATION_REPORT,
  emitJsonIfRequested,
} = require('../lib/edux-runtime-support.ts');

let pgPool;
try {
  pgPool = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/pg-pool'));
} catch { pgPool = null; }

let launchdDoctor;
try {
  launchdDoctor = require('./edux-launchd-doctor.ts');
} catch { launchdDoctor = null; }

function launchdSummary() {
  if (!launchdDoctor?.buildReport) return { ok: false, reason: 'launchd_doctor_unavailable' };
  const report = launchdDoctor.buildReport({ apply: false, confirm: null, json: false, noWrite: true, strict: false });
  return {
    ok: report.ok,
    loadedCount: report.loadedCount,
    expectedCount: report.expectedCount,
    missingLabels: report.missingLabels,
    reloadRequiredLabels: report.reloadRequiredLabels || [],
    validationFailureCount: report.validationFailureCount,
  };
}

function fixtureReport() {
  return {
    ok: true,
    mode: 'fixture',
    dryRunDays: 7,
    expectedSlotsPerDay: 5,
    summary: { dryRunCount7d: 35, successCount7d: 0, avgContentLen: 1200, imageAttachmentCount7d: 0 },
    blockers: [],
    generatedAt: new Date().toISOString(),
  };
}

async function generateReport(options = {}) {
  if (options.fixture) return fixtureReport();
  const table = await ensurePublishLogTable(pgPool);
  const report = {
    ok: table.ok,
    mode: 'live-db-readonly',
    db: table,
    launchd: launchdSummary(),
    summary: {},
    blockers: [],
    generatedAt: new Date().toISOString(),
  };

  if (!table.ok) {
    report.blockers.push('edux_publish_log migration missing or DB unavailable');
    return report;
  }

  const rows = await dbQuery(pgPool, `
    SELECT
      COUNT(*) FILTER (WHERE status = 'dry_run' AND created_at >= NOW() - INTERVAL '7 days') AS dry_run_7d,
      COUNT(*) FILTER (WHERE status = 'success' AND created_at >= NOW() - INTERVAL '7 days') AS success_7d,
      ROUND(AVG((metadata->>'contentLen')::int) FILTER (WHERE metadata->>'contentLen' IS NOT NULL AND created_at >= NOW() - INTERVAL '7 days')) AS avg_content_len,
      COUNT(*) FILTER (WHERE status = 'dry_run' AND jsonb_array_length(image_urls) > 0 AND (metadata->>'fixture')::boolean IS NOT TRUE AND created_at >= NOW() - INTERVAL '7 days') AS image_attached
    FROM edux_publish_log
  `, [], 'public');
  const row = rows.rows?.[0] || {};
  report.summary = {
    dryRunCount7d: Number(row.dry_run_7d || 0),
    successCount7d: Number(row.success_7d || 0),
    avgContentLen: Number(row.avg_content_len || 0),
    imageAttachmentCount7d: Number(row.image_attached || 0),
  };
  if (report.summary.dryRunCount7d < 35) report.blockers.push('dry_run_7d_below_35');
  if (report.launchd && report.launchd.ok === false) report.blockers.push('launchd_dry_run_agents_not_loaded');
  if (report.summary.imageAttachmentCount7d > 0) report.blockers.push('image_attachment_policy_violation');
  report.ok = report.blockers.length === 0;
  return report;
}

async function main() {
  const args = parseArgs();
  const report = await generateReport({ fixture: args.fixture });
  if (!args.noWrite) {
    ensureDir(OUTPUT_DIR);
    fs.writeFileSync(INTEGRATION_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  emitJsonIfRequested(args.json, report);
  if (!args.json) console.log(`[edu-x/integration-report] ok=${report.ok} report=${args.noWrite ? '(no-write)' : INTEGRATION_REPORT}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[edu-x/integration-report] 오류:', err);
    process.exit(1);
  });
}

module.exports = { generateReport };
