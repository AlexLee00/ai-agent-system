'use strict';

const pgPool = require('./pg-pool');
const hiringContract = require('./hiring-contract');
const agentRegistry = require('./agent-registry');

async function formGroups(topic, team = 'blog') {
  const roles = ['planner', 'researcher', 'writer', 'editor'];
  const groupA = [];
  const groupB = [];
  const pool = await agentRegistry.getAgentsByTeam(team);

  for (const role of roles) {
    const rolePool = pool
      .filter((agent) => agent.role === role && agent.status !== 'archived')
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

    if (rolePool.length >= 2) {
      groupA.push(rolePool[0].name);
      groupB.push(rolePool[1].name);
    } else if (rolePool.length === 1) {
      groupA.push(rolePool[0].name);
      groupB.push(rolePool[0].name);
    }
  }

  return { topic, team, groupA, groupB };
}

async function startCompetition(topic, team = 'blog') {
  const { groupA, groupB } = await formGroups(topic, team);
  const row = await pgPool.get(
    'agent',
    `INSERT INTO agent.competitions (team, topic, group_a_agents, group_b_agents, status)
     VALUES ($1, $2, $3::JSONB, $4::JSONB, 'running')
     RETURNING id`,
    [team, topic, JSON.stringify(groupA), JSON.stringify(groupB)],
  );

  const contractsA = [];
  const contractsB = [];

  for (const name of groupA) {
    const contract = await hiringContract.hire(name, {
      employer_team: team,
      task: `[경쟁A] ${topic}`,
      requirements: { topic, lane: 'A' },
    });
    contractsA.push(contract.contractId);
  }

  for (const name of groupB) {
    const contract = await hiringContract.hire(name, {
      employer_team: team,
      task: `[경쟁B] ${topic}`,
      requirements: { topic, lane: 'B' },
    });
    contractsB.push(contract.contractId);
  }

  await pgPool.run(
    'agent',
    `UPDATE agent.competitions
     SET group_a_contract_ids = $1::JSONB, group_b_contract_ids = $2::JSONB
     WHERE id = $3`,
    [JSON.stringify(contractsA), JSON.stringify(contractsB), row.id],
  );

  return { competitionId: row.id, topic, team, groupA, groupB, contractsA, contractsB };
}

function calculateQuality(result) {
  const data = result || {};
  let score = 0;

  const chars = Number(data.char_count || 0);
  score += Math.min(10, (chars / 9000) * 10);

  const sections = Number(data.section_count || 0);
  score += Math.min(10, (sections / 6) * 10);

  const aiRisk = Number(data.ai_risk ?? 20);
  score += Math.max(0, 10 - aiRisk / 10);

  const codeBlocks = Number(data.code_blocks ?? 1);
  score += Math.min(10, (codeBlocks / 2) * 10);

  return Math.min(10, score / 4);
}

function evaluateResults(resultA, resultB) {
  const scoreA = calculateQuality(resultA);
  const scoreB = calculateQuality(resultB);
  return { scoreA, scoreB, detail: { a: resultA || {}, b: resultB || {} } };
}

async function completeCompetition(competitionId, resultA, resultB) {
  const evaluation = evaluateResults(resultA, resultB);
  const winner = evaluation.scoreA >= evaluation.scoreB ? 'a' : 'b';
  const qualityDiff = Number(Math.abs(evaluation.scoreA - evaluation.scoreB).toFixed(2));

  await pgPool.run(
    'agent',
    `UPDATE agent.competitions SET
       group_a_result = $1::JSONB,
       group_b_result = $2::JSONB,
       winner = $3,
       quality_diff = $4,
       evaluation_detail = $5::JSONB,
       winning_pattern = $6::JSONB,
       status = 'completed',
       completed_at = NOW()
     WHERE id = $7`,
    [
      JSON.stringify(resultA || {}),
      JSON.stringify(resultB || {}),
      winner,
      qualityDiff,
      JSON.stringify(evaluation),
      JSON.stringify({ winner, agents: winner === 'a' ? resultA?.agents || [] : resultB?.agents || [] }),
      competitionId,
    ],
  );

  const competition = await pgPool.get('agent', 'SELECT * FROM agent.competitions WHERE id = $1', [competitionId]);
  const winnerAgents = winner === 'a'
    ? (competition.group_a_agents || [])
    : (competition.group_b_agents || []);
  const loserAgents = winner === 'a'
    ? (competition.group_b_agents || [])
    : (competition.group_a_agents || []);

  for (const name of winnerAgents) {
    await agentRegistry.updateScore(name, 8.0, `[경쟁승] ${competition.topic}`);
  }
  for (const name of loserAgents) {
    await agentRegistry.updateScore(name, 4.0, `[경쟁패] ${competition.topic}`);
  }

  return { competitionId, winner, qualityDiff, evaluation };
}

async function getCompetitionHistory(team = 'blog', limit = 10) {
  return pgPool.query(
    'agent',
    `SELECT *
     FROM agent.competitions
     WHERE team = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [team, limit],
  );
}

module.exports = {
  formGroups,
  startCompetition,
  completeCompetition,
  evaluateResults,
  calculateQuality,
  getCompetitionHistory,
};
