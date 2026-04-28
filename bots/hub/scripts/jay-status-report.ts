#!/usr/bin/env tsx

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

async function safe(label, work) {
  try {
    return await work();
  } catch (error) {
    return {
      ok: false,
      label,
      error: normalizeText(error?.message || error, 'unknown_error'),
    };
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const incidentStore = require('../../orchestrator/lib/jay-incident-store.ts');
  const skillExtractor = require('../../orchestrator/lib/jay-skill-extractor.ts');
  const commanderDispatcher = require('../lib/control/commander-dispatcher.ts');
  const pgPool = require('../../../packages/core/lib/pg-pool');
  const eventTable = incidentStore._testOnly.EVENT_TABLE;
  const statuses = ['queued', 'planning', 'planned', 'awaiting_approval', 'completed', 'failed', 'dead_letter'];

  const incidents = await safe('incidents', async () => {
    await incidentStore.ensureIncidentTables();
    const entries = {};
    for (const status of statuses) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await incidentStore.listIncidentsByStatus([status], 50);
      entries[status] = rows.length;
    }
    return entries;
  });

  const recentEvents = await safe('recent_events', async () => {
    await incidentStore.ensureIncidentTables();
    const rows = await pgPool.query('agent', `
      SELECT event_type, COUNT(*)::int AS count
      FROM ${eventTable}
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY event_type
      ORDER BY count DESC, event_type ASC
      LIMIT 12
    `, []);
    return rows.map((row) => ({
      eventType: normalizeText(row.event_type),
      count: Number(row.count || 0),
    }));
  });

  const commander = await safe('commander', async () => commanderDispatcher.getCommanderDispatchStats());
  const skills = await safe('skills', async () => {
    const rows = await skillExtractor.listRecentSkills({ limit: 8, days: 30 });
    return {
      count: rows.length,
      recent: rows.map((row) => ({
        team: row.team,
        strategyKey: row.strategy_key,
        confidence: Number(row.confidence || 0),
        updatedAt: row.updated_at,
      })),
    };
  });

  const payload = {
    ok: true,
    generatedAt: new Date().toISOString(),
    incidents,
    recentEvents,
    commander,
    skills,
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`# Jay status (${payload.generatedAt})`);
  console.log(`incidents: ${JSON.stringify(incidents)}`);
  console.log(`commander: ${JSON.stringify(commander)}`);
  console.log(`skills: ${JSON.stringify(skills)}`);
  console.log(`recentEvents: ${JSON.stringify(recentEvents)}`);
}

main().catch((error) => {
  console.error(`jay_status_report_failed: ${error?.message || error}`);
  process.exit(1);
});
