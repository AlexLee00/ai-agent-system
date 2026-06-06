'use strict';

const trajectory = require('../lib/failure-trajectory');
const pgPool = require('../lib/pg-pool');

type HealthSummary = {
  ok: boolean;
  liveProbe: boolean;
  sinceHours: number;
  counts: Array<Record<string, unknown>>;
  latest: Array<Record<string, unknown>>;
  probe?: Record<string, unknown>;
};

function argValue(name: string, fallback: string): string {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function loadCounts(sinceHours: number): Promise<Array<Record<string, unknown>>> {
  return pgPool.query('reservation', `
    SELECT
      metadata->>'team' AS team,
      metadata->>'agent' AS agent,
      metadata->>'intent' AS intent,
      metadata->>'kind' AS kind,
      COALESCE(metadata->>'result', result_alias.result) AS result,
      COUNT(*)::int AS count,
      MAX(created_at) AS latest_at
    FROM reservation.rag_experience
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN metadata->>'kind' = 'failure_trajectory' THEN 'failure'
        ELSE metadata->>'result'
      END AS result
    ) AS result_alias
    WHERE created_at > NOW() - ($1::text || ' hours')::INTERVAL
      AND metadata->>'kind' IN ('failure_trajectory', 'execution_trajectory')
    GROUP BY 1, 2, 3, 4, 5
    ORDER BY latest_at DESC
    LIMIT 50
  `, [String(sinceHours)]);
}

async function loadLatest(): Promise<Array<Record<string, unknown>>> {
  return pgPool.query('reservation', `
    SELECT
      id,
      metadata->>'team' AS team,
      metadata->>'agent' AS agent,
      metadata->>'intent' AS intent,
      metadata->>'kind' AS kind,
      COALESCE(metadata->>'result', CASE WHEN metadata->>'kind' = 'failure_trajectory' THEN 'failure' END) AS result,
      metadata->>'signature' AS signature,
      metadata->'metadata'->>'failure_hint_count' AS failure_hint_count,
      metadata->'metadata'->>'success_hint_count' AS success_hint_count,
      created_at
    FROM reservation.rag_experience
    WHERE metadata->>'kind' IN ('failure_trajectory', 'execution_trajectory')
    ORDER BY id DESC
    LIMIT 10
  `);
}

async function runLiveProbe(): Promise<Record<string, unknown>> {
  const runId = `execution-trajectory-health-${Date.now()}`;
  const loop = await trajectory.prepareExecutionTrajectoryLoop({
    team: 'core',
    agent: 'execution-trajectory-health',
    intent: 'execution_trajectory_health_probe',
    command: `execution-trajectory-health ${runId}`,
    query: `execution trajectory health probe ${runId}`,
    limit: 3,
    metadata: {
      run_id: runId,
      health_probe: true,
    },
  });
  const failure = await loop.recordFailure({
    stderr: `health probe failure ${runId}`,
    rootCause: `execution trajectory health failure ${runId}`,
    resolutionHint: 'health probe failure should be searchable',
    testResult: 'health_probe_failure',
    metadata: { phase: 'failure' },
  });
  const success = await loop.recordSuccess({
    stdout: `health probe success ${runId}`,
    recoveryResult: `execution trajectory health success ${runId}`,
    resolutionHint: 'health probe success should be searchable',
    testResult: 'health_probe_success',
    metadata: { phase: 'success' },
  });
  const recalled = await trajectory.prepareExecutionTrajectoryLoop({
    team: 'core',
    agent: 'execution-trajectory-health',
    intent: 'execution_trajectory_health_probe',
    query: `execution trajectory health failure ${runId} execution trajectory health success ${runId}`,
    limit: 5,
  });
  const rows = await pgPool.query('reservation', `
    SELECT id, metadata->>'kind' AS kind, metadata->>'result' AS result,
           metadata->'metadata'->>'phase' AS phase
    FROM reservation.rag_experience
    WHERE metadata->'metadata'->>'run_id' = $1
    ORDER BY id ASC
  `, [runId]);
  return {
    runId,
    failure,
    success,
    recalledFailureHints: recalled.failureHints.length,
    recalledSuccessHints: recalled.successHints.length,
    rows,
    ok: rows.length >= 2 && recalled.failureHints.length >= 1 && recalled.successHints.length >= 1,
  };
}

async function main(): Promise<void> {
  const sinceHours = Math.max(1, Math.min(Number(argValue('--since-hours', '24')), 168));
  const liveProbe = process.argv.includes('--live-probe');
  const summary: HealthSummary = {
    ok: true,
    liveProbe,
    sinceHours,
    counts: await loadCounts(sinceHours),
    latest: await loadLatest(),
  };
  if (liveProbe) {
    summary.probe = await runLiveProbe();
    summary.ok = Boolean(summary.probe.ok);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exit(1);
}

main().catch((error: Error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
