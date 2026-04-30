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

const FLOW_DEFINITIONS = {
  discovery_entry: [
    { stage: 'candidate_collection', from: 'luna', to: ['scout'], messageType: 'query' },
    { stage: 'parallel_analysis', from: 'scout', to: ['aria', 'sophia', 'hermes', 'oracle', 'argos', 'stock-flow', 'chronos', 'kairos'], messageType: 'query' },
    { stage: 'debate', from: 'luna', to: ['zeus', 'athena'], messageType: 'query' },
    { stage: 'risk_validation', from: 'luna', to: ['nemesis', 'budget', 'adaptive-risk'], messageType: 'query' },
    { stage: 'decision', from: 'luna', to: ['hephaestos', 'hanul'], messageType: 'broadcast' },
  ],
  risk_execution: [
    { stage: 'risk_pack', from: 'luna', to: ['nemesis', 'budget', 'adaptive-risk', 'sentinel'], messageType: 'query' },
    { stage: 'execution_plan', from: 'nemesis', to: ['hephaestos', 'hanul'], messageType: 'query' },
    { stage: 'ledger_parity', from: 'hephaestos', to: ['sweeper'], messageType: 'query' },
    { stage: 'execution_summary', from: 'sweeper', to: ['luna'], messageType: 'response' },
  ],
  posttrade_learning: [
    { stage: 'trade_outcome', from: 'hephaestos', to: ['chronos'], messageType: 'query' },
    { stage: 'forecast_review', from: 'chronos', to: ['kairos'], messageType: 'query' },
    { stage: 'skill_reflexion', from: 'kairos', to: ['luna', 'sophia', 'hermes'], messageType: 'broadcast' },
  ],
  maintenance_sync: [
    { stage: 'wallet_ledger_parity', from: 'sweeper', to: ['hephaestos', 'hanul'], messageType: 'query' },
    { stage: 'anomaly_review', from: 'sweeper', to: ['sentinel', 'nemesis'], messageType: 'query' },
    { stage: 'maintenance_summary', from: 'sentinel', to: ['luna'], messageType: 'response' },
  ],
};

function isPublishEnabled(env = process.env) {
  return String(env.LUNA_COLLABORATION_MATRIX_PUBLISH_ENABLED || '').toLowerCase() === 'true';
}

export function getCollaborationFlow(decisionType = 'discovery_entry', { agents = listAgentDefinitions() } = {}) {
  const type = FLOW_DEFINITIONS[decisionType] ? decisionType : 'discovery_entry';
  const knownAgents = new Set(agents.map((agent) => agent.name));
  const steps = FLOW_DEFINITIONS[type].map((step, index) => {
    const targets = uniq(step.to);
    return {
      order: index + 1,
      stage: step.stage,
      from: step.from,
      to: targets,
      messageType: step.messageType,
      missingAgents: [step.from, ...targets].filter((agent) => !knownAgents.has(agent)),
    };
  });
  const missingAgents = uniq(steps.flatMap((step) => step.missingAgents));
  return {
    ok: missingAgents.length === 0,
    decisionType: type,
    dryRunDefault: true,
    publishDefault: false,
    steps,
    missingAgents,
  };
}

export async function executeCollaboration(flow, context = {}, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const env = opts.env || process.env;
  const publishEnabled = isPublishEnabled(env);
  const incidentKey = context.incidentKey || `collaboration:${flow?.decisionType || 'unknown'}:${Date.now()}`;
  const publishPlan = [];

  for (const step of flow?.steps || []) {
    for (const target of step.to || []) {
      publishPlan.push({
        fromAgent: step.from,
        toAgent: target,
        incidentKey,
        messageType: step.messageType || 'query',
        payload: {
          decisionType: flow.decisionType,
          stage: step.stage,
          context: context.summary || context,
        },
      });
    }
  }

  if (dryRun || !publishEnabled) {
    return {
      ok: true,
      status: dryRun ? 'collaboration_dry_run' : 'collaboration_publish_disabled',
      dryRun,
      publishEnabled,
      incidentKey,
      steps: flow?.steps || [],
      publishPlan,
      published: [],
    };
  }

  const send = opts.sendMessageFn || (await import('./agent-message-bus.ts')).sendMessage;
  const published = [];
  for (const item of publishPlan) {
    const id = await send(item.fromAgent, item.toAgent, item.payload, {
      incidentKey: item.incidentKey,
      messageType: item.messageType,
    });
    published.push({ ...item, id });
  }
  return {
    ok: published.every((item) => Number(item.id) > 0),
    status: 'collaboration_published',
    dryRun,
    publishEnabled,
    incidentKey,
    steps: flow?.steps || [],
    publishPlan,
    published,
  };
}

export default {
  buildCollaborationMatrix,
  summarizeCollaborationMatrix,
  getCollaborationFlow,
  executeCollaboration,
};
