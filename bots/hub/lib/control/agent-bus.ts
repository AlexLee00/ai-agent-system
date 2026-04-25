const pgPool = require('../../../../packages/core/lib/pg-pool');

const AGENT_TABLE = 'agent.hub_agent_bus_agents';
const MESSAGE_TABLE = 'agent.hub_agent_bus_messages';
const DB_DISABLED = String(process.env.HUB_CONTROL_STATE_STORE || '').trim().toLowerCase() === 'memory';

const agents = new Map();
const messages = new Map();
const incidentDiscussions = new Map();
let ensurePromise = null;

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeText(item)).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((item) => normalizeText(item)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function rowToAgent(row) {
  if (!row) return null;
  return {
    agentId: normalizeText(row.agent_id),
    roles: parseJsonList(row.roles),
    tools: parseJsonList(row.tools),
    registeredAt: normalizeText(row.registered_at),
    lastHeartbeatAt: normalizeText(row.last_heartbeat_at),
  };
}

function rowToMessage(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    traceId: normalizeText(row.trace_id, '') || null,
    runId: normalizeText(row.run_id, '') || null,
    incidentKey: normalizeText(row.incident_key, '') || null,
    from: normalizeText(row.from_agent),
    to: normalizeText(row.to_agent),
    role: normalizeText(row.role),
    phase: normalizeText(row.phase),
    visibility: normalizeText(row.visibility),
    payload: row?.payload && typeof row.payload === 'object' ? row.payload : {},
    ackRequired: row.ack_required !== false,
    createdAt: normalizeText(row.created_at),
    ackedAt: normalizeText(row.acked_at, '') || null,
    ackedBy: normalizeText(row.acked_by, '') || null,
  };
}

async function ensureBusTables() {
  if (DB_DISABLED) return;
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${AGENT_TABLE} (
        agent_id TEXT PRIMARY KEY,
        roles JSONB NOT NULL DEFAULT '[]'::jsonb,
        tools JSONB NOT NULL DEFAULT '[]'::jsonb,
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `, []);
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${MESSAGE_TABLE} (
        id TEXT PRIMARY KEY,
        trace_id TEXT,
        run_id TEXT,
        incident_key TEXT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        role TEXT NOT NULL,
        phase TEXT NOT NULL,
        visibility TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        ack_required BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        acked_at TIMESTAMPTZ,
        acked_by TEXT
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_agent_bus_messages_incident_idx
      ON ${MESSAGE_TABLE} (incident_key, created_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_agent_bus_messages_agent_idx
      ON ${MESSAGE_TABLE} (from_agent, to_agent, created_at DESC)
    `, []);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });
  return ensurePromise;
}

async function withDbFallback(dbWork, memoryWork) {
  if (DB_DISABLED) return memoryWork();
  try {
    await ensureBusTables();
    return await dbWork();
  } catch (error) {
    const message = String(error?.message || error || 'unknown_error');
    console.error(`[hub/agent-bus] db unavailable: ${message}`);
    const wrapped = new Error(`hub_agent_bus_db_unavailable:${message}`);
    wrapped.code = 'control_state_store_unavailable';
    throw wrapped;
  }
}

function setMemoryIncidentReference(message) {
  const incidentKey = normalizeText(message?.incidentKey || '', '') || null;
  if (!incidentKey) return;
  const createdAt = normalizeText(message?.createdAt, new Date().toISOString());
  const discussion = incidentDiscussions.get(incidentKey) || {
    incidentKey,
    messageIds: [],
    updatedAt: createdAt,
  };
  discussion.messageIds.push(message.id);
  discussion.updatedAt = createdAt;
  incidentDiscussions.set(incidentKey, discussion);
}

