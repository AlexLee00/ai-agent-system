import pgPool = require('./pg-pool');

type EmotionState = {
  confidence?: number;
  fatigue?: number;
  motivation?: number;
};

type AgentRow = {
  id: number;
  name: string;
  display_name?: string;
  team?: string | null;
  role?: string | null;
  specialty?: string | null;
  llm_model?: string | null;
  llm_fallback?: string | null;
  code_path?: string | null;
  is_always_on?: boolean;
  dot_character?: unknown;
  config?: unknown;
  status?: string | null;
  score?: number | string | null;
  updated_at?: string | Date | null;
  total_tasks?: number | string | null;
  success_count?: number | string | null;
  fail_count?: number | string | null;
  emotion_state?: EmotionState | null;
};

type ContractInput = {
  employer_team: string;
  task: string;
  requirements?: Record<string, unknown>;
  reward?: Record<string, unknown>;
  reward_config?: Record<string, unknown>;
  penalty?: Record<string, unknown>;
  penalty_config?: Record<string, unknown>;
};

type RegisterAgentInput = {
  name: string;
  display_name: string;
  team: string;
  role: string;
  specialty?: string | null;
  llm_model?: string | null;
  llm_fallback?: string | null;
  code_path?: string | null;
  is_always_on?: boolean;
  dot_character?: Record<string, unknown>;
  config?: Record<string, unknown>;
};

type PerformanceHistoryResult = {
  name: string;
  newScore: number;
  result: 'success' | 'fail';
  emotion: Required<EmotionState>;
};

type RegistryStats = {
  active_count?: number | string;
  idle_count?: number | string;
  learning_count?: number | string;
  always_on_count?: number | string;
  total_count?: number | string;
};

const TEAM_ALIASES: Record<string, string> = {
  research: 'darwin',
  legal: 'justin',
  data: 'sigma',
};

function normalizeTeam(team?: string | null): string {
  const key = String(team || '').trim().toLowerCase();
  return TEAM_ALIASES[key] || key;
}

async function getAgent(name: string): Promise<AgentRow | null> {
  return pgPool.get<AgentRow>('agent', 'SELECT * FROM agent.registry WHERE name = $1', [name]);
}

async function getAgentsByTeam(team: string): Promise<AgentRow[]> {
  return pgPool.query<AgentRow>('agent', 'SELECT * FROM agent.registry WHERE team = $1 ORDER BY score DESC, name', [normalizeTeam(team)]);
}

async function getTopAgents(role: string, limit = 3): Promise<AgentRow[]> {
  return pgPool.query<AgentRow>(
    'agent',
    `SELECT * FROM agent.registry
     WHERE role = $1 AND status IN ('idle', 'active')
     ORDER BY score DESC, updated_at DESC
     LIMIT $2`,
    [role, limit],
  );
}

async function getLowPerformers(threshold = 5.0): Promise<AgentRow[]> {
  return pgPool.query<AgentRow>(
    'agent',
    `SELECT * FROM agent.registry
     WHERE score < $1 AND status != 'archived'
     ORDER BY score ASC, updated_at DESC`,
    [threshold],
  );
}

async function getAlwaysOnStatus(): Promise<AgentRow[]> {
  return pgPool.query<AgentRow>(
    'agent',
    `SELECT name, display_name, team, role, status, score, updated_at
     FROM agent.registry
     WHERE is_always_on = true
     ORDER BY team, name`,
  );
}

async function getAllAgents(): Promise<AgentRow[]> {
  return pgPool.query<AgentRow>(
    'agent',
    `SELECT *
     FROM agent.registry
     ORDER BY team, score DESC, name`,
  );
}

