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
const {
  validateAgentToolAdmission,
  recordAgentGuardAudit,
} = require('./agent-guard');

type JsonRecord = Record<string, unknown>;

type ToolInput = JsonRecord & {
  minutes?: number | string;
  labels?: unknown;
  cwd?: string;
  goal?: string;
  team?: string;
  contextSummary?: unknown;
  allowedTools?: unknown;
  parentTools?: unknown;
  maxConcurrency?: unknown;
  maxDepth?: unknown;
  finalSummaryOnly?: unknown;
  freshContext?: unknown;
  agentId?: unknown;
  roles?: unknown;
  tools?: unknown;
  traceId?: string;
  runId?: string;
  incidentKey?: string;
  from?: string;
  to?: string;
  role?: string;
  phase?: string;
  visibility?: string;
  payload?: unknown;
  ackRequired?: boolean;
  messageId?: unknown;
  ackedBy?: string;
  limit?: number | string;
};

type ToolContext = JsonRecord & {
  traceId?: string;
  agent?: string;
};

type HubControlTool = {
  name: string;
  ownerTeam: string;
  description: string;
  sideEffect: 'none' | 'read_only' | 'write' | 'external_mutation';
  defaultRisk: 'low' | 'medium' | 'high';
  requiredTopicLevel: 'L0' | 'L1' | 'L2' | 'L3';
  executeEnabled: boolean;
  handler: (input: ToolInput, context?: ToolContext) => Promise<unknown>;
};

type OAuthTokenLike = {
  expires_at?: string;
  expiresAt?: string;
};

type EventLakeRow = {
  id?: string | number;
  severity?: string;
  title?: string;
  message?: string;
  tags?: unknown[];
  metadata?: JsonRecord;
  created_at?: string;
};

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getLaunchctlStatus(labels: string[]) {
  const provider = require('../../../../packages/core/lib/health-provider');
  return provider.getLaunchctlStatus(labels);
}

function getEventLake() {
  return require('../../../../packages/core/lib/event-lake');
}

