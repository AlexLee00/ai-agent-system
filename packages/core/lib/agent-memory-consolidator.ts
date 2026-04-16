'use strict';

/**
 * agent-memory-consolidator.ts
 *
 * 에피소딕→시맨틱 통합 스케줄러 (Phase 3 Step 5)
 *
 * rag.agent_memory에 에피소딕 기억이 있는 모든 에이전트를 조회하고,
 * 각 에이전트별로 AgentMemory.consolidate()를 호출해 오래된 에피소딕 기억을
 * 시맨틱 기억으로 통합한다.
 *
 * 사용처: steward.ts runDaily()에서 매일 1회 자동 실행
 */

import pgPool = require('./pg-pool');
import { AgentMemory } from './agent-memory';

const SCHEMA = 'rag';
const DEFAULT_OLDER_THAN_DAYS = 30;
const DEFAULT_LIMIT_PER_AGENT = 20;
const CONSOLIDATE_CONCURRENCY = 4; // 동시 처리 에이전트 수

type ConsolidateAllOptions = {
  olderThanDays?: number;
  limitPerAgent?: number;
  dryRun?: boolean;
};

type AgentSlot = {
  agentId: string;
  team: string;
  episodicCount: number;
};

type ConsolidateAllResult = {
  agents: number;
  scanned: number;
  created: number;
  skipped: number;
  errors: number;
  details: Array<{
    agentId: string;
    team: string;
    scanned: number;
    created: number;
    error?: string;
  }>;
};

async function getAgentsWithEpisodicMemory(olderThanDays: number): Promise<AgentSlot[]> {
  const rows = await pgPool.query<{ agent_id: string; team: string; cnt: string }>(SCHEMA, `
    SELECT agent_id, team, COUNT(*)::text AS cnt
    FROM rag.agent_memory
    WHERE
      memory_type = 'episodic'
      AND created_at < NOW() - ($1::text || ' days')::interval
      AND (expires_at IS NULL OR expires_at > NOW())
    GROUP BY agent_id, team
    ORDER BY team, agent_id
  `, [String(olderThanDays)]);

  return rows.map((row) => ({
    agentId: row.agent_id,
    team: row.team,
    episodicCount: parseInt(row.cnt, 10) || 0,
  }));
}

async function consolidateChunk(
  slots: AgentSlot[],
  opts: ConsolidateAllOptions,
): Promise<ConsolidateAllResult['details']> {
  const details: ConsolidateAllResult['details'] = [];

  for (const slot of slots) {
    if (opts.dryRun) {
      details.push({ agentId: slot.agentId, team: slot.team, scanned: slot.episodicCount, created: 0 });
      continue;
    }

    try {
      const mem = new AgentMemory({ agentId: slot.agentId, team: slot.team });
      const result = await mem.consolidate({
        olderThanDays: opts.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS,
        limit: opts.limitPerAgent ?? DEFAULT_LIMIT_PER_AGENT,
      });
      details.push({ agentId: slot.agentId, team: slot.team, scanned: result.scanned, created: result.created });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      details.push({ agentId: slot.agentId, team: slot.team, scanned: 0, created: 0, error: msg });
    }
  }

  return details;
}

async function consolidateAll(opts: ConsolidateAllOptions = {}): Promise<ConsolidateAllResult> {
  const olderThanDays = opts.olderThanDays ?? DEFAULT_OLDER_THAN_DAYS;
  const slots = await getAgentsWithEpisodicMemory(olderThanDays);

  if (!slots.length) {
    return { agents: 0, scanned: 0, created: 0, skipped: 0, errors: 0, details: [] };
  }

  // CONCURRENCY 단위로 청크 분할하여 순차 처리
  const allDetails: ConsolidateAllResult['details'] = [];
  for (let i = 0; i < slots.length; i += CONSOLIDATE_CONCURRENCY) {
    const chunk = slots.slice(i, i + CONSOLIDATE_CONCURRENCY);
    // 같은 청크 내 에이전트는 병렬 처리
    const chunkResults = await Promise.all(
      chunk.map((slot) => consolidateChunk([slot], opts).then((d) => d[0]))
    );
    allDetails.push(...chunkResults);
  }

  const scanned = allDetails.reduce((s, d) => s + d.scanned, 0);
  const created = allDetails.reduce((s, d) => s + d.created, 0);
  const errors = allDetails.filter((d) => d.error != null).length;
  const skipped = allDetails.filter((d) => d.scanned === 0 && !d.error).length;

  return {
    agents: slots.length,
    scanned,
    created,
    skipped,
    errors,
    details: allDetails,
  };
}

export = { consolidateAll };
