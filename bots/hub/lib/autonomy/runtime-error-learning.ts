const pgPool = require('../../../../packages/core/lib/pg-pool');
const eventLake = require('../../../../packages/core/lib/event-lake');
const failureTrajectory = require('../../../../packages/core/lib/failure-trajectory');

type RuntimeErrorLearningInput = {
  errorType: string;
  route?: string;
  routeClass?: string;
  method?: string;
  status?: number;
  currentValue?: string | number | null;
  suggestedValue?: string | number | null;
  rationale?: string;
  evidence?: Record<string, unknown>;
  traceId?: string;
  severity?: 'info' | 'warn' | 'error' | 'critical';
};

let initPromise: Promise<void> | null = null;

function text(value: unknown, fallback = ''): string {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function sanitizeRoute(route: unknown): string {
  const normalized = text(route, 'unknown');
  return normalized.replace(/[?#].*$/, '').slice(0, 180) || 'unknown';
}

function suggestionKey(input: RuntimeErrorLearningInput): string {
  return [
    text(input.errorType, 'unknown'),
    sanitizeRoute(input.route),
    text(input.routeClass, 'generic'),
    text(input.suggestedValue, ''),
  ].join('|').toLowerCase();
}

async function ensureRuntimeTuningTable(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS hub_runtime_tuning_suggestions (
        id BIGSERIAL PRIMARY KEY,
        suggestion_key TEXT NOT NULL UNIQUE,
        error_type TEXT NOT NULL,
        route TEXT NOT NULL,
        route_class TEXT NOT NULL DEFAULT 'generic',
        method TEXT,
        status INT,
        current_value TEXT,
        suggested_value TEXT,
        status_label TEXT NOT NULL DEFAULT 'shadow',
        confidence NUMERIC NOT NULL DEFAULT 0.55,
        rationale TEXT,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurrence_count INT NOT NULL DEFAULT 1,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_runtime_tuning_suggestions_last_seen_idx
      ON hub_runtime_tuning_suggestions(last_seen DESC)
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_runtime_tuning_suggestions_status_idx
      ON hub_runtime_tuning_suggestions(status_label, error_type)
    `);
  })().catch((error: unknown) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

function buildDefaultRationale(input: RuntimeErrorLearningInput): string {
  const errorType = text(input.errorType, 'unknown');
  if (errorType === 'request_entity_too_large') {
    return 'Route-specific body limits should be tuned from observed payload size instead of a single hard-coded global limit.';
  }
  if (errorType === 'readonly_write_rejected') {
    return 'Write traffic must use a typed mutation endpoint; /hub/pg/query remains read-only by policy.';
  }
  return 'Repeated runtime error pattern should be learned before changing runtime policy.';
}

export async function recordHubRuntimeErrorPattern(input: RuntimeErrorLearningInput): Promise<Record<string, unknown>> {
  const errorType = text(input.errorType, 'unknown');
  const route = sanitizeRoute(input.route);
  const routeClass = text(input.routeClass, 'generic');
  const key = suggestionKey({ ...input, errorType, route, routeClass });
  const evidence = {
    ...(input.evidence || {}),
    learned_by: 'hub-runtime-error-learning',
    sigma_feedback_loop: true,
    claude_failure_trajectory: true,
  };

  await ensureRuntimeTuningTable();
  const rows = await pgPool.query('agent', `
    INSERT INTO hub_runtime_tuning_suggestions (
      suggestion_key, error_type, route, route_class, method, status,
      current_value, suggested_value, rationale, evidence
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (suggestion_key) DO UPDATE SET
      occurrence_count = hub_runtime_tuning_suggestions.occurrence_count + 1,
      last_seen = NOW(),
      status = EXCLUDED.status,
      current_value = COALESCE(EXCLUDED.current_value, hub_runtime_tuning_suggestions.current_value),
      suggested_value = COALESCE(EXCLUDED.suggested_value, hub_runtime_tuning_suggestions.suggested_value),
      evidence = hub_runtime_tuning_suggestions.evidence || EXCLUDED.evidence
    RETURNING id, suggestion_key, occurrence_count
  `, [
    key,
    errorType,
    route,
    routeClass,
    text(input.method, ''),
    Number.isFinite(Number(input.status)) ? Number(input.status) : null,
    input.currentValue == null ? null : String(input.currentValue),
    input.suggestedValue == null ? null : String(input.suggestedValue),
    text(input.rationale, buildDefaultRationale({ ...input, errorType })),
    JSON.stringify(evidence),
  ]);

  const row = rows[0] || {};
  await eventLake.record({
    eventType: 'hub_runtime_error_pattern_learned',
    team: 'hub',
    botName: 'runtime-error-learning',
    severity: input.severity || 'warn',
    traceId: text(input.traceId, ''),
    title: `${errorType}:${routeClass}`,
    message: text(input.rationale, buildDefaultRationale({ ...input, errorType })).slice(0, 1000),
    tags: ['hub', 'runtime_tuning', errorType, routeClass].filter(Boolean),
    metadata: {
      suggestion_id: row.id || null,
      suggestion_key: row.suggestion_key || key,
      occurrence_count: row.occurrence_count || 1,
      route,
      method: text(input.method, ''),
      current_value: input.currentValue ?? null,
      suggested_value: input.suggestedValue ?? null,
      evidence,
    },
  }).catch(() => null);

  const occurrenceCount = Number(row.occurrence_count || 1);
  if (occurrenceCount === 1 || occurrenceCount % 10 === 0) {
    await failureTrajectory.recordExecutionTrajectory({
      team: 'hub',
      agent: 'runtime-error-learning',
      intent: 'hub_runtime_autotune',
      result: 'failure',
      command: `${text(input.method, 'UNKNOWN')} ${route}`,
      exitCode: input.status || '',
      rootCause: errorType,
      resolutionHint: text(input.rationale, buildDefaultRationale({ ...input, errorType })),
      traceId: text(input.traceId, ''),
      metadata: {
        suggestion_key: row.suggestion_key || key,
        occurrence_count: occurrenceCount,
        route_class: routeClass,
        current_value: input.currentValue ?? null,
        suggested_value: input.suggestedValue ?? null,
        evidence,
      },
    }).catch(() => null);
  }

  return {
    ok: true,
    suggestion_id: row.id || null,
    suggestion_key: row.suggestion_key || key,
    occurrence_count: occurrenceCount,
  };
}

export function recordHubRuntimeErrorPatternAsync(input: RuntimeErrorLearningInput): void {
  recordHubRuntimeErrorPattern(input).catch((error: unknown) => {
    console.warn('[runtime-error-learning] record failed:', error instanceof Error ? error.message : String(error));
  });
}
