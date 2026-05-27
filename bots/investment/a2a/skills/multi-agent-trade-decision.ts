// @ts-nocheck
/**
 * A2A Skill: Multi-Agent Trade Decision
 *
 * 5 Agent System (Moura 2024) 기반 협업 의사결정
 * - Analyst Team:    oracle, sentinel → 시장/신호 분석
 * - Data Science:    luna, kairos → 데이터 처리
 * - Strategy:        hephaestos, hermes → 전략 선택
 * - Trading Advisor: chronos, argos → 진입/청산 결정
 * - Risk Manager:    sweeper, scout → 리스크 검토
 *
 * 마스터 철학: "A2A 5 Agent 역할! 거래 = 데이터 수집!"
 */

import { query as defaultQuery } from '../../shared/db.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

// ─── 에이전트 역할 매핑 ─────────────────────────────────────

const ROLE_WEIGHTS = {
  analyst: 0.25,
  data_scientist: 0.20,
  strategist: 0.25,
  advisor: 0.20,
  risk_manager: 0.10,
};

const AGENT_ROLES = {
  oracle: 'analyst',
  sentinel: 'analyst',
  aria: 'analyst',
  sophia: 'analyst',
  luna: 'data_scientist',
  kairos: 'data_scientist',
  reporter: 'data_scientist',
  hephaestos: 'strategist',
  hermes: 'strategist',
  chronos: 'advisor',
  argos: 'advisor',
  sweeper: 'risk_manager',
  scout: 'risk_manager',
  nemesis: 'risk_manager',
};

// ─── 협업 결정 요청 타입 ────────────────────────────────────

function normalizeMarket(v) {
  const m = String(v || 'crypto').trim().toLowerCase();
  return ['crypto', 'stocks', 'overseas'].includes(m) ? m : 'crypto';
}

function normalizeAction(v) {
  const a = String(v || 'hold').trim().toLowerCase();
  return ['buy', 'sell', 'hold'].includes(a) ? a : 'hold';
}

// ─── 핵심: 멀티에이전트 앙상블 결정 ─────────────────────────

async function runMultiAgentTradeDecision(input, queryFn) {
  const market = normalizeMarket(input?.market);
  const symbol = String(input?.symbol || '').trim();
  const candidateActions = input?.candidateActions || [];

  if (!symbol) return { error: 'symbol 필수', decision: 'hold', confidence: 0 };

  // 1. 최근 에이전트 성과 조회 (커리큘럼 레벨 기반 가중치)
  const agentLevels = await fetchAgentLevels(queryFn, market);

  // 2. 각 에이전트의 투표 집계
  const voteMap = { buy: 0, sell: 0, hold: 0 };
  const voteDetails = [];

  for (const candidate of candidateActions) {
    const agentName = String(candidate.agent || '').toLowerCase();
    const action = normalizeAction(candidate.action);
    const confidence = Math.max(0, Math.min(1, Number(candidate.confidence || 0.5)));

    const role = AGENT_ROLES[agentName] || 'data_scientist';
    const roleWeight = ROLE_WEIGHTS[role] || 0.20;
    const levelMult = getLevelMultiplier(agentLevels[agentName]);

    const vote = roleWeight * levelMult * confidence;
    voteMap[action] = (voteMap[action] || 0) + vote;
    voteDetails.push({ agentName, role, action, confidence, vote: Number(vote.toFixed(4)) });
  }

  // 3. 리스크 매니저 거부권 체크
  const riskVeto = checkRiskManagerVeto(candidateActions, agentLevels);

  let finalDecision = Object.keys(voteMap).reduce((a, b) => voteMap[a] > voteMap[b] ? a : b, 'hold');
  if (riskVeto.veto && finalDecision === 'buy') {
    finalDecision = 'hold';
  }

  const totalVotes = Object.values(voteMap).reduce((a, b) => a + b, 0);
  const winningVotes = voteMap[finalDecision] || 0;
  const confidence = totalVotes > 0 ? Number((winningVotes / totalVotes).toFixed(3)) : 0;

  // 4. 결정 기록 (에이전트 메시지 로그)
  await recordDecisionMessage(queryFn, {
    symbol, market, finalDecision, confidence, voteDetails, riskVeto,
  });

  return {
    symbol,
    market,
    decision: finalDecision,
    confidence,
    voteMap,
    voteDetails,
    riskVeto,
    agentCount: candidateActions.length,
  };
}

// ─── 에이전트 레벨 조회 ──────────────────────────────────────

async function fetchAgentLevels(queryFn, market) {
  try {
    const rows = await queryFn(`
      SELECT agent_name, current_level
      FROM investment.agent_curriculum_state
      WHERE market = $1
    `, [market]);
    const levels = {};
    for (const row of (Array.isArray(rows) ? rows : rows?.rows || [])) {
      levels[row.agent_name] = row.current_level;
    }
    return levels;
  } catch (_err) {
    return {};
  }
}

function getLevelMultiplier(level) {
  if (level === 'expert') return 1.5;
  if (level === 'intermediate') return 1.0;
  return 0.7;  // novice
}

// ─── 리스크 매니저 거부권 ────────────────────────────────────

function checkRiskManagerVeto(candidateActions, agentLevels) {
  const riskManagers = candidateActions.filter(c => {
    const role = AGENT_ROLES[String(c.agent || '').toLowerCase()];
    return role === 'risk_manager';
  });

  if (riskManagers.length === 0) return { veto: false, reason: '리스크 매니저 참여 없음' };

  const avgRiskConf = riskManagers
    .filter(r => normalizeAction(r.action) === 'sell' || normalizeAction(r.action) === 'hold')
    .reduce((sum, r) => sum + Number(r.confidence || 0), 0) / Math.max(1, riskManagers.length);

  const veto = avgRiskConf > 0.8;  // 리스크 매니저 80% 이상 sell/hold → 거부권
  return {
    veto,
    reason: veto ? `리스크 매니저 거부 (신뢰도 ${avgRiskConf.toFixed(2)})` : '통과',
    riskManagerCount: riskManagers.length,
  };
}

// ─── 결정 로그 ──────────────────────────────────────────────

async function recordDecisionMessage(queryFn, data) {
  try {
    await queryFn(`
      INSERT INTO investment.agent_messages (
        incident_key, from_agent, to_agent, message_type, payload, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
    `, [
      `trade_decision_${data.symbol}_${Date.now()}`,
      'multi-agent-ensemble',
      'luna-commander',
      'response',
      JSON.stringify(data),
    ]);
  } catch (_err) {
    // 로그 실패해도 결정에 영향 X
  }
}

// ─── 스킬 등록 ──────────────────────────────────────────────

export function register(options = {}) {
  const queryFn = options.query || defaultQuery;

  registerSkillHandler('multi-agent-trade-decision', async (input) => {
    return runMultiAgentTradeDecision(input, queryFn);
  });

  return { name: 'multi-agent-trade-decision', registered: true };
}

export { runMultiAgentTradeDecision };
