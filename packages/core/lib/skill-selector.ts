const pgPool = require('./pg-pool');
const { normalizeTeam } = require('./agent-registry');

type SkillRow = {
  name?: string;
  team?: string | null;
  input_schema?: unknown;
  output_schema?: unknown;
  config?: unknown;
  score?: number | string;
  usage_count?: number | string;
  success_count?: number | string;
  fail_count?: number | string;
  avg_latency_ms?: number | string | null;
  [key: string]: unknown;
};

type NormalizedSkill = SkillRow & {
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  config: Record<string, unknown>;
  score: number;
  usage_count: number;
  success_count: number;
  fail_count: number;
  avg_latency_ms: number | null;
};

type Requirements = {
  preferredNames?: string[];
};

function _safeJson(value: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (value == null) return fallback;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return fallback;
  }
}

function _normalizeSkill(row: SkillRow | null | undefined): NormalizedSkill | null {
  if (!row) return null;
  return {
    ...row,
    input_schema: _safeJson(row.input_schema, {}),
    output_schema: _safeJson(row.output_schema, {}),
    config: _safeJson(row.config, {}),
    score: Number(row.score || 0),
    usage_count: Number(row.usage_count || 0),
    success_count: Number(row.success_count || 0),
    fail_count: Number(row.fail_count || 0),
    avg_latency_ms: row.avg_latency_ms == null ? null : Number(row.avg_latency_ms),
  };
}

function _rankSkill(skill: NormalizedSkill, requirements: Requirements = {}): number {
  const successRate = skill.usage_count > 0
    ? skill.success_count / Math.max(1, skill.usage_count)
    : 0.5;
  const latencyPenalty = skill.avg_latency_ms && skill.avg_latency_ms > 5000 ? -0.5 : 0;
  const preferredNames = Array.isArray(requirements.preferredNames) ? requirements.preferredNames : [];
  const preferredBonus = preferredNames.includes(String(skill.name || '')) ? 0.35 : 0;
  const teamBonus = skill.team ? 0.15 : 0;
  return skill.score + (successRate * 2) + latencyPenalty + preferredBonus + teamBonus;
}

async function listSkills(team: string | null = null, category: string | null = null): Promise<NormalizedSkill[]> {
  const normalizedTeam = team ? normalizeTeam(team) : null;
  const conditions = [`status = 'active'`];
  const params: unknown[] = [];

  if (normalizedTeam) {
    params.push(normalizedTeam);
    conditions.push(`(team = $${params.length} OR team IS NULL)`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  const rows = await pgPool.query(
    'agent',
    `SELECT *
     FROM agent.skills
     WHERE ${conditions.join(' AND ')}
     ORDER BY score DESC, usage_count DESC, updated_at DESC`,
    params,
  );
  return rows.map(_normalizeSkill).filter(Boolean) as NormalizedSkill[];
}

async function getSkill(name: string): Promise<NormalizedSkill | null> {
  const row = await pgPool.get('agent', 'SELECT * FROM agent.skills WHERE name = $1', [name]);
  return _normalizeSkill(row);
}

async function selectBestSkill(category: string, team: string | null = null, requirements: Requirements = {}): Promise<NormalizedSkill | null> {
  const candidates = await listSkills(team, category);
  if (!candidates.length) return null;

  const ranked = candidates.map((skill) => ({
    skill,
    adjustedScore: _rankSkill(skill, requirements),
  }));
  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return ranked[0]?.skill || null;
}

async function evaluateSkill(skillName: string, success: boolean, latencyMs: number | null = null): Promise<boolean> {
  const scoreAdj = success ? 0.15 : -0.10;
  const latencyValue = Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null;
  const counterColumn = success ? 'success_count' : 'fail_count';
  const result = await pgPool.run(
    'agent',
    `UPDATE agent.skills SET
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
    [scoreAdj, latencyValue, skillName],
  );
  return result.rowCount > 0;
}

async function registerSkill(data: Record<string, any>): Promise<NormalizedSkill | null> {
  const normalizedTeam = data.team ? normalizeTeam(data.team) : null;
  const row = await pgPool.get(
    'agent',
    `INSERT INTO agent.skills (
       name, display_name, team, category, code_path, description,
       input_schema, output_schema, score, status, config
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7::JSONB, $8::JSONB, $9, $10, $11::JSONB
     )
     ON CONFLICT (name) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       team = EXCLUDED.team,
       category = EXCLUDED.category,
       code_path = EXCLUDED.code_path,
       description = EXCLUDED.description,
       input_schema = EXCLUDED.input_schema,
       output_schema = EXCLUDED.output_schema,
       score = EXCLUDED.score,
       status = EXCLUDED.status,
       config = EXCLUDED.config,
       updated_at = NOW()
     RETURNING *`,
    [
      data.name,
      data.display_name,
      normalizedTeam,
      data.category,
      data.code_path || null,
      data.description || null,
      JSON.stringify(data.input_schema || {}),
      JSON.stringify(data.output_schema || {}),
      Number(data.score || 5),
      data.status || 'active',
      JSON.stringify(data.config || {}),
    ],
  );
  return _normalizeSkill(row);
}

export = {
  listSkills,
  getSkill,
  selectBestSkill,
  evaluateSkill,
  registerSkill,
};
