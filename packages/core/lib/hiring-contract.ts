import pgPool = require('./pg-pool');
import registry = require('./agent-registry');

type HiringMode = 'balanced' | 'greedy' | 'explore';

type HiringRequirements = {
  limit?: number;
  mode?: HiringMode;
  taskHint?: string;
  excludeNames?: string[];
  regimeGuide?: { agentWeights?: Record<string, number> };
  quality_min?: number;
  deadline_ms?: number;
};

type HiringResult = {
  quality?: number;
  duration_ms?: number;
  hallucination?: boolean;
};

type ContractTaskData = {
  team?: string;
  employer_team?: string;
  employerTeam?: string;
  description?: string;
  task?: string;
  requirements?: HiringRequirements;
  reward?: Record<string, unknown>;
  penalty?: Record<string, unknown>;
};

type EmotionState = {
  confidence?: number;
  fatigue?: number;
};

type AgentCandidate = {
  id?: number;
  name: string;
  team?: string | null;
  role?: string | null;
  specialty?: string | null;
  score?: number | string | null;
  total_tasks?: number | string | null;
  fail_count?: number | string | null;
  emotion_state?: EmotionState | null;
  adjustedScore?: number;
  regimeWeight?: number;
  [key: string]: unknown;
};

type RankedAgent = {
  agent: AgentCandidate;
  adjustedScore: number;
  regimeWeight: number;
};

type ContractRow = {
  agent_id: number;
  requirements?: HiringRequirements | null;
  task?: string;
};

