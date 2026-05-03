#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const pgPool = require('../../../packages/core/lib/pg-pool');
const teamBus = require('../../orchestrator/lib/jay-team-bus.ts');

const CONFIRM = 'jay-commander-queue-hygiene';
const SMOKE_INCIDENT_RE = /^(team-bus-smoke|dispatch-smoke|debug):/;

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function classifyCommanderTask(row = {}) {
  const status = normalizeText(row.status).toLowerCase();
  const incidentKey = normalizeText(row.incident_key || row.incidentKey);
  const lastError = normalizeText(row.last_error || row.lastError);
  if (SMOKE_INCIDENT_RE.test(incidentKey)) {
    if (status === 'queued' || status === 'retrying') return 'safe_reject_smoke_artifact';
    if (status === 'dead_letter') return 'safe_archive_terminal_smoke_artifact';
  }
  if (status === 'dead_letter' && lastError.startsWith('commander_adapter_virtual_disabled:')) {
    return 'adapter_policy_blocked_history';
  }
  if (status === 'queued' || status === 'retrying' || status === 'running') return 'review_required_active_task';
  if (status === 'dead_letter') return 'review_required_dead_letter';
  return 'ignore';
}

function summarize(rows) {
  const byClass = {};
  const byStatus = {};
  for (const row of rows) {
    const classification = row.classification || classifyCommanderTask(row);
    byClass[classification] = (byClass[classification] || 0) + 1;
    const status = normalizeText(row.status, 'unknown');
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return { byClass, byStatus };
}

async function loadCandidateRows(limit = 500) {
  await teamBus.ensureJayTeamBusTables();
  const table = teamBus._testOnly.TASK_TABLE;
  const rows = await pgPool.query('agent', `
    SELECT id, incident_key, team, step_id, status, attempts, last_error, created_at, updated_at
    FROM ${table}
    WHERE status IN ('queued', 'retrying', 'running', 'dead_letter')
    ORDER BY created_at ASC
    LIMIT $1
  `, [Math.max(1, Number(limit || 500) || 500)]);
  return rows.map((row) => ({
    ...row,
    classification: classifyCommanderTask(row),
  }));
}

async function applySafeRejections(rows) {
  const applied = [];
  for (const row of rows) {
    if (
      row.classification !== 'safe_reject_smoke_artifact'
      && row.classification !== 'safe_archive_terminal_smoke_artifact'
    ) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await teamBus.updateTeamTaskStatus({
      id: row.id,
      status: 'rejected',
      lastError: row.classification === 'safe_archive_terminal_smoke_artifact'
        ? 'jay_commander_hygiene_archived_terminal_smoke_artifact'
        : 'jay_commander_hygiene_rejected_smoke_artifact',
    });
    if (result?.ok) applied.push(row.id);
  }
  return applied;
}

async function runJayCommanderQueueHygiene(options = {}) {
  const apply = Boolean(options.apply);
  const confirm = normalizeText(options.confirm);
  const rows = await loadCandidateRows(options.limit || 500);
  const safeReject = rows.filter((row) => row.classification === 'safe_reject_smoke_artifact');
  const reviewRequired = rows.filter((row) => row.classification.startsWith('review_required'));
  const applied = apply && confirm === CONFIRM ? await applySafeRejections(rows) : [];
  return {
    ok: !apply || confirm === CONFIRM,
    dryRun: !apply,
    confirmRequired: CONFIRM,
    applied: applied.length,
    summary: summarize(rows),
    safeRejectCount: safeReject.length,
    reviewRequiredCount: reviewRequired.length,
    appliedTaskIds: applied,
    blocked: apply && confirm !== CONFIRM ? ['confirm_required'] : [],
    candidates: rows.slice(0, 50).map((row) => ({
      id: row.id,
      incidentKey: row.incident_key,
      team: row.team,
      stepId: row.step_id,
      status: row.status,
      attempts: Number(row.attempts || 0),
      lastError: row.last_error || null,
      classification: row.classification,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

function runSmoke() {
  const rows = [
    { incident_key: 'team-bus-smoke:1', status: 'queued' },
    { incident_key: 'dispatch-smoke:1', status: 'retrying' },
    { incident_key: 'debug:1', status: 'dead_letter' },
    { incident_key: 'real:1', status: 'dead_letter', last_error: 'commander_adapter_virtual_disabled:luna' },
    { incident_key: 'real:2', status: 'queued' },
  ].map((row) => ({ ...row, classification: classifyCommanderTask(row) }));
  assert.equal(rows[0].classification, 'safe_reject_smoke_artifact');
  assert.equal(rows[1].classification, 'safe_reject_smoke_artifact');
  assert.equal(rows[2].classification, 'safe_archive_terminal_smoke_artifact');
  assert.equal(rows[3].classification, 'adapter_policy_blocked_history');
  assert.equal(rows[4].classification, 'review_required_active_task');
  const summary = summarize(rows);
  assert.equal(summary.byClass.safe_reject_smoke_artifact, 2);
  return { ok: true, summary };
}

async function main() {
  const json = hasArg('--json');
  const smoke = hasArg('--smoke');
  const result = smoke
    ? runSmoke()
    : await runJayCommanderQueueHygiene({
      apply: hasArg('--apply'),
      confirm: argValue('--confirm', ''),
      limit: Number(argValue('--limit', 500)),
    });
  if (json || smoke) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`# Jay commander queue hygiene (${result.dryRun ? 'dry-run' : 'apply'})`);
  console.log(`safeReject=${result.safeRejectCount} reviewRequired=${result.reviewRequiredCount} applied=${result.applied}`);
  console.log(`summary=${JSON.stringify(result.summary)}`);
}

main().catch((error) => {
  console.error(`jay_commander_queue_hygiene_failed: ${error?.message || error}`);
  process.exit(1);
});

module.exports = {
  classifyCommanderTask,
  runJayCommanderQueueHygiene,
  _testOnly: { CONFIRM, SMOKE_INCIDENT_RE, summarize },
};
