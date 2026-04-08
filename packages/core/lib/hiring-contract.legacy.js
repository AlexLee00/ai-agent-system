'use strict';

const pgPool = require('./pg-pool');
const registry = require('./agent-registry');

/**
 * @typedef {Object} HiringRequirements
 * @property {number} [limit]
 * @property {'balanced'|'greedy'|'explore'} [mode]
 * @property {string} [taskHint]
 * @property {string[]} [excludeNames]
 * @property {{ agentWeights?: Record<string, number> }} [regimeGuide]
 * @property {number} [quality_min]
 * @property {number} [deadline_ms]
 */

/**
 * @typedef {Object} HiringResult
 * @property {number} [quality]
 * @property {number} [duration_ms]
 * @property {boolean} [hallucination]
 */

/**
 * @typedef {Object} ContractTaskData
 * @property {string} [team]
 * @property {string} [employer_team]
 * @property {string} [employerTeam]
 * @property {string} [description]
 * @property {string} [task]
 * @property {HiringRequirements} [requirements]
 * @property {object} [reward]
 * @property {object} [penalty]
 */

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

function _getJustinSpecialtyBonus(taskHint, agentSpecialty) {
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

function _getSigmaSpecialtyBonus(taskHint, agentSpecialty) {
  if (!taskHint || !agentSpecialty) return 0;
  const hint = String(taskHint).toLowerCase();
  const spec = String(agentSpecialty).toLowerCase();
  const isRiskHint = hint.includes('리스크') || hint.includes('실패') || hint.includes('문제') || hint.includes('병목');
  const isGrowthHint = hint.includes('성장') || hint.includes('성공') || hint.includes('기회') || hint.includes('확대');
  const isTrendHint = hint.includes('추세') || hint.includes('트렌드') || hint.includes('장기') || hint.includes('주간') || hint.includes('월간');

  if (isRiskHint && (spec.includes('비판적') || spec.includes('실패패턴') || spec.includes('병목탐지'))) return 2.5;
  if (isGrowthHint && (spec.includes('낙관적') || spec.includes('성공패턴') || spec.includes('강점강화'))) return 2.5;
  if (isTrendHint && (spec.includes('장기') || spec.includes('추세분석') || spec.includes('구조적변화'))) return 2.5;

  if ((hint.includes('etl') || hint.includes('파이프라인') || hint.includes('수집') || hint.includes('전처리'))
    && spec.includes('파이프라인')) return 1.5;
  if (!isRiskHint && !isGrowthHint && !isTrendHint
    && (hint.includes('분석') || hint.includes('통계') || hint.includes('인사이트'))
    && spec.includes('분석')) return 1.5;
  if ((hint.includes('ml') || hint.includes('모델') || hint.includes('학습') || hint.includes('추론'))
    && spec.includes('ml')) return 1.5;
  if ((hint.includes('시각화') || hint.includes('대시보드') || hint.includes('리포트'))
    && spec.includes('시각화')) return 1.5;
  if ((hint.includes('거버넌스') || hint.includes('품질') || hint.includes('카탈로그'))
    && spec.includes('거버넌스')) return 1.5;
  if ((hint.includes('rag') || hint.includes('지식') || hint.includes('triplet') || hint.includes('standing'))
    && (spec.includes('rag') || spec.includes('지식그래프') || spec.includes('standingorders'))) return 1.5;
  if ((hint.includes('워크플로우') || hint.includes('병목') || hint.includes('최적화') || hint.includes('비용'))
    && spec.includes('워크플로우')) return 1.5;
  if ((hint.includes('예측') || hint.includes('forecast') || hint.includes('포캐스트'))
    && spec.includes('예측')) return 1.5;

  return 0;
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

function _matchRole(team, requestedRole, agentRole) {
  if (!requestedRole) return true;
  if (requestedRole === agentRole) return true;

  const aliases = _getTeamRoleAliases(team);
  const family = aliases[requestedRole];
  return family ? family.has(agentRole) : false;
}

async function selectBestAgent(role, team = null, requirements = {}) {
  const limit = Number.isFinite(Number(requirements.limit)) ? Number(requirements.limit) : 5;
  const mode = requirements.mode || 'balanced';
  const taskHint = String(requirements.taskHint || '').trim().toLowerCase();
  const excludeNames = new Set(
    Array.isArray(requirements.excludeNames)
      ? requirements.excludeNames.map((name) => String(name || '').trim()).filter(Boolean)
      : []
  );

  let candidates;
  if (team) {
    const teamAgents = await registry.getAgentsByTeam(team);
    candidates = teamAgents.filter((a) => _matchRole(team, role, a.role));
    if (!candidates.length) candidates = teamAgents;
  } else {
    candidates = await registry.getTopAgents(role, limit);
  }
  if (!candidates || candidates.length === 0) return null;

  if (excludeNames.size > 0) {
    candidates = candidates.filter((agent) => !excludeNames.has(String(agent.name || '').trim()));
  }
  if (!candidates || candidates.length === 0) return null;

  const ranked = candidates.map((agent) => {
    const emotion = agent.emotion_state || {};
    const fatigue = _normalizeEmotionScore(emotion.fatigue, 0);
    const confidence = _normalizeEmotionScore(emotion.confidence, 5);
    const roleBonus = team === 'luna' ? _getLunaRoleBonus(role, agent.role) : 0;
    const specialty = String(agent.specialty || '').toLowerCase();
    let specialtyBonus =
      team === 'justin' ? _getJustinSpecialtyBonus(taskHint, specialty) :
      team === 'sigma' ? _getSigmaSpecialtyBonus(taskHint, specialty) :
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
  const decorate = (rankedItem) => (
    rankedItem?.agent
      ? { ...rankedItem.agent, adjustedScore: rankedItem.adjustedScore, regimeWeight: rankedItem.regimeWeight }
      : null
  );
  if (mode === 'greedy') {
    return decorate(ranked[0]);
  }

  if (mode === 'explore') {
    const idx = Math.floor(Math.random() * ranked.length);
    return decorate(ranked[idx]);
  }

  const EPSILON = 0.2;
  if (Math.random() < EPSILON && ranked.length > 1) {
    const explorePool = ranked.slice(1);
    const idx = Math.floor(Math.random() * explorePool.length);
    const chosen = explorePool[idx]?.agent;
    if (chosen) {
      console.log(`[고용] ε-탐색: ${chosen.name} 선택 (최고 ${ranked[0].agent.name} 대신)`);
    }
    return chosen
      ? decorate(explorePool[idx])
      : decorate(ranked[0]);
  }

  return decorate(ranked[0]);
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