async function registerAgent(input) {
  const agentId = normalizeText(input.agentId);
  if (!agentId) return { ok: false, error: 'agent_id_required' };
  const now = new Date().toISOString();
  const roles = normalizeList(input.roles);
  const tools = normalizeList(input.tools);

  return withDbFallback(async () => {
    const row = await pgPool.get('agent', `
      INSERT INTO ${AGENT_TABLE} (
        agent_id, roles, tools, registered_at, last_heartbeat_at
      )
      VALUES (
        $1, $2::jsonb, $3::jsonb, NOW(), NOW()
      )
      ON CONFLICT (agent_id)
      DO UPDATE SET
        roles = EXCLUDED.roles,
        tools = EXCLUDED.tools,
        last_heartbeat_at = NOW()
      RETURNING *
    `, [agentId, JSON.stringify(roles), JSON.stringify(tools)]);
    return { ok: true, agent: rowToAgent(row), storage: 'db' };
  }, async () => {
    const existing = agents.get(agentId);
    const registration = {
      agentId,
      roles,
      tools,
      registeredAt: existing?.registeredAt || now,
      lastHeartbeatAt: now,
    };
    agents.set(agentId, registration);
    return { ok: true, agent: registration, storage: 'memory_fallback' };
  });
}

async function listAgents() {
  return withDbFallback(async () => {
    const rows = await pgPool.query('agent', `
      SELECT
        agent_id,
        roles,
        tools,
        registered_at,
        last_heartbeat_at
      FROM ${AGENT_TABLE}
      ORDER BY agent_id ASC
    `, []);
    const normalized = rows.map(rowToAgent).filter(Boolean);
    return {
      ok: true,
      count: normalized.length,
      agents: normalized,
      storage: 'db',
    };
  }, async () => {
    return {
      ok: true,
      count: agents.size,
      agents: [...agents.values()].sort((a, b) => a.agentId.localeCompare(b.agentId)),
      storage: 'memory_fallback',
    };
  });
}

async function sendAgentMessage(input) {
  const from = normalizeText(input.from);
  if (!from) return { ok: false, error: 'from_required' };
  const traceId = normalizeText(input.traceId || '', '') || null;
  const runId = normalizeText(input.runId || '', '') || null;
  const incidentKey = normalizeText(input.incidentKey || '', '') || null;
  if (!traceId && !runId && !incidentKey) {
    return { ok: false, error: 'trace_or_run_or_incident_required' };
  }

  const message = {
    id: makeId('abus'),
    traceId,
    runId,
    incidentKey,
    from,
    to: normalizeText(input.to, 'broadcast'),
    role: normalizeText(input.role, 'producer'),
    phase: normalizeText(input.phase, 'observe'),
    visibility: normalizeText(input.visibility, 'internal'),
    payload: input.payload ?? {},
    ackRequired: input.ackRequired !== false,
    createdAt: new Date().toISOString(),
    ackedAt: null,
    ackedBy: null,
  };

  return withDbFallback(async () => {
    await pgPool.run('agent', `
      INSERT INTO ${MESSAGE_TABLE} (
        id, trace_id, run_id, incident_key, from_agent, to_agent,
        role, phase, visibility, payload, ack_required, created_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10::jsonb, $11, $12::timestamptz
      )
    `, [
      message.id,
      message.traceId,
      message.runId,
      message.incidentKey,
      message.from,
      message.to,
      message.role,
      message.phase,
      message.visibility,
      JSON.stringify(message.payload || {}),
      message.ackRequired,
      message.createdAt,
    ]);

    const discussion = message.incidentKey
      ? {
          incidentKey: message.incidentKey,
          messageIds: [message.id],
          updatedAt: message.createdAt,
        }
      : null;
    return {
      ok: true,
      message,
      discussion,
      storage: 'db',
    };
  }, async () => {
    messages.set(message.id, message);
    setMemoryIncidentReference(message);
    return {
      ok: true,
      message,
      discussion: message.incidentKey ? incidentDiscussions.get(message.incidentKey) : null,
      storage: 'memory_fallback',
    };
  });
}