const registryApi = registry as unknown as {
  getAgentsByTeam: (team: string) => Promise<AgentCandidate[]>;
  getTopAgents: (role: string, limit?: number) => Promise<AgentCandidate[]>;
  createContract: (agentName: string, data: {
    employer_team: string;
    task: string;
    requirements?: HiringRequirements;
    reward?: Record<string, unknown>;
    penalty?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  completeContract: (contractId: string | number, score: number) => Promise<unknown>;
  updateScore: (name: string, score: number, taskDescription: string, confidence?: number | null) => Promise<unknown>;
  getLowPerformers: (threshold?: number) => Promise<AgentCandidate[]>;
};

const SCORE_WEIGHTS = {
  BASE: 1.0,
  QUALITY_BONUS_MAX: 0.5,
  SPEED_BONUS_MAX: 0.2,
  QUALITY_FAIL_PENALTY: 0.5,
  DEADLINE_MISS_PENALTY: 0.3,
  HALLUCINATION_PENALTY: 1.0,
} as const;

const CONFIDENCE_MULTIPLIER: Record<string, number> = {
  high_good: 1.2,
  high_bad: 0.7,
  low_good: 1.0,
  low_bad: 0.9,
  neutral: 1.0,
};

function normalizeEmotionScore(value: unknown, fallback = 0): number {
  const score = Number(value);
  return Number.isFinite(score) ? score : fallback;
}

function getLunaRoleBonus(requestedRole: string, agentRole: string | null | undefined): number {
  if (!requestedRole || !agentRole) return 0;
  if (requestedRole === agentRole) return 1.0;

  const families: Record<string, Set<string>> = {
    analyst: new Set(['analyst', 'analyst_short', 'analyst_long', 'fundamental', 'sentiment', 'onchain', 'macro', 'watcher', 'debater']),
    researcher: new Set(['analyst', 'analyst_short', 'analyst_long', 'fundamental', 'sentiment', 'onchain', 'macro', 'watcher']),
    risk: new Set(['risk', 'debater', 'macro']),
    executor: new Set(['executor', 'risk', 'debater']),
    watcher: new Set(['watcher', 'sentiment', 'onchain', 'macro']),
  };

  const family = families[requestedRole];
  return family?.has(agentRole) ? 0.45 : 0;
}

function getJustinSpecialtyBonus(taskHint: string, agentSpecialty: string): number {
  if (!taskHint || !agentSpecialty) return 0;
  const hint = String(taskHint).toLowerCase();
  const spec = String(agentSpecialty).toLowerCase();

  if ((hint.includes('소스코드') || hint.includes('코드 분석')) && spec.includes('소스코드')) return 1.5;
  if ((hint.includes('국내 판례') || hint.includes('국내')) && spec.includes('국내판례')) return 1.5;
  if ((hint.includes('해외 판례') || hint.includes('해외')) && spec.includes('해외판례')) return 1.5;
  if (hint.includes('원고') && spec.includes('원고자료')) return 1.5;
  if (hint.includes('피고') && spec.includes('피고자료')) return 1.5;
  if (hint.includes('계약') && spec.includes('계약서검토')) return 1.5;
  if ((hint.includes('감정서') || hint.includes('초안') || hint.includes('작성')) && spec.includes('감정서초안')) return 1.5;
  if ((hint.includes('품질') || hint.includes('검증') || hint.includes('리뷰')) && (spec.includes('품질검증') || spec.includes('객관성심사'))) return 1.5;

  if ((hint.includes('소스코드') || hint.includes('코드 분석')) && spec.includes('코드')) return 1.0;
  if ((hint.includes('국내 판례') || hint.includes('국내')) && spec.includes('국내')) return 1.0;
  if ((hint.includes('해외 판례') || hint.includes('해외')) && spec.includes('해외')) return 1.0;
  if (hint.includes('원고') && spec.includes('원고')) return 1.0;
  if (hint.includes('피고') && spec.includes('피고')) return 1.0;
  if (hint.includes('계약') && spec.includes('계약')) return 1.0;
  if ((hint.includes('감정서') || hint.includes('초안') || hint.includes('작성')) && spec.includes('감정')) return 1.0;
  if ((hint.includes('품질') || hint.includes('검증') || hint.includes('리뷰')) && (spec.includes('품질') || spec.includes('검증'))) return 1.0;

  return 0;
}

function getSigmaSpecialtyBonus(taskHint: string, agentSpecialty: string): number {
  if (!taskHint || !agentSpecialty) return 0;
  const hint = String(taskHint).toLowerCase();
  const spec = String(agentSpecialty).toLowerCase();
  const isRiskHint = hint.includes('리스크') || hint.includes('실패') || hint.includes('문제') || hint.includes('병목');
  const isGrowthHint = hint.includes('성장') || hint.includes('성공') || hint.includes('기회') || hint.includes('확대');
  const isTrendHint = hint.includes('추세') || hint.includes('트렌드') || hint.includes('장기') || hint.includes('주간') || hint.includes('월간');

  if (isRiskHint && (spec.includes('비판적') || spec.includes('실패패턴') || spec.includes('병목탐지'))) return 2.5;
  if (isGrowthHint && (spec.includes('낙관적') || spec.includes('성공패턴') || spec.includes('강점강화'))) return 2.5;
  if (isTrendHint && (spec.includes('장기') || spec.includes('추세분석') || spec.includes('구조적변화'))) return 2.5;

  if ((hint.includes('etl') || hint.includes('파이프라인') || hint.includes('수집') || hint.includes('전처리')) && spec.includes('파이프라인')) return 1.5;
  if (!isRiskHint && !isGrowthHint && !isTrendHint && (hint.includes('분석') || hint.includes('통계') || hint.includes('인사이트')) && spec.includes('분석')) return 1.5;
  if ((hint.includes('ml') || hint.includes('모델') || hint.includes('학습') || hint.includes('추론')) && spec.includes('ml')) return 1.5;
  if ((hint.includes('시각화') || hint.includes('대시보드') || hint.includes('리포트')) && spec.includes('시각화')) return 1.5;
  if ((hint.includes('거버넌스') || hint.includes('품질') || hint.includes('카탈로그')) && spec.includes('거버넌스')) return 1.5;
  if ((hint.includes('rag') || hint.includes('지식') || hint.includes('triplet') || hint.includes('standing')) && (spec.includes('rag') || spec.includes('지식그래프') || spec.includes('standingorders'))) return 1.5;
  if ((hint.includes('워크플로우') || hint.includes('병목') || hint.includes('최적화') || hint.includes('비용')) && spec.includes('워크플로우')) return 1.5;
  if ((hint.includes('예측') || hint.includes('forecast') || hint.includes('포캐스트')) && spec.includes('예측')) return 1.5;

  return 0;
}

function getTeamRoleAliases(team: string | null): Record<string, Set<string>> {
  if (team === 'darwin') {
    return {
      synthesis: new Set(['synthesis', 'synthesizer']),
      synthesizer: new Set(['synthesis', 'synthesizer']),
      verify: new Set(['reviewer', 'source_auditor', 'replicator', 'counterexample']),
      research: new Set(['researcher', 'searcher', 'synthesizer']),
      researcher: new Set(['researcher', 'searcher', 'synthesizer']),
      searcher: new Set(['searcher', 'researcher']),
      reviewer: new Set(['reviewer', 'source_auditor', 'counterexample']),
    };
  }

  if (team === 'justin') {
    return {
      verify: new Set(['reviewer', 'citation_verifier', 'judge_simulator']),
      reviewer: new Set(['reviewer', 'citation_verifier', 'judge_simulator']),
      evidence: new Set(['evidence_mapper', 'precedent_comparer', 'damages_analyst']),
      analyst: new Set(['analyst', 'citation_verifier', 'evidence_mapper', 'precedent_comparer', 'damages_analyst']),
      writer: new Set(['writer']),
    };
  }

  if (team === 'sigma') {
    return {
      etl: new Set(['etl', 'engineer']),
      engineer: new Set(['engineer', 'etl']),
      ml: new Set(['ml', 'ml_engineer']),
      ml_engineer: new Set(['ml_engineer', 'ml']),
      workflow: new Set(['workflow']),
      rag: new Set(['rag', 'governance']),
      predictor: new Set(['predictor', 'ml_engineer']),
      experiment: new Set(['experiment', 'experiment_designer']),
      experiment_designer: new Set(['experiment', 'experiment_designer']),
      feature: new Set(['feature', 'feature_engineer']),
      feature_engineer: new Set(['feature', 'feature_engineer']),
      quality: new Set(['quality', 'qa_sentinel', 'governance']),
      qa_sentinel: new Set(['quality', 'qa_sentinel']),
      observability: new Set(['observability', 'visualizer', 'visualization']),
      visualization: new Set(['visualization', 'visualizer']),
      visualizer: new Set(['visualizer', 'visualization']),
      governance: new Set(['governance', 'rag']),
      analyst: new Set(['analyst']),
    };
  }

  return {};
}

function matchRole(team: string | null, requestedRole: string, agentRole: string | null | undefined): boolean {
  if (!requestedRole) return true;
  if (requestedRole === agentRole) return true;

  const aliases = getTeamRoleAliases(team);
  const family = aliases[requestedRole];
  return family ? family.has(String(agentRole || '')) : false;
}

function decorateRanked(rankedItem: RankedAgent | undefined): AgentCandidate | null {
  return rankedItem?.agent
    ? { ...rankedItem.agent, adjustedScore: rankedItem.adjustedScore, regimeWeight: rankedItem.regimeWeight }
    : null;
}

async function selectBestAgent(role: string, team: string | null = null, requirements: HiringRequirements = {}): Promise<AgentCandidate | null> {
  const limit = Number.isFinite(Number(requirements.limit)) ? Number(requirements.limit) : 5;
  const mode = requirements.mode || 'balanced';
  const taskHint = String(requirements.taskHint || '').trim().toLowerCase();
  const excludeNames = new Set(
    Array.isArray(requirements.excludeNames)
      ? requirements.excludeNames.map((name) => String(name || '').trim()).filter(Boolean)
      : [],
  );

  let candidates: AgentCandidate[];
  if (team) {
    const teamAgents = await registryApi.getAgentsByTeam(team);
    candidates = teamAgents.filter((agent) => matchRole(team, role, String(agent.role || '')));
    if (!candidates.length) candidates = teamAgents;
  } else {
    candidates = await registryApi.getTopAgents(role, limit);
  }
  if (!candidates.length) return null;

  if (excludeNames.size > 0) {
    candidates = candidates.filter((agent) => !excludeNames.has(String(agent.name || '').trim()));
  }
  if (!candidates.length) return null;

  const ranked = candidates.map((agent) => {
    const emotion = agent.emotion_state || {};
    const fatigue = normalizeEmotionScore(emotion.fatigue, 0);
    const confidence = normalizeEmotionScore(emotion.confidence, 5);
    const roleBonus = team === 'luna' ? getLunaRoleBonus(role, agent.role) : 0;
    const specialty = String(agent.specialty || '').toLowerCase();
    let specialtyBonus =
      team === 'justin' ? getJustinSpecialtyBonus(taskHint, specialty) :
      team === 'sigma' ? getSigmaSpecialtyBonus(taskHint, specialty) :
      0;
    if (!specialtyBonus && taskHint && specialty) {
      if (specialty.includes(taskHint) || taskHint.split(/\s+/).some((word) => word && specialty.includes(word))) {
        specialtyBonus = 1.0;
      }
    }
    const regimeWeight = Number(requirements.regimeGuide?.agentWeights?.[agent.name] || 1.0);
    const baseAdjustedScore = Number(agent.score || 0) - (fatigue * 0.1) + (confidence * 0.05) + roleBonus + specialtyBonus;
    const adjustedScore = baseAdjustedScore * regimeWeight;
    return { agent, adjustedScore, regimeWeight };
  });

  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);

  if (mode === 'greedy') return decorateRanked(ranked[0]);

  if (mode === 'explore') {
    const idx = Math.floor(Math.random() * ranked.length);
    return decorateRanked(ranked[idx]);
  }

  const epsilon = 0.2;
  if (Math.random() < epsilon && ranked.length > 1) {
    const explorePool = ranked.slice(1);
    const idx = Math.floor(Math.random() * explorePool.length);
    const chosen = explorePool[idx]?.agent;
    if (chosen) {
      console.log(`[고용] ε-탐색: ${chosen.name} 선택 (최고 ${ranked[0].agent.name} 대신)`);
    }
    return chosen ? decorateRanked(explorePool[idx]) : decorateRanked(ranked[0]);
  }

  return decorateRanked(ranked[0]);
}

async function hire(agentName: string, taskData: ContractTaskData = {}): Promise<Record<string, unknown>> {
  return registryApi.createContract(agentName, {
    employer_team: taskData.team || taskData.employer_team || taskData.employerTeam || 'unknown',
    task: taskData.description || taskData.task || '',
    requirements: taskData.requirements || {},
    reward: taskData.reward || {
      base_score: SCORE_WEIGHTS.BASE,
      quality_bonus: SCORE_WEIGHTS.QUALITY_BONUS_MAX,
      speed_bonus: SCORE_WEIGHTS.SPEED_BONUS_MAX,
    },
    penalty: taskData.penalty || {
      quality_fail: SCORE_WEIGHTS.QUALITY_FAIL_PENALTY,
      deadline_miss: SCORE_WEIGHTS.DEADLINE_MISS_PENALTY,
      hallucination: SCORE_WEIGHTS.HALLUCINATION_PENALTY,
    },
  });
}

function calculateScore(result: HiringResult = {}, requirements: HiringRequirements = {}, confidence: number | null = null): number {
  const qualityMin = Number(requirements.quality_min || 7.0);
  const resultQuality = Number(result.quality || 5.0);
  const deadlineMs = Number(requirements.deadline_ms || 300000);
  const actualMs = Number(result.duration_ms || deadlineMs);

  let raw: number = SCORE_WEIGHTS.BASE;

  if (resultQuality >= qualityMin) {
    raw += SCORE_WEIGHTS.QUALITY_BONUS_MAX * (resultQuality - qualityMin) / Math.max(1, 10 - qualityMin);
  }
  if (actualMs < deadlineMs) {
    raw += SCORE_WEIGHTS.SPEED_BONUS_MAX * (deadlineMs - actualMs) / Math.max(1, deadlineMs);
  }
  if (resultQuality < qualityMin) {
    raw -= SCORE_WEIGHTS.QUALITY_FAIL_PENALTY * Math.max(0, qualityMin - resultQuality) / Math.max(1, qualityMin);
  }
  if (actualMs > deadlineMs) {
    raw -= SCORE_WEIGHTS.DEADLINE_MISS_PENALTY;
  }
  if (result.hallucination) {
    raw -= SCORE_WEIGHTS.HALLUCINATION_PENALTY;
  }

  raw = Math.max(0, Math.min(10, raw * 5));

  if (confidence != null) {
    const conf = Number(confidence);
    let multiplierKey: keyof typeof CONFIDENCE_MULTIPLIER = 'neutral';
    if (conf >= 7 && resultQuality >= 8) multiplierKey = 'high_good';
    else if (conf >= 7 && resultQuality < 6) multiplierKey = 'high_bad';
    else if (conf < 5 && resultQuality >= 8) multiplierKey = 'low_good';
    else if (conf < 5 && resultQuality < 6) multiplierKey = 'low_bad';
    raw *= CONFIDENCE_MULTIPLIER[multiplierKey];
  }

  return Math.max(0, Math.min(10, raw));
}

async function evaluate(
  contractId: string | number,
  result: HiringResult = {},
  confidence: number | null = null,
): Promise<{ contractId: string | number; score: number; agent: string | null }> {
  const contract = await pgPool.get<ContractRow>('agent', 'SELECT * FROM agent.contracts WHERE id = $1', [contractId]);
  if (!contract) throw new Error(`Contract not found: ${contractId}`);

  const requirements = contract.requirements || {};
  const score = calculateScore(result, requirements, confidence);

  await registryApi.completeContract(contractId, score);

  const agent = await pgPool.get<{ name: string }>('agent', 'SELECT name FROM agent.registry WHERE id = $1', [contract.agent_id]);
  if (agent?.name) {
    await registryApi.updateScore(agent.name, score, String(contract.task || ''), confidence);
  }

  return { contractId, score, agent: agent?.name || null };
}

async function getLowPerformersForRehab(
  threshold = 4.0,
): Promise<Array<{ name: string; team: string | null | undefined; score: number; totalTasks: number | string | null | undefined; failCount: number | string | null | undefined; emotion: unknown }>> {
  const low = await registryApi.getLowPerformers(threshold);
  return low.map((agent) => ({
    name: agent.name,
    team: agent.team,
    score: Number(agent.score),
    totalTasks: agent.total_tasks,
    failCount: agent.fail_count,
    emotion: agent.emotion_state,
  }));
}

export = {
  selectBestAgent,
  hire,
  calculateScore,
  evaluate,
  getLowPerformersForRehab,
  SCORE_WEIGHTS,
  CONFIDENCE_MULTIPLIER,
};
