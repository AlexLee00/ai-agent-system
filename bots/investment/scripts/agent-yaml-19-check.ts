#!/usr/bin/env node
// @ts-nocheck

import { listAgentDefinitions } from '../shared/agent-yaml-loader.ts';
import { buildGuardrailResult, defineGuardrailCli } from './guardrail-check-common.ts';

export async function runAgentYaml19Check() {
  const agents = listAgentDefinitions();
  const missingCanonical = agents.filter((agent) => !agent.persona || !agent.constitution || !agent.llm_routing);
  const invalidAgents = agents.filter((agent) => agent.validation?.ok !== true);
  return buildGuardrailResult({
    name: 'agent_yaml_19_loaded',
    severity: 'high',
    owner: 'luna',
    blockers: [
      ...(agents.length < 19 ? [`agent_yaml_count_below_19:${agents.length}`] : []),
      ...invalidAgents.map((agent) => `agent_yaml_invalid:${agent.name}:${(agent.validation?.errors || []).join('|')}`),
    ],
    warnings: missingCanonical.length > 0 ? [`canonical_metadata_missing:${missingCanonical.map((agent) => agent.name).join(',')}`] : [],
    evidence: {
      agentCount: agents.length,
      agents: agents.map((agent) => agent.name).sort(),
      missingCanonical: missingCanonical.map((agent) => agent.name).sort(),
      invalidAgents: invalidAgents.map((agent) => ({ name: agent.name, errors: agent.validation?.errors || [] })),
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'agent_yaml_19_loaded',
  run: runAgentYaml19Check,
});
