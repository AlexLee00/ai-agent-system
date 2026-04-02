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

async function selectBestAgent(role, team = null, requirements = {}) {
  const limit = Number.isFinite(Number(requirements.limit)) ? Number(requirements.limit) : 5;
  const candidates = await registry.getTopAgents(role, limit);
  if (!candidates || candidates.length === 0) return null;

  let filtered = team
    ? candidates.filter((agent) => agent.team === team)
    : candidates;

  if (!filtered.length) filtered = candidates;

  const ranked = filtered.map((agent) => {
    const emotion = agent.emotion_state || {};
    const fatigue = _normalizeEmotionScore(emotion.fatigue, 0);
    const confidence = _normalizeEmotionScore(emotion.confidence, 5);
    const adjustedScore = Number(agent.score || 0) - (fatigue * 0.1) + (confidence * 0.05);
    return { agent, adjustedScore };
  });

  ranked.sort((a, b) => b.adjustedScore - a.adjustedScore);
  return ranked[0]?.agent || null;
}

async function hire(agentName, taskData = {}) {
  return registry.createContract(agentName, {
    employer_team: taskData.team || taskData.employer_team || 'unknown',
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
