// @ts-nocheck

export type AgentMemoryRuntimeMode = 'off' | 'shadow' | 'supervised_l4' | 'autonomous_l5';

function normalizeBool(value: unknown, fallback = false): boolean {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(raw)) return false;
  return fallback;
}

function normalizeMode(value: unknown): AgentMemoryRuntimeMode {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'autonomous_l5') return 'autonomous_l5';
  if (raw === 'supervised_l4') return 'supervised_l4';
  if (raw === 'shadow') return 'shadow';
  return 'off';
}

export interface AgentMemoryRuntimeFlags {
  mode: AgentMemoryRuntimeMode;
  memoryAutoPrefix: boolean;
  personaEnabled: boolean;
  constitutionEnabled: boolean;
  layer2ShortTermEnabled: boolean;
  layer3EpisodicEnabled: boolean;
  layer4SemanticProceduralEnabled: boolean;
  llmRoutingEnabled: boolean;
  reflexionAutoAvoidEnabled: boolean;
  curriculumEnabled: boolean;
  crossBusEnabled: boolean;
  layer1WorkingMemoryEnabled: boolean;
}

export function resolveAgentMemoryRuntimeFlags(): AgentMemoryRuntimeFlags {
  const mode = normalizeMode(process.env.LUNA_AGENT_MEMORY_MODE || 'off');
  return {
    mode,
    memoryAutoPrefix: normalizeBool(process.env.LUNA_AGENT_MEMORY_AUTO_PREFIX, false),
    personaEnabled: normalizeBool(process.env.LUNA_AGENT_PERSONA_ENABLED, false),
    constitutionEnabled: normalizeBool(process.env.LUNA_AGENT_CONSTITUTION_ENABLED, false),
    layer2ShortTermEnabled: normalizeBool(process.env.LUNA_AGENT_MEMORY_LAYER_2, false),
    layer3EpisodicEnabled: normalizeBool(process.env.LUNA_AGENT_MEMORY_LAYER_3, false),
    layer4SemanticProceduralEnabled: normalizeBool(process.env.LUNA_AGENT_MEMORY_LAYER_4, false),
    llmRoutingEnabled: normalizeBool(process.env.LUNA_AGENT_LLM_ROUTING_ENABLED, false),
    reflexionAutoAvoidEnabled: normalizeBool(process.env.LUNA_AGENT_REFLEXION_AUTO_AVOID, false),
    curriculumEnabled: normalizeBool(process.env.LUNA_AGENT_CURRICULUM_ENABLED, false),
    crossBusEnabled: normalizeBool(process.env.LUNA_AGENT_CROSS_BUS_ENABLED, false),
    layer1WorkingMemoryEnabled: normalizeBool(process.env.LUNA_AGENT_LAYER1_WORKING_MEMORY_ENABLED, false),
  };
}

export function isAgentMemoryFeatureEnabled(feature: keyof AgentMemoryRuntimeFlags): boolean {
  const flags = resolveAgentMemoryRuntimeFlags();
  return flags[feature] === true;
}

export function buildDefaultWorkingState(opts: {
  agentName?: string;
  market?: string;
  symbol?: string;
  taskType?: string;
  incidentKey?: string;
} = {}): string {
  const now = new Date().toISOString();
  const bits = [
    `timestamp: ${now}`,
    `agent: ${opts.agentName || 'unknown'}`,
    `market: ${opts.market || 'any'}`,
    `symbol: ${opts.symbol || 'n/a'}`,
    `task_type: ${opts.taskType || 'default'}`,
    `incident_key: ${opts.incidentKey || 'n/a'}`,
  ];
  return bits.join('\n');
}

