const { execSync } = require('node:child_process');
const path = require('node:path');
const env = require('../../../../packages/core/lib/env');
const {
  registerAgent,
  listAgents,
  sendAgentMessage,
  ackAgentMessage,
  getAgentStatus,
} = require('./agent-bus');
const { buildPlaybookTemplate } = require('./playbook');
const { validateSubagentSandbox } = require('./subagent-sandbox');

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getLaunchctlStatus(labels) {
  const provider = require('../../../../packages/core/lib/health-provider');
  return provider.getLaunchctlStatus(labels);
}

function getEventLake() {
  return require('../../../../packages/core/lib/event-lake');
}

const HUB_TOOLS = [
  {
    name: 'hub.health.query',
    ownerTeam: 'hub',
    description: 'Hub health/event 요약 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L0',
    executeEnabled: true,
    handler: async (input) => {
      const minutes = Math.max(1, Number(input?.minutes ?? 60) || 60);
      const stats = await getEventLake().stats({ minutes }).catch(() => null);
      return {
        now: new Date().toISOString(),
        mode: env.MODE,
        paperMode: env.PAPER_MODE,
        minutes,
        eventStats: stats,
      };
    },
  },
  {
    name: 'launchd.status',
    ownerTeam: 'hub',
    description: 'launchd 서비스 상태 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L0',
    executeEnabled: true,
    handler: async (input) => {
      const labels = Array.isArray(input?.labels)
        ? input.labels.map((label) => normalizeText(label)).filter(Boolean)
        : ['ai.hub.resource-api', 'ai.claude.auto-dev.autonomous', 'ai.investment.crypto'];
      return {
        labels,
        status: getLaunchctlStatus(labels),
      };
    },
  },
  {
    name: 'repo.git_status',
    ownerTeam: 'hub',
    description: '리포 git status 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L0',
    executeEnabled: true,
    handler: async (input) => {
      const cwd = normalizeText(input?.cwd, env.PROJECT_ROOT);
      const output = execSync('git status --short', {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        cwd,
        output: output.trim(),
      };
    },
  },
  {
    name: 'playbook.template',
    ownerTeam: 'orchestrator',
    description: 'Jay phase playbook 템플릿 생성',
    sideEffect: 'none',
    defaultRisk: 'low',
    requiredTopicLevel: 'L0',
    executeEnabled: true,
    handler: async (input) => {
      return buildPlaybookTemplate({
        goal: normalizeText(input?.goal, '운영 점검 및 조치'),
        team: normalizeText(input?.team, 'general'),
      });
    },
  },
  {
    name: 'subagent.validate',
    ownerTeam: 'orchestrator',
    description: 'subagent sandbox 정책 검증',
    sideEffect: 'none',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async (input) => validateSubagentSandbox({
      contextSummary: input?.contextSummary,
      allowedTools: input?.allowedTools,
      parentTools: input?.parentTools,
      maxConcurrency: input?.maxConcurrency,
      maxDepth: input?.maxDepth,
      finalSummaryOnly: input?.finalSummaryOnly,
      freshContext: input?.freshContext,
    }),
  },
  {
    name: 'agent_bus.register',
    ownerTeam: 'hub',
    description: 'agent agreement bus 등록',
    sideEffect: 'write',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async (input) => registerAgent({
      agentId: input?.agentId,
      roles: input?.roles,
      tools: input?.tools,
    }),
  },
  {
    name: 'agent_bus.list',
    ownerTeam: 'hub',
    description: 'agent agreement bus 등록 목록 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async () => listAgents(),
  },
  {
    name: 'agent_bus.send',
    ownerTeam: 'hub',
    description: 'incident-aware agent message 전송',
    sideEffect: 'write',
    defaultRisk: 'medium',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async (input, context) => sendAgentMessage({
      traceId: input?.traceId || context?.traceId || null,
      runId: input?.runId || null,
      incidentKey: input?.incidentKey || null,
      from: input?.from || context?.agent || 'planner',
      to: input?.to || 'broadcast',
      role: input?.role || 'producer',
      phase: input?.phase || 'observe',
      visibility: input?.visibility || 'internal',
      payload: input?.payload || {},
      ackRequired: input?.ackRequired !== false,
    }),
  },
  {
    name: 'agent_bus.ack',
    ownerTeam: 'hub',
    description: 'agent message ack 처리',
    sideEffect: 'write',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async (input, context) => ackAgentMessage({
      messageId: input?.messageId,
      ackedBy: input?.ackedBy || context?.agent || 'system',
    }),
  },
  {
    name: 'agent_bus.status',
    ownerTeam: 'hub',
    description: 'agent/incident 상태 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async (input) => getAgentStatus({
      agentId: input?.agentId,
      incidentKey: input?.incidentKey,
    }),
  },
  {
    name: 'launchd.restart',
    ownerTeam: 'hub',
    description: 'launchd 서비스 재시작 (MVP 비활성)',
    sideEffect: 'external_mutation',
    defaultRisk: 'high',
    requiredTopicLevel: 'L3',
    executeEnabled: false,
    handler: async () => ({ ok: false, error: 'tool_disabled' }),
  },
  {
    name: 'repo.command.run',
    ownerTeam: 'hub',
    description: '리포 커맨드 실행 (MVP 비활성)',
    sideEffect: 'external_mutation',
    defaultRisk: 'high',
    requiredTopicLevel: 'L3',
    executeEnabled: false,
    handler: async () => ({ ok: false, error: 'tool_disabled' }),
  },
];

const TOOL_MAP = new Map(HUB_TOOLS.map((tool) => [tool.name, tool]));

function listHubControlTools() {
  return HUB_TOOLS.map((tool) => ({
    name: tool.name,
    ownerTeam: tool.ownerTeam,
    description: tool.description,
    sideEffect: tool.sideEffect,
    defaultRisk: tool.defaultRisk,
    requiredTopicLevel: tool.requiredTopicLevel,
    executeEnabled: tool.executeEnabled,
  }));
}

function hasHubControlTool(name) {
  return TOOL_MAP.has(String(name || '').trim());
}

async function callHubControlTool(name, input, context) {
  const normalized = String(name || '').trim();
  const tool = TOOL_MAP.get(normalized);
  if (!tool) {
    return { ok: false, error: 'unknown_tool', tool: normalized };
  }
  if (!tool.executeEnabled && !['none', 'read_only'].includes(tool.sideEffect)) {
    return {
      ok: false,
      error: 'mutating_tool_disabled',
      tool: normalized,
      sideEffect: tool.sideEffect,
      requiredTopicLevel: tool.requiredTopicLevel,
    };
  }
  try {
    const result = await tool.handler(input || {}, context || {});
    return {
      ok: true,
      tool: normalized,
      result,
    };
  } catch (error) {
    const message = String(error?.message || error || 'tool_execution_failed');
    const unavailable = message.includes('state_store_unavailable')
      || message.includes('db_unavailable')
      || message.includes('hub_agent_bus_db_unavailable');
    return {
      ok: false,
      tool: normalized,
      error: unavailable ? 'control_state_store_unavailable' : 'tool_execution_failed',
      detail: message,
      statusCode: unavailable ? 503 : 400,
    };
  }
}

function isReadOnlyTool(name) {
  const tool = TOOL_MAP.get(String(name || '').trim());
  if (!tool) return false;
  return ['none', 'read_only'].includes(tool.sideEffect);
}

module.exports = {
  listHubControlTools,
  hasHubControlTool,
  callHubControlTool,
  isReadOnlyTool,
};
