const pgPool = require('./pg-pool');
const { getTraceId } = require('./trace');

const SCHEMA = 'agent';
const TABLE = `${SCHEMA}.event_lake`;

type EventLakeSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';
type EventLakeInsertRow = { id?: number | string | null };
type EventLakeTotalsRow = {
  total?: number | string | null;
  errors?: number | string | null;
  warnings?: number | string | null;
  teams?: number | string | null;
  bots?: number | string | null;
};
type EventLakeRecordInput = {
  eventType: string;
  team?: string;
  botName?: string;
  severity?: EventLakeSeverity;
  traceId?: string;
  title?: string;
  message?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};
type EventLakeSearchInput = {
  q?: string;
  eventType?: string;
  team?: string;
  severity?: string;
  botName?: string;
  minutes?: number;
  limit?: number;
};
type EventLakeFeedbackInput = {
  score?: number | null;
  feedback?: string;
};

let _initPromise: Promise<void> | null = null;

function _text(value: unknown, fallback = ''): string {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function _severity(value: unknown): EventLakeSeverity {
  const normalized = _text(value, 'info').toLowerCase();
  return ['debug', 'info', 'warn', 'error', 'critical'].includes(normalized)
    ? (normalized as EventLakeSeverity)
    : 'info';
}

function _tags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag: unknown) => _text(tag))
    .filter(Boolean)
    .slice(0, 20);
}

export async function initSchema() {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    await pgPool.run(SCHEMA, `
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        team TEXT NOT NULL DEFAULT 'general',
        bot_name TEXT NOT NULL DEFAULT 'unknown',
        severity TEXT NOT NULL DEFAULT 'info',
        trace_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        message TEXT NOT NULL DEFAULT '',
        tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        feedback_score NUMERIC,
        feedback TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);

    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS event_lake_created_at_desc_idx
      ON ${TABLE} (created_at DESC)
    `, []);
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS event_lake_event_type_created_at_idx
      ON ${TABLE} (event_type, created_at DESC)
    `, []);
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS event_lake_team_created_at_idx
      ON ${TABLE} (team, created_at DESC)
    `, []);
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS event_lake_severity_created_at_idx
      ON ${TABLE} (severity, created_at DESC)
    `, []);
    await pgPool.run(SCHEMA, `
      CREATE INDEX IF NOT EXISTS event_lake_tags_gin_idx
      ON ${TABLE} USING gin (tags)
    `, []);
  })().catch((error) => {
    _initPromise = null;
    throw error;
  });

  return _initPromise;
}

/**
 * @param {EventLakeRecordInput} input
 */
export async function record({
  eventType,
  team = 'general',
  botName = 'unknown',
  severity = 'info',
  traceId = '',
  title = '',
  message = '',
  tags = [],
  metadata = {},
}: EventLakeRecordInput): Promise<number | string | null> {
  await initSchema();

  const rows = /** @type {EventLakeInsertRow[]} */ (await pgPool.query(SCHEMA, `
    INSERT INTO ${TABLE} (
      event_type, team, bot_name, severity, trace_id,
      title, message, tags, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::TEXT[], $9::JSONB)
    RETURNING id
  `, [
    _text(eventType, 'general_event'),
    _text(team, 'general'),
    _text(botName, 'unknown'),
    _severity(severity),
    _text(traceId || getTraceId() || '', ''),
    _text(title, ''),
    _text(message, ''),
    _tags(tags),
    JSON.stringify(metadata || {}),
  ]));

  return rows[0]?.id || null;
}

/**
 * @param {EventLakeSearchInput} [input]
 */
export async function search({
  q = '',
  eventType = '',
  team = '',
  severity = '',
  botName = '',
  minutes = 24 * 60,
  limit = 50,
}: EventLakeSearchInput = {}) {
  await initSchema();

  const params: Array<string | number> = [Math.max(1, Number(minutes || 0) || 1)];
  const conditions = [`created_at >= NOW() - ($1::int * INTERVAL '1 minute')`];
  let idx = 2;
  let nextParamIndex = idx;

  if (_text(q)) {
    params.push(`%${String(q).trim()}%`);
    conditions.push(`(title ILIKE $${nextParamIndex} OR message ILIKE $${nextParamIndex} OR metadata::text ILIKE $${nextParamIndex})`);
    nextParamIndex += 1;
  }
  if (_text(eventType)) {
    params.push(_text(eventType));
    conditions.push(`event_type = $${nextParamIndex++}`);
  }
  if (_text(team)) {
    params.push(_text(team));
    conditions.push(`team = $${nextParamIndex++}`);
  }
  if (_text(severity)) {
    params.push(_severity(severity));
    conditions.push(`severity = $${nextParamIndex++}`);
  }
  if (_text(botName)) {
    params.push(_text(botName));
    conditions.push(`bot_name = $${nextParamIndex++}`);
  }

  params.push(Math.min(200, Math.max(1, Number(limit || 50) || 50)));
  return pgPool.query(SCHEMA, `
    SELECT
      id, event_type, team, bot_name, severity, trace_id,
      title, message, tags, metadata, feedback_score, feedback,
      created_at, updated_at
    FROM ${TABLE}
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params);
}