async function updateScore(
  name: string,
  taskScore: number | string,
  taskDescription: string,
  confidence: number | string | null = null,
): Promise<PerformanceHistoryResult | null> {
  const agent = await getAgent(name);
  if (!agent) return null;

  const numericScore = Number(taskScore);
  const newScore = Math.max(0, Math.min(10, Number(agent.score || 5) * 0.7 + numericScore * 0.3));
  const result: 'success' | 'fail' = numericScore >= 7.0 ? 'success' : 'fail';
  const emotion: Required<EmotionState> = {
    confidence: Number(agent.emotion_state?.confidence ?? 5),
    fatigue: Number(agent.emotion_state?.fatigue ?? 0),
    motivation: Number(agent.emotion_state?.motivation ?? 5),
  };

  if (result === 'success') {
    emotion.confidence = Math.min(10, emotion.confidence + 0.5);
    emotion.motivation = Math.min(10, emotion.motivation + 0.3);
  } else {
    emotion.confidence = Math.max(0, emotion.confidence - 0.8);
    emotion.motivation = Math.max(0, emotion.motivation - 0.5);
  }
  emotion.fatigue = Math.min(10, emotion.fatigue + 0.5);

  return pgPool.transaction<PerformanceHistoryResult>('agent', async (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => {
    const registrySql = result === 'success'
      ? `UPDATE agent.registry SET
           score = $1,
           total_tasks = total_tasks + 1,
           success_count = success_count + 1,
           emotion_state = $2::JSONB,
           updated_at = NOW()
         WHERE name = $3`
      : `UPDATE agent.registry SET
           score = $1,
           total_tasks = total_tasks + 1,
           fail_count = fail_count + 1,
           emotion_state = $2::JSONB,
           updated_at = NOW()
         WHERE name = $3`;

    await client.query(registrySql, [newScore.toFixed(2), JSON.stringify(emotion), name]);
    await client.query(
      `INSERT INTO agent.performance_history (
         agent_id, score, task_description, result, confidence_reported
       ) VALUES ($1, $2, $3, $4, $5)`,
      [agent.id, numericScore, taskDescription, result, confidence],
    );

    return { name, newScore: Number(newScore.toFixed(2)), result, emotion };
  });
}

async function updateStatus(name: string, status: string): Promise<AgentRow | null> {
  await pgPool.run(
    'agent',
    'UPDATE agent.registry SET status = $1, updated_at = NOW() WHERE name = $2',
    [status, name],
  );
  return getAgent(name);
}

async function createContract(agentName: string, contractData: ContractInput): Promise<{ contractId: number; agent: string; status: string | null | undefined }> {
  const agent = await getAgent(agentName);
  if (!agent) throw new Error(`Agent not found: ${agentName}`);

  const row = await pgPool.get<{ id: number; agent_id: number; status?: string | null }>(
    'agent',
    `INSERT INTO agent.contracts (
       agent_id, employer_team, task, requirements, reward_config, penalty_config
     ) VALUES ($1, $2, $3, $4::JSONB, $5::JSONB, $6::JSONB)
     RETURNING id, agent_id, status`,
    [
      agent.id,
      contractData.employer_team,
      contractData.task,
      JSON.stringify(contractData.requirements || {}),
      JSON.stringify(contractData.reward || contractData.reward_config || {}),
      JSON.stringify(contractData.penalty || contractData.penalty_config || {}),
    ],
  );

  await updateStatus(agentName, 'active');
  return { contractId: row?.id || 0, agent: agentName, status: row?.status };
}

async function completeContract(contractId: number, scoreResult: number | string): Promise<Record<string, unknown> | null> {
  const contract = await pgPool.get<{ id: number; agent_id: number; status?: string | null; score_result?: number | string | null }>(
    'agent',
    `UPDATE agent.contracts
     SET status = 'completed', score_result = $1, completed_at = NOW()
     WHERE id = $2
     RETURNING id, agent_id, status, score_result`,
    [scoreResult, contractId],
  );
  if (!contract) return null;

  const agent = await pgPool.get<{ name: string }>(
    'agent',
    'SELECT name FROM agent.registry WHERE id = $1',
    [contract.agent_id],
  );
  if (agent?.name) {
    await updateStatus(agent.name, 'idle');
  }
  return contract;
}

async function registerAgent(data: RegisterAgentInput): Promise<{ id: number; name: string } | null> {
  const normalizedTeam = normalizeTeam(data.team);
  return pgPool.get<{ id: number; name: string }>(
    'agent',
    `INSERT INTO agent.registry (
       name, display_name, team, role, specialty, llm_model,
       llm_fallback, code_path, is_always_on, dot_character, config
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::JSONB, $11::JSONB)
     ON CONFLICT (name) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       team = EXCLUDED.team,
       role = EXCLUDED.role,
       specialty = EXCLUDED.specialty,
       llm_model = EXCLUDED.llm_model,
       llm_fallback = EXCLUDED.llm_fallback,
       code_path = EXCLUDED.code_path,
       is_always_on = EXCLUDED.is_always_on,
       dot_character = EXCLUDED.dot_character,
       config = EXCLUDED.config,
       updated_at = NOW()
     RETURNING id, name`,
    [
      data.name,
      data.display_name,
      normalizedTeam,
      data.role,
      data.specialty || null,
      data.llm_model || null,
      data.llm_fallback || null,
      data.code_path || null,
      !!data.is_always_on,
      JSON.stringify(data.dot_character || {}),
      JSON.stringify(data.config || {}),
    ],
  );
}

async function getDashboardData(): Promise<{ agents: AgentRow[]; alwaysOn: AgentRow[]; stats: RegistryStats | null }> {
  const [agents, alwaysOn, stats] = await Promise.all([
    getAllAgents(),
    getAlwaysOnStatus(),
    pgPool.get<RegistryStats>(
      'agent',
      `SELECT
         count(*) FILTER (WHERE status = 'active') AS active_count,
         count(*) FILTER (WHERE status = 'idle') AS idle_count,
         count(*) FILTER (WHERE status = 'learning') AS learning_count,
         count(*) FILTER (WHERE is_always_on = true) AS always_on_count,
         count(*) AS total_count
       FROM agent.registry
       WHERE status != 'archived'`,
    ),
  ]);

  return { agents, alwaysOn, stats };
}

export = {
  normalizeTeam,
  getAgent,
  getAgentsByTeam,
  getTopAgents,
  getLowPerformers,
  getAlwaysOnStatus,
  getAllAgents,
  getDashboardData,
  updateScore,
  updateStatus,
  createContract,
  completeContract,
  registerAgent,
};
