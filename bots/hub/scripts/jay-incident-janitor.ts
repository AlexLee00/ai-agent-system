#!/usr/bin/env tsx

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function parseMinutes() {
  const flag = process.argv.find((arg) => arg.startsWith('--stale-minutes='));
  const raw = flag ? flag.split('=').slice(1).join('=') : process.env.JAY_INCIDENT_STALE_MINUTES;
  const parsed = Number(raw || 60);
  if (!Number.isFinite(parsed)) return 60;
  return Math.max(0, Math.floor(parsed));
}

function parseMaxAttempts() {
  const flag = process.argv.find((arg) => arg.startsWith('--max-attempts='));
  const raw = flag ? flag.split('=').slice(1).join('=') : process.env.JAY_INCIDENT_MAX_ATTEMPTS;
  const parsed = Number(raw || 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(1, Math.floor(parsed));
}

async function fetchStaleRows(pgPool, table, statuses, staleMinutes) {
  return pgPool.query('agent', `
    SELECT
      incident_key, team, intent, status, attempts, last_error,
      to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
    FROM ${table}
    WHERE status = ANY($1::text[])
      AND updated_at < NOW() - ($2::int || ' minutes')::interval
    ORDER BY updated_at ASC
    LIMIT 100
  `, [statuses, staleMinutes]);
}

async function main() {
  const apply = hasArg('--apply');
  const json = hasArg('--json') || apply;
  const staleMinutes = parseMinutes();
  const maxAttempts = parseMaxAttempts();
  const incidentStore = require('../../orchestrator/lib/jay-incident-store.ts');
  const pgPool = require('../../../packages/core/lib/pg-pool');
  const table = incidentStore._testOnly.INCIDENT_TABLE;
  await incidentStore.ensureIncidentTables();

  const requeueStatuses = ['planning', 'planned'];
  const approvalRows = await fetchStaleRows(pgPool, table, ['awaiting_approval'], Math.max(staleMinutes, 24 * 60));
  const requeueRows = await fetchStaleRows(pgPool, table, requeueStatuses, staleMinutes);
  const requeued = [];
  const deadLettered = [];

  if (apply) {
    for (const row of requeueRows) {
      const key = normalizeText(row.incident_key);
      const fromStatus = normalizeText(row.status);
      const attempts = Number(row.attempts || 0);
      if (attempts >= maxAttempts) {
        // eslint-disable-next-line no-await-in-loop
        const deadLetter = await incidentStore.updateIncidentStatus({
          incidentKey: key,
          status: 'dead_letter',
          lastError: `jay_incident_janitor_dead_letter:${fromStatus}:attempts_${attempts}`,
        });
        if (deadLetter?.ok) {
          // eslint-disable-next-line no-await-in-loop
          await incidentStore.appendIncidentEvent({
            incidentKey: key,
            eventType: 'jay_incident_janitor_dead_letter',
            payload: {
              fromStatus,
              attempts,
              maxAttempts,
              staleMinutes,
              updatedAt: row.updated_at,
            },
          }).catch(() => {});
          deadLettered.push(key);
        }
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const updated = await incidentStore.updateIncidentStatus({
        incidentKey: key,
        status: 'queued',
        lastError: `jay_incident_janitor_requeued:${fromStatus}`,
      });
      if (updated?.ok) {
        // eslint-disable-next-line no-await-in-loop
        await incidentStore.appendIncidentEvent({
          incidentKey: key,
          eventType: 'jay_incident_janitor_requeued',
          payload: {
            fromStatus,
            staleMinutes,
            updatedAt: row.updated_at,
          },
        }).catch(() => {});
        requeued.push(key);
      }
    }
  }

  const payload = {
    ok: true,
    apply,
    staleMinutes,
    maxAttempts,
    stale: {
      requeueEligible: requeueRows.map((row) => ({
        incidentKey: row.incident_key,
        team: row.team,
        intent: row.intent,
        status: row.status,
        attempts: Number(row.attempts || 0),
        updatedAt: row.updated_at,
      })),
      awaitingApproval: approvalRows.map((row) => ({
        incidentKey: row.incident_key,
        team: row.team,
        intent: row.intent,
        status: row.status,
        attempts: Number(row.attempts || 0),
        updatedAt: row.updated_at,
      })),
    },
    requeued,
    deadLettered,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`# Jay incident janitor (${apply ? 'apply' : 'dry-run'})`);
  console.log(`staleMinutes: ${staleMinutes}`);
  console.log(`maxAttempts: ${maxAttempts}`);
  console.log(`requeueEligible: ${payload.stale.requeueEligible.length}`);
  console.log(`deadLettered: ${payload.deadLettered.length}`);
  console.log(`awaitingApproval: ${payload.stale.awaitingApproval.length}`);
}

main().catch((error) => {
  console.error(`jay_incident_janitor_failed: ${error?.message || error}`);
  process.exit(1);
});
