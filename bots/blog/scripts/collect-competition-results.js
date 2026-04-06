#!/usr/bin/env node
'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const competitionEngine = require('../../../packages/core/lib/competition-engine');
const { postAlarm } = require('../../../packages/core/lib/openclaw-client');

const TEAM = 'blog';
const COMPETITION_TIMEOUT_HOURS = 24;

function _normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function _hoursSince(dateLike) {
  const timestamp = new Date(dateLike).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return (Date.now() - timestamp) / (1000 * 60 * 60);
}

async function _fetchRunningCompetitions() {
  return pgPool.query(
    'agent',
    `SELECT id, team, topic, group_a_agents, group_b_agents,
            group_a_contract_ids, group_b_contract_ids, created_at
     FROM agent.competitions
     WHERE status = 'running'
     ORDER BY created_at ASC`,
  );
}

async function _fetchContracts(contractIds = []) {
  const ids = _normalizeArray(contractIds)
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) return [];

  return pgPool.query(
    'agent',
    `SELECT id, status, started_at, completed_at
     FROM agent.contracts
     WHERE id = ANY($1::int[])`,
    [ids],
  );
}

async function _collectGroupResult(agents = [], createdAt) {
  const normalizedAgents = _normalizeArray(agents)
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  if (normalizedAgents.length === 0) {
    return {
      agents: [],
      char_count: 0,
      section_count: 0,
      code_blocks: 0,
      published_count: 0,
      ai_risk: 20,
    };
  }

  const rows = await pgPool.query(
    'blog',
    `SELECT id, title, char_count, content, metadata, created_at
     FROM blog.posts
     WHERE created_at >= $1
       AND metadata->>'writer_name' = ANY($2::text[])`,
    [createdAt, normalizedAgents],
  );

  let charCount = 0;
  let sectionCount = 0;
  let codeBlocks = 0;

  for (const row of rows) {
    const content = String(row.content || '');
    charCount += Number(row.char_count || content.length || 0);
    sectionCount += (content.match(/^#{1,6}\s+/gm) || []).length;
    codeBlocks += (content.match(/```/g) || []).length / 2;
  }

  return {
    agents: normalizedAgents,
    char_count: charCount,
    section_count: Math.round(sectionCount),
    code_blocks: Math.round(codeBlocks),
    published_count: rows.length,
    ai_risk: rows.length > 0 ? 15 : 25,
  };
}

async function _markTimeout(competitionId, hoursSinceCreated) {
  await pgPool.run(
    'agent',
    `UPDATE agent.competitions
     SET status = 'timeout', completed_at = NOW()
     WHERE id = $1`,
    [competitionId],
  );
  console.log(`[competition-collector] #${competitionId} timeout (${Math.round(hoursSinceCreated)}h)`);
}

async function main() {
  const runningComps = await _fetchRunningCompetitions();
  if (runningComps.length === 0) {
    console.log('[competition-collector] running competition 없음 — 스킵');
    return;
  }

  console.log(`[competition-collector] running competition ${runningComps.length}건`);

  let completed = 0;
  let timedOut = 0;
  let pending = 0;

  for (const comp of runningComps) {
    const contractIdsA = _normalizeArray(comp.group_a_contract_ids);
    const contractIdsB = _normalizeArray(comp.group_b_contract_ids);

    if (contractIdsA.length === 0 || contractIdsB.length === 0) {
      const hours = _hoursSince(comp.created_at);
      if (hours >= COMPETITION_TIMEOUT_HOURS) {
        await _markTimeout(comp.id, hours);
        timedOut += 1;
      } else {
        pending += 1;
      }
      continue;
    }

    const contractsA = await _fetchContracts(contractIdsA);
    const contractsB = await _fetchContracts(contractIdsB);
    const allADone = contractsA.length === contractIdsA.length
      && contractsA.every((row) => ['completed', 'failed'].includes(String(row.status || '')));
    const allBDone = contractsB.length === contractIdsB.length
      && contractsB.every((row) => ['completed', 'failed'].includes(String(row.status || '')));

    if (!allADone || !allBDone) {
      const hours = _hoursSince(comp.created_at);
      if (hours >= COMPETITION_TIMEOUT_HOURS) {
        await _markTimeout(comp.id, hours);
        timedOut += 1;
      } else {
        pending += 1;
      }
      continue;
    }

    const resultA = await _collectGroupResult(comp.group_a_agents, comp.created_at);
    const resultB = await _collectGroupResult(comp.group_b_agents, comp.created_at);
    const result = await competitionEngine.completeCompetition(comp.id, resultA, resultB);

    completed += 1;
    console.log(`[competition-collector] #${comp.id} 완료 — winner=${result.winner} diff=${result.qualityDiff}`);

    await postAlarm({
      message:
        `🏆 경쟁 #${comp.id} 완료\n` +
        `📋 ${comp.topic}\n` +
        `🥇 승자: ${result.winner === 'a' ? 'A그룹' : 'B그룹'}\n` +
        `📊 차이: ${result.qualityDiff}`,
      team: TEAM,
      fromBot: 'competition-collector',
    }).catch((error) => {
      console.warn(`[competition-collector] 알림 실패 #${comp.id}: ${error.message}`);
    });
  }

  console.log(`[competition-collector] 완료=${completed}, timeout=${timedOut}, pending=${pending}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