/**
 * @param {{ minutes?: number }} [input]
 */
export async function stats({ minutes = 24 * 60 } = {}) {
  await initSchema();
  const windowMinutes = Math.max(1, Number(minutes || 0) || 1);

  const totals = /** @type {EventLakeTotalsRow | null} */ (await pgPool.get(SCHEMA, `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE severity IN ('error', 'critical'))::int AS errors,
      COUNT(*) FILTER (WHERE severity = 'warn')::int AS warnings,
      COUNT(DISTINCT team)::int AS teams,
      COUNT(DISTINCT bot_name)::int AS bots
    FROM ${TABLE}
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
  `, [windowMinutes]));

  const services = await pgPool.query(SCHEMA, `
    SELECT
      bot_name,
      team,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE severity IN ('error', 'critical'))::int AS errors,
      MAX(created_at) AS latest_at
    FROM ${TABLE}
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
    GROUP BY bot_name, team
    ORDER BY total DESC, latest_at DESC
    LIMIT 100
  `, [windowMinutes]);

  return {
    window_minutes: windowMinutes,
    total: Number(totals?.total || 0),
    errors: Number(totals?.errors || 0),
    warnings: Number(totals?.warnings || 0),
    teams: Number(totals?.teams || 0),
    bots: Number(totals?.bots || 0),
    services,
  };
}

/**
 * @param {{ minutes?: number, limit?: number, targetTeam?: string, pipeline?: string, commandId?: string }} [input]
 */
export async function recentCommands({
  minutes = 24 * 60,
  limit = 50,
  targetTeam = '',
  pipeline = '',
  commandId = '',
} = {}) {
  await initSchema();

  const params: Array<string | number> = [Math.max(1, Number(minutes || 0) || 1)];
  const conditions = [
    `created_at >= NOW() - ($1::int * INTERVAL '1 minute')`,
    `event_type LIKE 'cross_pipeline.command_%'`,
  ];
  let nextParamIndex = 2;

  if (_text(targetTeam)) {
    params.push(_text(targetTeam));
    conditions.push(`metadata->>'target_team' = $${nextParamIndex++}`);
  }

  if (_text(pipeline)) {
    params.push(_text(pipeline));
    conditions.push(`metadata->>'pipeline' = $${nextParamIndex++}`);
  }

  if (_text(commandId)) {
    params.push(_text(commandId));
    conditions.push(`metadata->'command'->>'command_id' = $${nextParamIndex++}`);
  }

  params.push(Math.min(200, Math.max(1, Number(limit || 50) || 50)));

  const rows = await pgPool.query(SCHEMA, `
    SELECT
      id, event_type, team, bot_name, severity, trace_id,
      title, message, tags, metadata, feedback_score, feedback,
      created_at, updated_at
    FROM ${TABLE}
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params);

  return {
    total: rows.length,
    results: rows,
  };
}

/**
 * @param {number|string} id
 * @param {EventLakeFeedbackInput} [input]
 */
export async function addFeedback(id: number | string, { score = null, feedback = '' }: EventLakeFeedbackInput = {}) {
  await initSchema();
  const rows = await pgPool.query(SCHEMA, `
    UPDATE ${TABLE}
    SET
      feedback_score = COALESCE($2, feedback_score),
      feedback = COALESCE(NULLIF($3, ''), feedback),
      updated_at = NOW()
    WHERE id = $1
    RETURNING id, feedback_score, feedback, updated_at
  `, [
    Number(id),
    score == null ? null : Number(score),
    _text(feedback, ''),
  ]);
  return rows[0] || null;
}
