'use strict';

const pgPool = require('./pg-pool');
const registry = require('./agent-registry');

const SCORE_WEIGHTS = {
  BASE: 1.0,
  QUALITY_BONUS_MAX: 0.5,
  SPEED_BONUS_MAX: 0.2,
  QUALITY_FAIL_PENALTY: 0.5,
  DEADLINE_MISS_PENALTY: 0.3,
  HALLUCINATION_PENALTY: 1.0,
};

const CONFIDENCE_MULTIPLIER = {
  high_good: 1.2,
  high_bad: 0.7,
  low_good: 1.0,
  low_bad: 0.9,
  neutral: 1.0,
};

function _normalizeEmotionScore(value, fallback = 0) {
  const score = Number(value);
  return Number.isFinite(score) ? score : fallback;
}

function _getLunaRoleBonus(requestedRole, agentRole) {
  if (!requestedRole || !agentRole) return 0;
  if (requestedRole === agentRole) return 1.0;

  const families = {
    analyst: new Set(['analyst', 'analyst_short', 'analyst_long', 'fundamental', 'sentiment', 'onchain', 'macro', 'watcher', 'debater']),
    researcher: new Set(['analyst', 'analyst_short', 'analyst_long', 'fundamental', 'sentiment', 'onchain', 'macro', 'watcher']),
    risk: new Set(['risk', 'debater', 'macro']),
    executor: new Set(['executor', 'risk', 'debater']),
    watcher: new Set(['watcher', 'sentiment', 'onchain', 'macro']),
  };

  const family = families[requestedRole];
  return family?.has(agentRole) ? 0.45 : 0;
}

function _getTeamRoleAliases(team) {
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
      experiment: new Set(['experiment', 'experiment_designer']),
      experiment_designer: new Set(['experiment', 'experiment_designer']),
      feature: new Set(['feature', 'feature_engineer']),
      feature_engineer: new Set(['feature', 'feature_engineer']),
      quality: new Set(['quality', 'qa_sentinel', 'governance']),
      qa_sentinel: new Set(['quality', 'qa_sentinel']),
      observability: new Set(['observability', 'visualizer', 'visualization']),
      visualization: new Set(['visualization', 'visualizer']),
      visualizer: new Set(['visualizer', 'visualization']),
      governance: new Set(['governance']),
      analyst: new Set(['analyst']),
    };
  }

  return {};
}

function _matchRole(team, requestedRole, agentRole) {
  if (!requestedRole) return true;
  if (requestedRole === agentRole) return true;

  const aliases = _getTeamRoleAliases(team);
  const family = aliases[requestedRole];
  return family ? family.has(agentRole) : false;
}

async function selectBestAgent(role, team = null, requirements = {}) {
  const limit = Number.isFinite(Number(requirements.limit)) ? Number(requirements.limit) : 5;

  // team이 주어지면 항상 팀 내에서만 검색 (글로벌 폴백 금지!)
  let candidates;
  if (team) {
    const teamAgents = await registry.getAgentsByTeam(team);
    candidates = teamAgents.filter((a) => _matchRole(team, role, a.role));
    if (!candidates.length) candidates = teamAgents; // 팀 내 폴백 (role 무관)
  } else {
    candidates = await registry.getTopAgents(role, limit);
  }
  if (!candidates || candidates.length === 0) return null;

  const ranked = candidates.map((agent) => {
    const emotion = agent.emotion_state || {};
    const fatigue = _normalizeEmotionScore(emotion.fatigue, 0);
    const confidence = _normalizeEmotionScore(emotion.confidence, 5);
    const roleBonus = team === 'luna' ? _getLunaRoleBonus(role, agent.role) : 0;
    const adjustedScore = Number(agent.score || 0) - (fatigue * 0.1) + (confidence * 0.05) + roleBonus;
    return { agent, adjustedScore };
  });

  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return ranked[0]?.agent || null;
}

async function hire(agentName, taskData = {}) {
  return registry.createContract(agentName, {
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

function calculateScore(result = {}, requirements = {}, confidence = null) {
  const {
    BASE,
    QUALITY_BONUS_MAX,
    SPEED_BONUS_MAX,
    QUALITY_FAIL_PENALTY,
    DEADLINE_MISS_PENALTY,
    HALLUCINATION_PENALTY,
  } = SCORE_WEIGHTS;

  const qualityMin = Number(requirements.quality_min || 7.0);
  const resultQuality = Number(result.quality || 5.0);
  const deadlineMs = Number(requirements.deadline_ms || 300000);
  const actualMs = Number(result.duration_ms || deadlineMs);

  let raw = BASE;

  if (resultQuality >= qualityMin) {
    raw += QUALITY_BONUS_MAX * (resultQuality - qualityMin) / Math.max(1, (10 - qualityMin));
  }
  if (actualMs < deadlineMs) {
    raw += SPEED_BONUS_MAX * (deadlineMs - actualMs) / Math.max(1, deadlineMs);
  }
  if (resultQuality < qualityMin) {
    raw -= QUALITY_FAIL_PENALTY * Math.max(0, qualityMin - resultQuality) / Math.max(1, qualityMin);
  }
  if (actualMs > deadlineMs) {
    raw -= DEADLINE_MISS_PENALTY;
  }
  if (result.hallucination) {
    raw -= HALLUCINATION_PENALTY;
  }

  raw = Math.max(0, Math.min(10, raw * 5));

  if (confidence != null) {
    const conf = Number(confidence);
    let multiplierKey = 'neutral';
    if (conf >= 7 && resultQuality >= 8) multiplierKey = 'high_good';
    else if (conf >= 7 && resultQuality < 6) multiplierKey = 'high_bad';
    else if (conf < 5 && resultQuality >= 8) multiplierKey = 'low_good';
    else if (conf < 5 && resultQuality < 6) multiplierKey = 'low_bad';
    raw *= CONFIDENCE_MULTIPLIER[multiplierKey];
  }

  return Math.max(0, Math.min(10, raw));
}

async function evaluate(contractId, result = {}, confidence = null) {
  const contract = await pgPool.get('agent', 'SELECT * FROM agent.contracts WHERE id = $1', [contractId]);
  if (!contract) throw new Error(`Contract not found: ${contractId}`);

  const requirements = contract.requirements || {};
  const score = calculateScore(result, requirements, confidence);

  await registry.completeContract(contractId, score);

  const agent = await pgPool.get('agent', 'SELECT name FROM agent.registry WHERE id = $1', [contract.agent_id]);
  if (agent?.name) {
    await registry.updateScore(agent.name, score, contract.task, confidence);
  }

  return { contractId, score, agent: agent?.name || null };
}

async function getLowPerformersForRehab(threshold = 4.0) {
  const low = await registry.getLowPerformers(threshold);
  return low.map((agent) => ({
    name: agent.name,
    team: agent.team,
    score: Number(agent.score),
    totalTasks: agent.total_tasks,
    failCount: agent.fail_count,
    emotion: agent.emotion_state,
  }));
}

module.exports = {
  selectBestAgent,
  hire,
  calculateScore,
  evaluate,
  getLowPerformersForRehab,
  SCORE_WEIGHTS,
  CONFIDENCE_MULTIPLIER,
};
