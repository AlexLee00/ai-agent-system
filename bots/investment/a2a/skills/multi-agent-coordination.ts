// @ts-nocheck
/**
 * A2A Skill: Multi-Agent Coordination
 *
 * Shadow-only coordinator for RL role agents. It normalizes the five-role DAG,
 * resolves conflicts, and emits an advisory plan without writing DB rows or
 * changing live trading decisions.
 */

import { query as defaultQuery } from '../../shared/db.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

const ROLE_SEQUENCE = ['analyst', 'data_scientist', 'strategy', 'trader', 'risk'];

const ROLE_WEIGHTS = {
  analyst: 0.22,
  data_scientist: 0.18,
  strategy: 0.22,
  trader: 0.18,
  risk: 0.2,
};

function normalizeAction(value) {
  const action = String(value || 'hold').trim().toLowerCase();
  return ['buy', 'sell', 'hold'].includes(action) ? action : 'hold';
}

function normalizeMarket(value) {
  const market = String(value || 'crypto').trim().toLowerCase();
  return ['crypto', 'stocks', 'domestic', 'overseas', 'korea'].includes(market) ? market : 'crypto';
}

function normalizeConfidence(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function defaultVotes() {
  return [
    { role: 'analyst', agent: 'analyst_agent', action: 'hold', confidence: 0.55, reason: 'no_external_vote' },
    { role: 'data_scientist', agent: 'data_scientist_agent', action: 'hold', confidence: 0.55, reason: 'no_external_vote' },
    { role: 'strategy', agent: 'strategy_agent', action: 'hold', confidence: 0.55, reason: 'no_external_vote' },
    { role: 'trader', agent: 'trader_agent', action: 'hold', confidence: 0.55, reason: 'no_external_vote' },
    { role: 'risk', agent: 'risk_agent', action: 'hold', confidence: 0.7, reason: 'risk_default_no_live_change' },
  ];
}

function normalizeVotes(inputVotes) {
  const votes = Array.isArray(inputVotes) && inputVotes.length ? inputVotes : defaultVotes();
  const byRole = {};
  for (const vote of votes) {
    const role = ROLE_SEQUENCE.includes(String(vote.role || '').toLowerCase())
      ? String(vote.role).toLowerCase()
      : String(vote.agent || '').toLowerCase().includes('risk')
        ? 'risk'
        : 'data_scientist';
    byRole[role] = {
      role,
      agent: String(vote.agent || `${role}_agent`),
      action: normalizeAction(vote.action),
      confidence: normalizeConfidence(vote.confidence),
      reason: String(vote.reason || 'provided_vote'),
    };
  }
  return ROLE_SEQUENCE.map((role) => byRole[role] || defaultVotes().find((vote) => vote.role === role));
}

async function fetchRoleLevels(queryFn, market) {
  try {
    const rows = await queryFn(`
      SELECT agent_name, current_level
      FROM investment.agent_curriculum_state
      WHERE market = $1
    `, [market]);
    const levels = {};
    for (const row of (Array.isArray(rows) ? rows : rows?.rows || [])) {
      levels[String(row.agent_name || '').toLowerCase()] = row.current_level || 'novice';
    }
    return levels;
  } catch (_err) {
    return {};
  }
}

function levelMultiplier(level) {
  if (level === 'expert') return 1.25;
  if (level === 'intermediate') return 1.0;
  return 0.8;
}

function resolveDecision(votes, levels) {
  const score = { buy: 0, sell: 0, hold: 0 };
  const weightedVotes = [];
  for (const vote of votes) {
    const roleWeight = ROLE_WEIGHTS[vote.role] || 0.1;
    const level = levels[String(vote.agent || '').toLowerCase()] || levels[vote.role] || 'novice';
    const weight = roleWeight * levelMultiplier(level) * vote.confidence;
    score[vote.action] += weight;
    weightedVotes.push({ ...vote, level, weight: Number(weight.toFixed(4)) });
  }

  const riskVote = weightedVotes.find((vote) => vote.role === 'risk');
  const riskVeto = riskVote && ['sell', 'hold'].includes(riskVote.action) && riskVote.confidence >= 0.82;
  let decision = Object.keys(score).sort((a, b) => score[b] - score[a])[0] || 'hold';
  if (riskVeto && decision === 'buy') decision = 'hold';
  const total = Object.values(score).reduce((sum, value) => sum + value, 0);
  const confidence = total > 0 ? Number((score[decision] / total).toFixed(3)) : 0;

  return {
    decision,
    confidence,
    score: Object.fromEntries(Object.entries(score).map(([k, v]) => [k, Number(v.toFixed(4))])),
    weightedVotes,
    riskVeto: Boolean(riskVeto),
  };
}

function buildDag() {
  return [
    { role: 'analyst', next: ['data_scientist', 'strategy'], output: 'signal_quality' },
    { role: 'data_scientist', next: ['strategy'], output: 'feature_consistency' },
    { role: 'strategy', next: ['trader', 'risk'], output: 'policy_candidate' },
    { role: 'trader', next: ['risk'], output: 'execution_candidate' },
    { role: 'risk', next: ['luna_commander'], output: 'risk_veto_or_clear' },
  ];
}

export async function runMultiAgentCoordination(input = {}, options = {}) {
  const queryFn = options.query || defaultQuery;
  const market = normalizeMarket(input.market);
  const symbol = String(input.symbol || '').trim() || 'UNKNOWN';
  const votes = normalizeVotes(input.votes || input.candidateActions);
  const levels = await fetchRoleLevels(queryFn, market);
  const resolved = resolveDecision(votes, levels);

  return {
    status: 'completed',
    output: {
      ok: true,
      skill: 'multi-agent-coordination',
      symbol,
      market,
      dag: buildDag(),
      decision: resolved.decision,
      confidence: resolved.confidence,
      conflictResolution: {
        method: 'weighted_role_vote_with_risk_veto',
        score: resolved.score,
        riskVeto: resolved.riskVeto,
      },
      votes: resolved.weightedVotes,
      nextSkillCandidate: 'multi-agent-trade-decision',
      shadowMode: true,
      liveMutation: false,
      liveTrade: false,
    },
  };
}

export function registerMultiAgentCoordinationSkill(options = {}) {
  registerSkillHandler('multi-agent-coordination', async (input) => runMultiAgentCoordination(input, options));
  return { name: 'multi-agent-coordination', registered: true };
}

export default { registerMultiAgentCoordinationSkill, runMultiAgentCoordination };
