import pgPool = require('./pg-pool');
import agentRegistry = require('./agent-registry');

type ToolRequirements = {
  preferredTypes?: string[];
};

type ToolRow = {
  name: string;
  display_name: string;
  type: string;
  team?: string | null;
  endpoint?: string | null;
  capabilities?: unknown;
  auth_config?: unknown;
  score?: number | string | null;
  usage_count?: number | string | null;
  success_count?: number | string | null;
  fail_count?: number | string | null;
  avg_latency_ms?: number | string | null;
  cost_per_call?: number | string | null;
  status?: string | null;
  config?: unknown;
};

type NormalizedTool = Omit<ToolRow, 'capabilities' | 'auth_config' | 'config'> & {
  capabilities: unknown[];
  auth_config: Record<string, unknown>;
  config: Record<string, unknown>;
  score: number;
  usage_count: number;
  success_count: number;
  fail_count: number;
  avg_latency_ms: number | null;
  cost_per_call: number;
};

type ToolInsert = {
  name: string;
  display_name: string;
  type: string;
  team?: string | null;
  endpoint?: string | null;
  capabilities?: unknown[];
  auth_config?: Record<string, unknown>;
  score?: number;
  cost_per_call?: number;
  status?: string;
  config?: Record<string, unknown>;
};

const { normalizeTeam } = agentRegistry as {
  normalizeTeam: (team?: string | null) => string;
};

function safeJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function normalizeTool(row: ToolRow | null | undefined): NormalizedTool | null {
  if (!row) return null;
  return {
    ...row,
    capabilities: safeJson(row.capabilities, [] as unknown[]),
    auth_config: safeJson(row.auth_config, {} as Record<string, unknown>),
    config: safeJson(row.config, {} as Record<string, unknown>),
    score: Number(row.score || 0),
    usage_count: Number(row.usage_count || 0),
    success_count: Number(row.success_count || 0),
    fail_count: Number(row.fail_count || 0),
    avg_latency_ms: row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
    cost_per_call: Number(row.cost_per_call || 0),
  };
}

function rankTool(tool: NormalizedTool, requirements: ToolRequirements = {}): number {
  const successRate = tool.usage_count > 0
    ? tool.success_count / Math.max(1, tool.usage_count)
    : 0.5;
  const latencyPenalty = tool.avg_latency_ms && tool.avg_latency_ms > 10000 ? -1.0 : 0;
  const costBonus = tool.cost_per_call === 0 ? 0.5 : 0;
  const preferredTypes = Array.isArray(requirements.preferredTypes) ? requirements.preferredTypes : [];
  const preferredBonus = preferredTypes.includes(tool.type) ? 0.25 : 0;
  const teamBonus = tool.team ? 0.15 : 0;
  return tool.score + (successRate * 2) + latencyPenalty + costBonus + preferredBonus + teamBonus;
}

export async function listTools(team: string | null = null, capability: string | null = null): Promise<NormalizedTool[]> {
  const normalizedTeam = team ? normalizeTeam(team) : null;
  const conditions = [`status = 'active'`];
  const params: Array<string> = [];

  if (normalizedTeam) {
    params.push(normalizedTeam);
    conditions.push(`(team = $${params.length} OR team IS NULL)`);
  }
  if (capability) {
    params.push(capability);
    conditions.push(`capabilities @> jsonb_build_array($${params.length}::TEXT)`);
  }

  const rows = await pgPool.query(
    'agent',
    `SELECT *
     FROM agent.tools
     WHERE ${conditions.join(' AND ')}
     ORDER BY score DESC, usage_count DESC, updated_at DESC`,
    params,
  ) as ToolRow[];
  return rows.map((row) => normalizeTool(row)).filter((row): row is NormalizedTool => row !== null);
}

export async function getTool(name: string): Promise<NormalizedTool | null> {
  const row = await pgPool.get('agent', 'SELECT * FROM agent.tools WHERE name = $1', [name]) as ToolRow | null;
  return normalizeTool(row);
}

export async function selectBestTool(
  capability: string,
  team: string | null = null,
  requirements: ToolRequirements = {},
): Promise<NormalizedTool | null> {
  const candidates = await listTools(team, capability);
  if (!candidates.length) return null;

  const ranked = candidates.map((tool) => ({
    tool,
    adjustedScore: rankTool(tool, requirements),
  }));
  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return ranked[0]?.tool || null;
}

export async function evaluateTool(
  toolName: string,
  success: boolean,
  latencyMs: number | null = null,
): Promise<boolean> {
  const scoreAdj = success ? 0.12 : -0.08;
  const latencyValue = Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null;
  const counterColumn = success ? 'success_count' : 'fail_count';
  const result = await pgPool.run(
    'agent',
    `UPDATE agent.tools SET
       usage_count = usage_count + 1,
       ${counterColumn} = ${counterColumn} + 1,
       score = GREATEST(1.0, LEAST(10.0, score + $1)),
       avg_latency_ms = CASE
         WHEN $2::INTEGER IS NULL THEN avg_latency_ms
         WHEN avg_latency_ms IS NULL THEN $2
         ELSE ((avg_latency_ms + $2) / 2)
       END,
       updated_at = NOW()
     WHERE name = $3`,
    [scoreAdj, latencyValue, toolName],
  );
  return result.rowCount > 0;
}

export async function registerTool(data: ToolInsert): Promise<NormalizedTool | null> {
  const normalizedTeam = data.team ? normalizeTeam(data.team) : null;
  const row = await pgPool.get(
    'agent',
    `INSERT INTO agent.tools (
       name, display_name, type, team, endpoint, capabilities,
       auth_config, score, cost_per_call, status, config
     ) VALUES (
       $1, $2, $3, $4, $5, $6::JSONB,
       $7::JSONB, $8, $9, $10, $11::JSONB
     )
     ON CONFLICT (name) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       type = EXCLUDED.type,
       team = EXCLUDED.team,
       endpoint = EXCLUDED.endpoint,
       capabilities = EXCLUDED.capabilities,
       auth_config = EXCLUDED.auth_config,
       score = EXCLUDED.score,
       cost_per_call = EXCLUDED.cost_per_call,
       status = EXCLUDED.status,
       config = EXCLUDED.config,
       updated_at = NOW()
     RETURNING *`,
    [
      data.name,
      data.display_name,
      data.type,
      normalizedTeam,
      data.endpoint || null,
      JSON.stringify(data.capabilities || []),
      JSON.stringify(data.auth_config || {}),
      Number(data.score || 5),
      Number(data.cost_per_call || 0),
      data.status || 'active',
      JSON.stringify(data.config || {}),
    ],
  ) as ToolRow | null;
  return normalizeTool(row);
}
