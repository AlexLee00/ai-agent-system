// @ts-nocheck
import { listAgentDefinitions } from './agent-yaml-loader.ts';

function uniq(items = []) {
  return Array.from(new Set(items.filter(Boolean).map(String)));
}

export function buildCollaborationMatrix(agents = listAgentDefinitions()) {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const rows = agents.map((agent) => {
    const collaboration = agent.collaboration || {};
    return {
      name: agent.name,
      tier: Number(agent.tier),
      runtime: agent.runtime,
      upstream: uniq(collaboration.upstream),
      downstream: uniq(collaboration.downstream),
      parallel: uniq(collaboration.parallel),
      capabilities: uniq(agent.capabilities),
      llmPolicyRef: agent.llmPolicyRef,
    };
  });
  const references = [];
  for (const row of rows) {
    for (const kind of ['upstream', 'downstream', 'parallel']) {
      for (const target of row[kind]) references.push({ from: row.name, to: target, kind, exists: byName.has(target) });
    }
  }
  const missingReferences = references.filter((ref) => !ref.exists);
  const cycles = rows
    .filter((row) => row.downstream.some((target) => byName.get(target)?.collaboration?.downstream?.includes(row.name)))
    .map((row) => row.name);
  return {
    ok: missingReferences.length === 0,
    totalAgents: rows.length,
    rows,
    references,
    missingReferences,
    cycles,
    byTier: rows.reduce((acc, row) => {
      const key = `tier_${row.tier}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

export function summarizeCollaborationMatrix(matrix = buildCollaborationMatrix()) {
  return {
    ok: matrix.ok,
    totalAgents: matrix.totalAgents,
    missingReferenceCount: matrix.missingReferences.length,
    cycleCount: matrix.cycles.length,
    byTier: matrix.byTier,
  };
}

export default {
  buildCollaborationMatrix,
  summarizeCollaborationMatrix,
};