function tokenExpiresInHours(token: OAuthTokenLike | null): number | null {
  const expiresAt = token?.expires_at || token?.expiresAt || null;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresMs)) return null;
  return (expiresMs - Date.now()) / (60 * 60 * 1000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getOAuthOpsStatus() {
  const {
    checkTokenHealth,
    checkOpenAIOAuthHealth,
    checkGroqAccounts,
  } = require('../llm/oauth-monitor');
  const { getProviderRecord } = require('../oauth/token-store');

  const [
    claude,
    openai,
    groq,
  ] = await Promise.all([
    checkTokenHealth().catch((error: unknown) => ({ healthy: false, error: errorMessage(error) })),
    checkOpenAIOAuthHealth().catch((error: unknown) => ({ healthy: false, error: errorMessage(error) })),
    checkGroqAccounts().catch(() => ({ available_accounts: 0, total_accounts: 0 })),
  ]);

  const geminiCliRecord = getProviderRecord('gemini-cli-oauth');
  const geminiCliHours = tokenExpiresInHours(geminiCliRecord?.token || null);
  const geminiCli = {
    healthy: Boolean(geminiCliRecord?.token?.access_token || geminiCliRecord?.token?.refresh_token),
    source: geminiCliRecord?.metadata?.source || null,
    expires_in_hours: Number.isFinite(Number(geminiCliHours)) ? Math.round(Number(geminiCliHours) * 100) / 100 : null,
    needs_refresh: Number.isFinite(Number(geminiCliHours)) ? Number(geminiCliHours) <= 1 : false,
    quota_project_configured: Boolean(
      process.env.GEMINI_CLI_OAUTH_PROJECT_ID
        || process.env.GEMINI_OAUTH_PROJECT_ID
        || process.env.GOOGLE_CLOUD_QUOTA_PROJECT
        || process.env.GOOGLE_CLOUD_PROJECT
        || geminiCliRecord?.metadata?.quota_project_id
        || geminiCliRecord?.metadata?.project_id
        || geminiCliRecord?.token?.quota_project_id
        || geminiCliRecord?.token?.project_id,
    ),
  };

  return {
    checkedAt: new Date().toISOString(),
    providers: {
      claude_code_oauth: {
        healthy: Boolean(claude.healthy),
        expires_in_hours: Number.isFinite(Number(claude.expires_in_hours)) ? Math.round(Number(claude.expires_in_hours) * 10) / 10 : null,
        needs_refresh: Boolean(claude.needs_refresh),
        error: claude.error || null,
      },
      openai_oauth: {
        healthy: Boolean(openai.healthy),
        source: openai.source || null,
        expires_at: openai.expires_at || null,
        needs_refresh: Boolean(openai.needs_refresh),
        error: openai.error || null,
      },
      gemini_cli_oauth: geminiCli,
      groq_pool: groq,
    },
  };
}

const HUB_TOOLS: HubControlTool[] = [
  {
    name: 'hub.health.query',
    ownerTeam: 'hub',
    description: 'Hub health/event 요약 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L0',
    executeEnabled: true,
    handler: async (input: ToolInput) => {
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
    handler: async (input: ToolInput) => {
      const labels = Array.isArray(input?.labels)
        ? input.labels.map((label: unknown) => normalizeText(label)).filter(Boolean)
        : ['ai.hub.resource-api', 'ai.claude.auto-dev.autonomous', 'ai.luna.marketdata-mcp'];
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
    handler: async (input: ToolInput) => {
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
    handler: async (input: ToolInput) => {
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
    handler: async (input: ToolInput) => validateSubagentSandbox({
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
    handler: async (input: ToolInput) => registerAgent({
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
    handler: async (input: ToolInput, context?: ToolContext) => sendAgentMessage({
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
    handler: async (input: ToolInput, context?: ToolContext) => ackAgentMessage({
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
    handler: async (input: ToolInput) => getAgentStatus({
      agentId: input?.agentId,
      incidentKey: input?.incidentKey,
    }),
  },
  {
    name: 'oauth.ops.status',
    ownerTeam: 'hub',
    description: 'OAuth provider 상태 조회(토큰 원문 비노출)',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async () => getOAuthOpsStatus(),
  },
  {
    name: 'oauth.ops.events',
    ownerTeam: 'hub',
    description: 'OAuth monitor 표준 이벤트 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async (input: ToolInput) => {
      const minutes = Math.max(1, Number(input?.minutes ?? 24 * 60) || 24 * 60);
      const limit = Math.min(100, Math.max(1, Number(input?.limit ?? 20) || 20));
      const rows = await getEventLake().search({
        eventType: 'hub_oauth_monitor',
        team: 'hub',
        minutes,
        limit,
      }) as EventLakeRow[];
      return {
        checkedAt: new Date().toISOString(),
        minutes,
        limit,
        rows: rows.map((row) => ({
          id: row.id,
          severity: row.severity,
          title: row.title,
          message: row.message,
          tags: row.tags || [],
          metadata: row.metadata || {},
          created_at: row.created_at,
        } as EventLakeRow)),
      };
    },
  },
  {
    name: 'oauth.ops.lock_janitor_plan',
    ownerTeam: 'hub',
    description: 'OAuth refresh lock janitor dry-run 계획 조회',
    sideEffect: 'read_only',
    defaultRisk: 'low',
    requiredTopicLevel: 'L1',
    executeEnabled: true,
    handler: async () => {
      const { cleanupOAuthRefreshLocks } = require('../oauth/refresh-lock');
      return cleanupOAuthRefreshLocks({ apply: false });
    },
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

const TOOL_MAP = new Map<string, HubControlTool>(HUB_TOOLS.map((tool) => [tool.name, tool]));

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

function hasHubControlTool(name: unknown): boolean {
  return TOOL_MAP.has(String(name || '').trim());
}

async function callHubControlTool(name: unknown, input: ToolInput = {}, context: ToolContext = {}) {
  const normalized = String(name || '').trim();
  const tool = TOOL_MAP.get(normalized);
  if (!tool) {
    return { ok: false, error: 'unknown_tool', tool: normalized };
  }
  const admission = validateAgentToolAdmission({
    tool,
    input: input || {},
    context: context || {},
  });
  if (!admission.ok) {
    await recordAgentGuardAudit(admission, {
      traceId: input?.traceId || context?.traceId || '',
      context: {
        requiredTopicLevel: tool.requiredTopicLevel,
        executeEnabled: tool.executeEnabled,
      },
    });
    return {
      ok: false,
      error: admission.error,
      tool: normalized,
      admission: admission.audit,
      statusCode: 403,
    };
  }
  if (!tool.executeEnabled && !['none', 'read_only'].includes(tool.sideEffect)) {
    const blocked = {
      ok: false,
      error: 'mutating_tool_disabled',
      tool: normalized,
      sideEffect: tool.sideEffect,
      requiredTopicLevel: tool.requiredTopicLevel,
    };
    await recordAgentGuardAudit({
      ok: false,
      error: blocked.error,
      audit: {
        ...admission.audit,
        decision: 'denied',
        reason: blocked.error,
      },
    }, {
      traceId: input?.traceId || context?.traceId || '',
    });
    return blocked;
  }
  await recordAgentGuardAudit(admission, {
    traceId: input?.traceId || context?.traceId || '',
    context: {
      requiredTopicLevel: tool.requiredTopicLevel,
      executeEnabled: tool.executeEnabled,
    },
  });
  try {
    const result = await tool.handler(input || {}, context || {});
    return {
      ok: true,
      tool: normalized,
      result,
      admission: admission.audit,
    };
  } catch (error) {
    const message = errorMessage(error || 'tool_execution_failed');
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

function isReadOnlyTool(name: unknown): boolean {
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