async function ackAgentMessage(input) {
  const messageId = normalizeText(input.messageId);
  if (!messageId) return { ok: false, error: 'message_id_required' };
  const ackedBy = normalizeText(input.ackedBy, 'system');
  const ackedAt = new Date().toISOString();

  return withDbFallback(async () => {
    const row = await pgPool.get('agent', `
      UPDATE ${MESSAGE_TABLE}
      SET
        acked_at = NOW(),
        acked_by = $2
      WHERE id = $1
      RETURNING *
    `, [messageId, ackedBy]);
    if (!row) return { ok: false, error: 'message_not_found', storage: 'db' };
    return {
      ok: true,
      message: rowToMessage(row),
      storage: 'db',
    };
  }, async () => {
    const message = messages.get(messageId);
    if (!message) return { ok: false, error: 'message_not_found', storage: 'memory_fallback' };
    message.ackedAt = ackedAt;
    message.ackedBy = ackedBy;
    messages.set(messageId, message);
    return { ok: true, message, storage: 'memory_fallback' };
  });
}

async function getAgentStatus(input) {
  const agentId = normalizeText(input.agentId);
  const incidentKey = normalizeText(input.incidentKey);

  return withDbFallback(async () => {
    if (agentId) {
      const agentRow = await pgPool.get('agent', `
        SELECT
          agent_id,
          roles,
          tools,
          registered_at,
          last_heartbeat_at
        FROM ${AGENT_TABLE}
        WHERE agent_id = $1
      `, [agentId]);
      const agent = rowToAgent(agentRow);
      if (!agent) return { ok: false, error: 'agent_not_found', storage: 'db' };
      const messageRows = await pgPool.query('agent', `
        SELECT *
        FROM ${MESSAGE_TABLE}
        WHERE from_agent = $1 OR to_agent = $1
        ORDER BY created_at DESC
        LIMIT 10
      `, [agentId]);
      return {
        ok: true,
        agent,
        recent_messages: messageRows.map(rowToMessage).filter(Boolean),
        storage: 'db',
      };
    }
    if (incidentKey) {
      const rows = await pgPool.query('agent', `
        SELECT *
        FROM ${MESSAGE_TABLE}
        WHERE incident_key = $1
        ORDER BY created_at ASC
      `, [incidentKey]);
      return {
        ok: true,
        incidentKey,
        discussion: rows.length > 0 ? {
          incidentKey,
          messageIds: rows.map((row) => normalizeText(row.id)),
          updatedAt: normalizeText(rows[rows.length - 1]?.created_at, ''),
        } : null,
        messages: rows.map(rowToMessage).filter(Boolean),
        storage: 'db',
      };
    }
    const counts = await pgPool.get('agent', `
      SELECT
        (SELECT COUNT(*)::int FROM ${AGENT_TABLE}) AS total_agents,
        (SELECT COUNT(*)::int FROM ${MESSAGE_TABLE}) AS total_messages,
        (SELECT COUNT(DISTINCT incident_key)::int FROM ${MESSAGE_TABLE} WHERE incident_key IS NOT NULL) AS active_incidents
    `, []);
    return {
      ok: true,
      total_agents: Number(counts?.total_agents || 0),
      total_messages: Number(counts?.total_messages || 0),
      active_incidents: Number(counts?.active_incidents || 0),
      storage: 'db',
    };
  }, async () => {
    if (agentId) {
      const agent = agents.get(agentId);
      if (!agent) return { ok: false, error: 'agent_not_found', storage: 'memory_fallback' };
      const recent = [...messages.values()]
        .filter((message) => message.from === agentId || message.to === agentId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10);
      return { ok: true, agent, recent_messages: recent, storage: 'memory_fallback' };
    }
    if (incidentKey) {
      const discussion = incidentDiscussions.get(incidentKey);
      if (!discussion) return { ok: true, incidentKey, discussion: null, messages: [], storage: 'memory_fallback' };
      return {
        ok: true,
        incidentKey,
        discussion,
        messages: discussion.messageIds.map((id) => messages.get(id)).filter(Boolean),
        storage: 'memory_fallback',
      };
    }
    return {
      ok: true,
      total_agents: agents.size,
      total_messages: messages.size,
      active_incidents: incidentDiscussions.size,
      storage: 'memory_fallback',
    };
  });
}

module.exports = {
  registerAgent,
  listAgents,
  sendAgentMessage,
  ackAgentMessage,
  getAgentStatus,
};
