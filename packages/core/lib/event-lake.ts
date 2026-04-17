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
type EventLakeCommandLifecycleInput = {
  commandId: string;
  status: 'acknowledged' | 'completed' | 'failed';
  pipeline?: string;
  targetTeam?: string;
  botName?: string;
  source?: string;
  message?: string;
  detail?: unknown;
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
    `(event_type LIKE 'cross_pipeline.command_%' OR event_type LIKE 'cross_pipeline.command.%')`,
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
 * @param {{ minutes?: number, targetTeam?: string, pipeline?: string, limit?: number }} [input]
 */
export async function commandSummary({
  minutes = 24 * 60,
  targetTeam = '',
  pipeline = '',
  limit = 20,
} = {}) {
  const recent = await recentCommands({
    minutes,
    limit: 1000,
    targetTeam,
    pipeline,
  });

  const latestByCommand = new Map<string, any>();

  for (const row of recent.results || []) {
    const commandId = _text(row?.metadata?.command?.command_id);
    if (!commandId) continue;

    const current = latestByCommand.get(commandId);
    if (!current || String(row?.created_at || '') > String(current?.created_at || '')) {
      latestByCommand.set(commandId, row);
    }
  }

  const statusCounts: Record<string, number> = {};
  const pipelineCounts: Record<string, number> = {};
  const targetCounts: Record<string, number> = {};

  const commands = Array.from(latestByCommand.values())
    .map((row) => {
      const lifecycleStatus = _text(row?.metadata?.lifecycle_status, 'unknown');
      const pipelineName = _text(row?.metadata?.pipeline, 'unknown');
      const targetName =
        _text(row?.metadata?.target_team) ||
        _text(row?.metadata?.command?.target_team, 'unknown');

      statusCounts[lifecycleStatus] = (statusCounts[lifecycleStatus] || 0) + 1;
      pipelineCounts[pipelineName] = (pipelineCounts[pipelineName] || 0) + 1;
      targetCounts[targetName] = (targetCounts[targetName] || 0) + 1;

      return {
        command_id: _text(row?.metadata?.command?.command_id),
        pipeline: pipelineName,
        target_team: targetName,
        status: lifecycleStatus,
        summary: _text(row?.metadata?.summary || row?.title),
        bot_name: _text(row?.bot_name, 'unknown'),
        updated_at: row?.created_at || row?.updated_at || null,
        event: row,
      };
    })
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  return {
    total: commands.length,
    window_minutes: Math.max(1, Number(minutes || 0) || 1),
    status_counts: statusCounts,
    pipeline_counts: pipelineCounts,
    target_team_counts: targetCounts,
    recent: commands.slice(0, Math.min(200, Math.max(1, Number(limit || 20) || 20))),
  };
}

/**
 * @param {{ minutes?: number, thresholdMinutes?: number, targetTeam?: string, pipeline?: string, limit?: number }} [input]
 */
export async function stuckCommands({
  minutes = 24 * 60,
  thresholdMinutes = 15,
  targetTeam = '',
  pipeline = '',
  limit = 20,
} = {}) {
  const summary = await commandSummary({
    minutes,
    targetTeam,
    pipeline,
    limit: 1000,
  });

  const nowMs = Date.now();
  const stuck = (summary.recent || [])
    .map((command: any) => {
      const updatedAt = String(command?.updated_at || '');
      const ageMinutes =
        updatedAt ? Math.max(0, Math.floor((nowMs - Date.parse(updatedAt)) / 60_000)) : null;

      return {
        ...command,
        age_minutes: ageMinutes,
        stuck: Boolean(
          ageMinutes != null &&
            ageMinutes >= Math.max(1, Number(thresholdMinutes || 0) || 1) &&
            ['issued', 'acknowledged'].includes(_text(command?.status))
        ),
      };
    })
    .filter((command: any) => command.stuck)
    .sort((a: any, b: any) => {
      const ageA = Number(a?.age_minutes || 0);
      const ageB = Number(b?.age_minutes || 0);
      if (ageB !== ageA) return ageB - ageA;
      return String(b?.updated_at || '').localeCompare(String(a?.updated_at || ''));
    });

  return {
    total: stuck.length,
    window_minutes: summary.window_minutes,
    threshold_minutes: Math.max(1, Number(thresholdMinutes || 0) || 1),
    target_team_counts: stuck.reduce((acc: Record<string, number>, row: any) => {
      const key = _text(row?.target_team, 'unknown');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    pipeline_counts: stuck.reduce((acc: Record<string, number>, row: any) => {
      const key = _text(row?.pipeline, 'unknown');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
    results: stuck.slice(0, Math.min(200, Math.max(1, Number(limit || 20) || 20))),
  };
}

async function _findCommandIssuedEvent(commandId: string, minutes = 7 * 24 * 60) {
  await initSchema();

  const rows = await pgPool.query(SCHEMA, `
    SELECT
      id, event_type, team, bot_name, severity, trace_id,
      title, message, tags, metadata, feedback_score, feedback,
      created_at, updated_at
    FROM ${TABLE}
    WHERE created_at >= NOW() - ($1::int * INTERVAL '1 minute')
      AND (
        event_type = 'cross_pipeline.command_issued'
        OR event_type = 'cross_pipeline.command.issued'
      )
      AND metadata->'command'->>'command_id' = $2
    ORDER BY created_at DESC
    LIMIT 1
  `, [Math.max(1, Number(minutes || 0) || 1), _text(commandId)]);

  return rows[0] || null;
}

/**
 * @param {{ targetTeam?: string, minutes?: number, limit?: number }} [input]
 */
export async function commandInbox({
  targetTeam = '',
  minutes = 24 * 60,
  limit = 50,
} = {}) {
  await initSchema();

  const rows = await recentCommands({
    minutes,
    limit: Math.min(500, Math.max(50, Number(limit || 50) * 5)),
    targetTeam,
  });

  const byCommand = new Map<string, any[]>();
  for (const row of rows.results || []) {
    const commandId = _text(row?.metadata?.command?.command_id);
    if (!commandId) continue;
    const current = byCommand.get(commandId) || [];
    current.push(row);
    byCommand.set(commandId, current);
  }

  const inbox = [];
  for (const events of byCommand.values()) {
    const ordered = [...events].sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))
    );
    const latest = ordered[0];
    const lifecycleStatus = _text(latest?.metadata?.lifecycle_status);
    if (lifecycleStatus === 'issued') {
      inbox.push({
        command_id: latest.metadata?.command?.command_id || '',
        pipeline: latest.metadata?.pipeline || '',
        target_team: latest.metadata?.target_team || '',
        summary: latest.metadata?.summary || latest.title || '',
        command: latest.metadata?.command || null,
        issued_at: latest.created_at,
        event: latest,
      });
    }
  }

  const trimmed = inbox
    .sort((a, b) => String(b.issued_at || '').localeCompare(String(a.issued_at || '')))
    .slice(0, Math.min(200, Math.max(1, Number(limit || 50) || 50)));

  return {
    total: trimmed.length,
    results: trimmed,
  };
}

/**
 * @param {EventLakeCommandLifecycleInput} input
 */
export async function appendCommandLifecycle({
  commandId,
  status,
  pipeline = '',
  targetTeam = '',
  botName = 'unknown',
  source = 'hub.command_lifecycle',
  message = '',
  detail = null,
}: EventLakeCommandLifecycleInput) {
  const normalizedCommandId = _text(commandId);
  if (!normalizedCommandId) {
    throw new Error('commandId required');
  }

  const normalizedStatus = _text(status);
  if (!['acknowledged', 'completed', 'failed'].includes(normalizedStatus)) {
    throw new Error('invalid lifecycle status');
  }

  const issued = await _findCommandIssuedEvent(normalizedCommandId);
  if (!issued) {
    return null;
  }

  const command = issued.metadata?.command || {};
  const pipelineName = _text(pipeline || issued.metadata?.pipeline);
  const target = _text(targetTeam || issued.metadata?.target_team || command?.target_team);
  const summary = _text(issued.metadata?.summary || issued.title || 'cross-team command');

  const eventId = await record({
    eventType: `cross_pipeline.command.${normalizedStatus}`,
    team: 'jay',
    botName: _text(botName, 'unknown'),
    severity: normalizedStatus === 'failed' ? 'warn' : 'info',
    title: `[${pipelineName || 'cross-team'}] ${normalizedStatus}`,
    message: _text(message, summary),
    tags: ['cross-team', 'command', pipelineName, target, normalizedStatus].filter(Boolean),
    metadata: {
      pipeline: pipelineName,
      target_team: target,
      lifecycle_status: normalizedStatus,
      summary,
      source,
      detail,
      command,
    },
  });

  return {
    eventId,
    commandId: normalizedCommandId,
    status: normalizedStatus,
    pipeline: pipelineName,
    targetTeam: target,
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
