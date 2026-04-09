const mcp = require('./mcp') as {
  normalizeTask: (taskType: string) => string;
  recommendMcps: (team: string, taskType: string) => unknown[];
  buildMcpPlan: (team: string, taskType: string) => unknown[];
};

const skills = require('./skills') as {
  darwin: { sourceRanking: { rankSources: (items: unknown[]) => unknown } };
  justin: { citationAudit: { auditCitations: (citations: unknown[]) => unknown } };
  sigma: { dataQualityGuard: { evaluateDataset: (payload: Record<string, unknown>) => unknown } };
};

type SkillResult = Record<string, unknown> | null;

type PipelineInput = {
  team?: string;
  taskType?: string;
  task?: string;
  payload?: Record<string, unknown>;
};

function normalizeTask(taskType = ''): string {
  return mcp.normalizeTask(taskType);
}

export function selectSkill(team: string, taskType: string): string | null {
  const normalizedTask = normalizeTask(taskType);
  const map: Record<string, Record<string, string>> = {
    darwin: {
      research: 'darwin/source-ranking',
      source: 'darwin/source-ranking',
    },
    justin: {
      citation: 'justin/citation-audit',
      evidence: 'justin/citation-audit',
    },
    sigma: {
      quality: 'sigma/data-quality-guard',
      analysis: 'sigma/data-quality-guard',
      etl: 'sigma/data-quality-guard',
    },
  };

  return map[team]?.[normalizedTask] || null;
}

function getRunner(skillName: string | null): ((payload: Record<string, unknown>) => unknown) | null {
  const runners: Record<string, (payload: Record<string, unknown>) => unknown> = {
    'darwin/source-ranking': (payload) => skills.darwin.sourceRanking.rankSources((payload.items as unknown[]) || []),
    'justin/citation-audit': (payload) =>
      skills.justin.citationAudit.auditCitations((payload.citations as unknown[]) || []),
    'sigma/data-quality-guard': (payload) => skills.sigma.dataQualityGuard.evaluateDataset(payload || {}),
  };
  return skillName ? runners[skillName] || null : null;
}

export function runSkill(team: string, taskType: string, payload: Record<string, unknown> = {}) {
  const skillName = selectSkill(team, taskType);
  const runner = getRunner(skillName);
  if (!runner) {
    return {
      selected_skill: null,
      skill_result: null,
      error: 'no skill mapping',
    };
  }

  return {
    selected_skill: skillName,
    skill_result: runner(payload),
    error: null,
  };
}

export function shouldUseMcp(team: string, taskType: string, skillResult: SkillResult): boolean {
  const normalizedTask = normalizeTask(taskType);

  if (!skillResult) return false;

  if (team === 'darwin' && normalizedTask === 'research') {
    const ranked = Array.isArray(skillResult.ranked) ? skillResult.ranked : [];
    return ranked.some((item) => {
      const row = item as { risk_flags?: unknown[]; tier?: string };
      return (row.risk_flags || []).length > 0 || ['C', 'D'].includes(String(row.tier || ''));
    });
  }

  if (team === 'justin' && normalizedTask === 'citation') {
    const summary = (skillResult.summary as Record<string, unknown>) || {};
    return Number(summary.critical || 0) > 0 || Number(summary.high || 0) > 0;
  }

  if (team === 'sigma' && normalizedTask === 'quality') {
    return Array.isArray(skillResult.issues) && skillResult.issues.length > 0;
  }

  return false;
}

function getGate(team: string, taskType: string): string {
  const normalizedTask = normalizeTask(taskType);
  if (team === 'darwin' && normalizedTask === 'research') return 'read-only';
  if (team === 'justin') return 'validate';
  if (team === 'sigma') return 'validate';
  return 'read-only';
}

export function buildTeamPipeline(input: PipelineInput = {}) {
  const team = String(input.team || '').toLowerCase();
  const taskType = String(input.taskType || input.task || '').toLowerCase();
  const payload = input.payload || {};

  const { selected_skill, skill_result, error } = runSkill(team, taskType, payload) as {
    selected_skill: string | null;
    skill_result: SkillResult;
    error: string | null;
  };
  const useMcp = !error && shouldUseMcp(team, taskType, skill_result);
  const recommended = useMcp ? mcp.recommendMcps(team, taskType) : [];
  const plan = useMcp ? mcp.buildMcpPlan(team, taskType) : [];

  return {
    success: !error,
    team,
    task: normalizeTask(taskType),
    selected_skill,
    skill_result,
    should_use_mcp: useMcp,
    recommended_mcps: recommended,
    mcp_plan: plan,
    gate: getGate(team, taskType),
    error,
  };
}
