const crypto = require('node:crypto');
const pgPool = require('../../../../packages/core/lib/pg-pool');
const {
  parseControlPlanRequest,
  parseControlPlan,
  validateMutatingPlanPlaybook,
} = require('../control/plan-schema');
const { generateControlPlanDraft } = require('../control/planner');
const {
  listHubControlTools,
  callHubControlTool,
  isReadOnlyTool,
} = require('../control/tool-registry');

type ApprovalPolicy = {
  topicLevel: string;
  topicId: string | null;
  chatId: string | null;
  actorIds: string[];
  actorUsernames: string[];
  nonce: string;
  expiresAt: string;
  consumedAt: string | null;
};

type ControlRun = {
  id: string;
  status: 'draft' | 'approved' | 'cancelled' | 'dry_run_completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  traceId: string | null;
  requestedBy: string;
  team: string;
  plan: any;
  result?: any;
  error?: string | null;
  approval?: ApprovalPolicy | null;
  storage?: 'db' | 'memory_fallback';
};

const RUN_TABLE = 'agent.hub_control_runs';
const DB_DISABLED = String(process.env.HUB_CONTROL_STATE_STORE || '').trim().toLowerCase() === 'memory';
const runsFallback = new Map<string, ControlRun>();
let ensureRunTablePromise: Promise<void> | null = null;

function normalizeText(value: unknown, fallback = ''): string {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function normalizeTimestamp(value: unknown, fallback = ''): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  const text = normalizeText(value, fallback);
  if (!text) return fallback;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return fallback;
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeUsernames(value: unknown): string[] {
  return normalizeList(value).map((item) => item.replace(/^@+/, '').toLowerCase()).filter(Boolean);
}

function parseCsvEnv(name: string): string[] {
  return normalizeList(String(process.env[name] || '').split(','));
}

function parseCsvEnvUsernames(name: string): string[] {
  return normalizeUsernames(String(process.env[name] || '').split(','));
}

function parseBooleanEnv(name: string): boolean {
  const value = normalizeText(process.env[name], '').toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(value);
}

function getHeaderValue(req: any, headerName: string): string {
  const lower = headerName.toLowerCase();
  const candidate = req?.headers?.[lower]
    ?? req?.headers?.[headerName]
    ?? req?.get?.(headerName)
    ?? req?.get?.(lower);
  return normalizeText(Array.isArray(candidate) ? candidate[0] : candidate, '');
}

function safeTimingEqual(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(actual, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function verifyTrustedCallbackSource(req: any): {
  ok: boolean;
  status: number;
  error: string;
} {
  const configuredSecret = normalizeText(process.env.HUB_CONTROL_CALLBACK_SECRET, '');
  if (!configuredSecret) {
    return {
      ok: false,
      status: 503,
      error: 'approval_callback_secret_not_configured',
    };
  }
  const providedSecret = getHeaderValue(req, 'x-hub-control-callback-secret');
  if (!providedSecret || !safeTimingEqual(configuredSecret, providedSecret)) {
    return {
      ok: false,
      status: 403,
      error: 'approval_callback_untrusted_source',
    };
  }
  return { ok: true, status: 200, error: '' };
}

function extractApprovalActorContext(req: any): {
  actorId: string;
  actorUsername: string;
  topicId: string;
  chatId: string;
} {
  return {
    actorId: normalizeText(req?.body?.from?.id, ''),
    actorUsername: normalizeText(req?.body?.from?.username, '').replace(/^@+/, '').toLowerCase(),
    topicId: normalizeText(req?.body?.message?.message_thread_id, ''),
    chatId: normalizeText(req?.body?.message?.chat?.id, ''),
  };
}

function randomNonce(): string {
  return crypto.randomBytes(8).toString('hex');
}

function makeRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function hasMutatingStep(plan: any): boolean {
  return Array.isArray(plan?.steps)
    && plan.steps.some((step: any) => !isReadOnlyTool(String(step?.tool || '')));
}

function parseJsonObject(value: unknown, fallback: Record<string, unknown> = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function parseJsonList(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeList(value);
  if (typeof value === 'string') {
    try {
      return normalizeList(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function buildApprovalPolicy(): ApprovalPolicy {
  const ttlMinutes = Math.max(5, Number(process.env.HUB_CONTROL_APPROVAL_TTL_MINUTES || 30) || 30);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  return {
    topicLevel: normalizeText(process.env.HUB_CONTROL_APPROVAL_TOPIC_LEVEL, 'L3'),
    topicId: normalizeText(process.env.HUB_CONTROL_APPROVAL_TOPIC_ID, '') || null,
    chatId: normalizeText(process.env.HUB_CONTROL_APPROVAL_CHAT_ID, '') || null,
    actorIds: parseCsvEnv('HUB_CONTROL_APPROVER_IDS'),
    actorUsernames: parseCsvEnvUsernames('HUB_CONTROL_APPROVER_USERNAMES'),
    nonce: randomNonce(),
    expiresAt,
    consumedAt: null,
  };
}

function isApprovalPolicyConfigured(policy: ApprovalPolicy | null | undefined): boolean {
  if (!policy) return false;
  const hasApprover = policy.actorIds.length > 0 || policy.actorUsernames.length > 0;
  const hasChannelScope = Boolean(policy.topicId || policy.chatId);
  return hasApprover && hasChannelScope;
}

function buildStoreUnavailableError(scope: string, error: unknown): Error {
  const detail = String((error as any)?.message || error || 'unknown_error');
  const wrapped = new Error(`${scope}:${detail}`);
  (wrapped as any).code = 'control_state_store_unavailable';
  (wrapped as any).scope = scope;
  return wrapped;
}

function toServiceUnavailable(res: any, error: unknown) {
  const code = (error as any)?.code;
  if (code === 'control_state_store_unavailable') {
    return res.status(503).json({
      ok: false,
      error: 'control_state_store_unavailable',
      detail: String((error as any)?.message || error || 'unknown_error'),
    });
  }
  return null;
}

function rowToRun(row: any): ControlRun | null {
  if (!row) return null;
  const approval = row.approval_nonce
    ? {
        topicLevel: normalizeText(row.approval_topic_level, 'L3'),
        topicId: normalizeText(row.approval_topic_id, '') || null,
        chatId: normalizeText(row.approval_chat_id, '') || null,
        actorIds: parseJsonList(row.approval_actor_ids),
        actorUsernames: normalizeUsernames(parseJsonList(row.approval_actor_usernames)),
        nonce: normalizeText(row.approval_nonce),
        expiresAt: normalizeTimestamp(row.approval_expires_at, ''),
        consumedAt: normalizeTimestamp(row.approval_consumed_at, '') || null,
      }
    : null;
  return {
    id: normalizeText(row.run_id),
    status: normalizeText(row.status, 'draft') as ControlRun['status'],
    createdAt: normalizeTimestamp(row.created_at, new Date().toISOString()),
    updatedAt: normalizeTimestamp(row.updated_at, new Date().toISOString()),
    traceId: normalizeText(row.trace_id, '') || null,
    requestedBy: normalizeText(row.requested_by, 'anonymous'),
    team: normalizeText(row.team, 'general'),
    plan: parseJsonObject(row.plan),
    result: parseJsonObject(row.result, {}) || null,
    error: normalizeText(row.error, '') || null,
    approval,
    storage: 'db',
  };
}

async function ensureRunTable() {
  if (DB_DISABLED) return;
  if (ensureRunTablePromise) return ensureRunTablePromise;
  ensureRunTablePromise = (async () => {
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS ${RUN_TABLE} (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        trace_id TEXT,
        requested_by TEXT NOT NULL,
        team TEXT NOT NULL,
        plan JSONB NOT NULL DEFAULT '{}'::jsonb,
        result JSONB,
        error TEXT,
        approval_topic_level TEXT,
        approval_topic_id TEXT,
        approval_chat_id TEXT,
        approval_actor_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        approval_actor_usernames JSONB NOT NULL DEFAULT '[]'::jsonb,
        approval_nonce TEXT,
        approval_expires_at TIMESTAMPTZ,
        approval_consumed_at TIMESTAMPTZ
      )
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_control_runs_updated_desc_idx
      ON ${RUN_TABLE} (updated_at DESC)
    `, []);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_control_runs_status_idx
      ON ${RUN_TABLE} (status, updated_at DESC)
    `, []);
  })().catch((error) => {
    ensureRunTablePromise = null;
    throw error;
  });
  return ensureRunTablePromise;
}

async function saveRun(run: ControlRun): Promise<ControlRun> {
  const normalized: ControlRun = {
    ...run,
    createdAt: normalizeTimestamp(run.createdAt, new Date().toISOString()),
    updatedAt: normalizeTimestamp(run.updatedAt, new Date().toISOString()),
    result: run.result ?? null,
    error: normalizeText(run.error, '') || null,
    approval: run.approval
      ? {
          ...run.approval,
          expiresAt: normalizeTimestamp(run.approval.expiresAt, ''),
          consumedAt: normalizeTimestamp(run.approval.consumedAt, '') || null,
        }
      : null,
  };
  if (DB_DISABLED) {
    normalized.storage = 'memory_fallback';
    runsFallback.set(normalized.id, normalized);
    return normalized;
  }
  try {
    await ensureRunTable();
    const approval = normalized.approval;
    const row = await pgPool.get('agent', `
      INSERT INTO ${RUN_TABLE} (
        run_id,
        status,
        created_at,
        updated_at,
        trace_id,
        requested_by,
        team,
        plan,
        result,
        error,
        approval_topic_level,
        approval_topic_id,
        approval_chat_id,
        approval_actor_ids,
        approval_actor_usernames,
        approval_nonce,
        approval_expires_at,
        approval_consumed_at
      )
      VALUES (
        $1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7,
        $8::jsonb, $9::jsonb, $10, $11, $12, $13,
        $14::jsonb, $15::jsonb, $16, $17::timestamptz, $18::timestamptz
      )
      ON CONFLICT (run_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at,
        trace_id = EXCLUDED.trace_id,
        requested_by = EXCLUDED.requested_by,
        team = EXCLUDED.team,
        plan = EXCLUDED.plan,
        result = EXCLUDED.result,
        error = EXCLUDED.error,
        approval_topic_level = EXCLUDED.approval_topic_level,
        approval_topic_id = EXCLUDED.approval_topic_id,
        approval_chat_id = EXCLUDED.approval_chat_id,
        approval_actor_ids = EXCLUDED.approval_actor_ids,
        approval_actor_usernames = EXCLUDED.approval_actor_usernames,
        approval_nonce = EXCLUDED.approval_nonce,
        approval_expires_at = EXCLUDED.approval_expires_at,
        approval_consumed_at = EXCLUDED.approval_consumed_at
      RETURNING *
    `, [
      normalized.id,
      normalized.status,
      normalized.createdAt,
      normalized.updatedAt,
      normalized.traceId,
      normalized.requestedBy,
      normalized.team,
      JSON.stringify(normalized.plan || {}),
      JSON.stringify(normalized.result || {}),
      normalized.error,
      approval?.topicLevel || null,
      approval?.topicId || null,
      approval?.chatId || null,
      JSON.stringify(approval?.actorIds || []),
      JSON.stringify(approval?.actorUsernames || []),
      approval?.nonce || null,
      approval?.expiresAt || null,
      approval?.consumedAt || null,
    ]);
    const persisted = rowToRun(row) || { ...normalized, storage: 'db' };
    runsFallback.delete(normalized.id);
    return persisted;
  } catch (error) {
    console.error(`[hub/control] db unavailable saveRun: ${error?.message || error}`);
    throw buildStoreUnavailableError('saveRun', error);
  }
}

async function getRun(runId: string): Promise<ControlRun | null> {
  const normalizedRunId = normalizeText(runId);
  if (!normalizedRunId) return null;
  if (DB_DISABLED) return runsFallback.get(normalizedRunId) || null;
  try {
    await ensureRunTable();
    const row = await pgPool.get('agent', `
      SELECT *
      FROM ${RUN_TABLE}
      WHERE run_id = $1
    `, [normalizedRunId]);
    return rowToRun(row);
  } catch (error) {
    console.error(`[hub/control] db unavailable getRun: ${error?.message || error}`);
    throw buildStoreUnavailableError('getRun', error);
  }
}

function buildApprovalResponse(run: ControlRun) {
  if (!run.approval) return { required: false };
  return {
    required: true,
    topic_level: run.approval.topicLevel,
    topic_id: run.approval.topicId,
    chat_id: run.approval.chatId,
    expires_at: run.approval.expiresAt,
    actors: {
      ids: run.approval.actorIds,
      usernames: run.approval.actorUsernames,
    },
    callback_data: {
      approve: `hub_control:approve:${run.id}:${run.approval.nonce}`,
      reject: `hub_control:reject:${run.id}:${run.approval.nonce}`,
      details: `hub_control:details:${run.id}`,
    },
  };
}

function validateApprovalCallback(run: ControlRun, callbackContext: {
  action: string;
  nonce: string;
  actorId: string;
  actorUsername: string;
  topicId: string;
  chatId: string;
}) {
  if (!run.approval) return { ok: false, error: 'approval_metadata_missing' };
  const approval = run.approval;
  if (!isApprovalPolicyConfigured(approval)) {
    return { ok: false, error: 'approval_policy_not_configured' };
  }
  if (approval.consumedAt) return { ok: false, error: 'approval_nonce_already_consumed' };

  const nowMs = Date.now();
  const expiresMs = Date.parse(approval.expiresAt || '');
  if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
    return { ok: false, error: 'approval_callback_expired' };
  }

  if (callbackContext.action !== 'details') {
    if (!callbackContext.nonce || callbackContext.nonce !== approval.nonce) {
      return { ok: false, error: 'approval_nonce_mismatch' };
    }
    if (approval.actorIds.length > 0 && !approval.actorIds.includes(callbackContext.actorId)) {
      return { ok: false, error: 'approval_actor_not_allowed' };
    }
    if (approval.actorUsernames.length > 0 && !approval.actorUsernames.includes(callbackContext.actorUsername)) {
      return { ok: false, error: 'approval_actor_not_allowed' };
    }
    if (approval.topicId && callbackContext.topicId !== approval.topicId) {
      return { ok: false, error: 'approval_topic_mismatch' };
    }
    if (approval.chatId && callbackContext.chatId !== approval.chatId) {
      return { ok: false, error: 'approval_chat_mismatch' };
    }
  }
  return { ok: true };
}

function parseCallbackData(rawData: string) {
  const parts = rawData.split(':');
  const action = normalizeText(parts[1]);
  const runId = normalizeText(parts[2]);
  const nonce = normalizeText(parts[3], '');
  return { action, runId, nonce };
}

export async function controlToolsListRoute(_req: any, res: any) {
  return res.json({
    ok: true,
    tools: listHubControlTools(),
  });
}

export async function controlToolCallRoute(req: any, res: any) {
  try {
    const toolName = normalizeText(req.params?.name);
    if (!toolName) {
      return res.status(400).json({ ok: false, error: 'tool_name_required' });
    }
    if (!isReadOnlyTool(toolName)) {
      return res.status(403).json({
        ok: false,
        error: 'direct_tool_call_requires_control_plan',
        tool: toolName,
        reason: 'mutating_tools_must_use_control_plan',
      });
    }
    const context = {
      traceId: req.hubRequestContext?.traceId || null,
      callerTeam: req.hubRequestContext?.callerTeam || null,
      agent: req.hubRequestContext?.agent || null,
      priority: req.hubRequestContext?.priority || 'normal',
      source: 'direct_route',
    };
    const result = await callHubControlTool(toolName, req.body || {}, context);
    if (!result.ok) {
      return res.status(Number(result.statusCode || 400)).json(result);
    }
    return res.json(result);
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_tool_call_failed', detail: String((error as any)?.message || error) });
  }
}

export async function controlPlanRoute(req: any, res: any) {
  try {
    const parsed = parseControlPlanRequest(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const draft = await generateControlPlanDraft({
      message: parsed.data.message,
      goal: parsed.data.goal,
      team: parsed.data.team || req.hubRequestContext?.callerTeam || undefined,
      dryRun: parsed.data.dryRun ?? true,
    });
    if (!draft.ok) {
      return res.status(400).json({ ok: false, error: draft.error });
    }

    const mutating = hasMutatingStep(draft.plan) || draft.plan?.requiresApproval === true;
    const runId = makeRunId();
    const now = new Date().toISOString();
    const approval = mutating ? buildApprovalPolicy() : null;
    if (mutating && !isApprovalPolicyConfigured(approval)) {
      return res.status(503).json({
        ok: false,
        error: 'approval_policy_not_configured',
        detail: 'mutating_plan_requires_approval_actor_and_topic_scope',
      });
    }
    const run: ControlRun = {
      id: runId,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      traceId: req.hubRequestContext?.traceId || null,
      requestedBy: req.hubRequestContext?.agent || req.hubRequestContext?.callerTeam || 'anonymous',
      team: draft.plan.team || 'general',
      plan: draft.plan,
      approval,
    };

    const saved = await saveRun(run);

    return res.json({
      ok: true,
      run_id: saved.id,
      status: saved.status,
      planner_source: draft.planner_source,
      warnings: draft.warnings || [],
      plan: saved.plan,
      approval: buildApprovalResponse(saved),
      storage: saved.storage || null,
      audit: {
        topic: 'audit-log',
        dry_run: true,
        message: `plan_draft_created:${saved.id}`,
      },
    });
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_plan_failed', detail: String((error as any)?.message || error) });
  }
}

export async function controlExecuteRoute(req: any, res: any) {
  try {
    const runId = normalizeText(req.body?.run_id);
    const run = runId ? await getRun(runId) : null;
    const parsedPlan = parseControlPlan(req.body?.plan || run?.plan);
    if (!parsedPlan.ok) {
      return res.status(400).json({ ok: false, error: parsedPlan.error });
    }

    const plan = parsedPlan.data;
    const playbookCheck = validateMutatingPlanPlaybook(plan);
    if (!playbookCheck.ok) {
      return res.status(400).json({ ok: false, error: playbookCheck.error });
    }

    const mutating = hasMutatingStep(plan);
    if (mutating) {
      if (!run || run.status !== 'approved') {
        return res.status(403).json({
          ok: false,
          error: 'approval_required_for_mutating_plan',
          run_id: run?.id || null,
        });
      }
    }

    const stepResults: any[] = [];
    for (const step of plan.steps) {
      if (!isReadOnlyTool(step.tool)) {
        stepResults.push({
          step_id: step.id,
          tool: step.tool,
          ok: false,
          skipped: true,
          reason: 'mutating_step_disabled_in_mvp',
        });
        continue;
      }
      const toolResult = await callHubControlTool(step.tool, step.args || {}, {
        traceId: req.hubRequestContext?.traceId || null,
        callerTeam: req.hubRequestContext?.callerTeam || null,
        agent: req.hubRequestContext?.agent || 'control-executor',
        priority: req.hubRequestContext?.priority || 'normal',
        source: 'control_execute',
      });
      stepResults.push({
        step_id: step.id,
        tool: step.tool,
        ...toolResult,
      });
    }

    if (run) {
      const updated = await saveRun({
        ...run,
        status: 'dry_run_completed',
        updatedAt: new Date().toISOString(),
        result: stepResults,
      });
      return res.json({
        ok: true,
        run_id: updated.id,
        status: updated.status,
        dry_run: true,
        result: stepResults,
        storage: updated.storage || null,
        note: 'planner/executor MVP: mutating steps are disabled by policy',
      });
    }

    return res.json({
      ok: true,
      run_id: null,
      status: 'dry_run_completed',
      dry_run: true,
      result: stepResults,
      note: 'planner/executor MVP: mutating steps are disabled by policy',
    });
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_execute_failed', detail: String((error as any)?.message || error) });
  }
}

export async function controlRunStatusRoute(req: any, res: any) {
  try {
    const runId = normalizeText(req.params?.id);
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: 'run_not_found' });
    return res.json({ ok: true, run });
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_run_status_failed', detail: String((error as any)?.message || error) });
  }
}

export async function controlRunApproveRoute(req: any, res: any) {
  try {
    if (!parseBooleanEnv('HUB_CONTROL_ALLOW_DIRECT_APPROVE')) {
      return res.status(403).json({
        ok: false,
        error: 'direct_approve_disabled_use_callback',
      });
    }

    const trustedSource = verifyTrustedCallbackSource(req);
    if (!trustedSource.ok) {
      return res.status(trustedSource.status).json({
        ok: false,
        error: trustedSource.error,
      });
    }

    const runId = normalizeText(req.params?.id);
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: 'run_not_found' });

    if (run.approval) {
      const actorContext = extractApprovalActorContext(req);
      const validation = validateApprovalCallback(run, {
        action: 'approve',
        nonce: normalizeText(req.body?.nonce, ''),
        actorId: actorContext.actorId,
        actorUsername: actorContext.actorUsername,
        topicId: actorContext.topicId,
        chatId: actorContext.chatId,
      });
      if (!validation.ok) {
        return res.status(403).json({
          ok: false,
          error: validation.error,
          run_id: run.id,
          status: run.status,
        });
      }
    }

    const updated = await saveRun({
      ...run,
      status: 'approved',
      updatedAt: new Date().toISOString(),
      approval: run.approval
        ? {
            ...run.approval,
            consumedAt: run.approval.consumedAt || new Date().toISOString(),
          }
        : null,
    });
    return res.json({ ok: true, run_id: updated.id, status: updated.status });
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_run_approve_failed', detail: String((error as any)?.message || error) });
  }
}

export async function controlRunCancelRoute(req: any, res: any) {
  try {
    const runId = normalizeText(req.params?.id);
    const run = await getRun(runId);
    if (!run) return res.status(404).json({ ok: false, error: 'run_not_found' });
    const updated = await saveRun({
      ...run,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    return res.json({ ok: true, run_id: updated.id, status: updated.status });
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_run_cancel_failed', detail: String((error as any)?.message || error) });
  }
}

export async function controlCallbackRoute(req: any, res: any) {
  try {
    const callbackData = normalizeText(req.body?.callback_data);
    if (!callbackData.startsWith('hub_control:')) {
      return res.status(400).json({ ok: false, error: 'unsupported_callback_prefix' });
    }

    const parsed = parseCallbackData(callbackData);
    if (!parsed.runId) {
      return res.status(400).json({ ok: false, error: 'callback_run_id_required' });
    }
    if (!parsed.action) {
      return res.status(400).json({ ok: false, error: 'callback_action_required' });
    }

    const run = await getRun(parsed.runId);
    if (!run) return res.status(404).json({ ok: false, error: 'run_not_found' });

    if (parsed.action === 'details') {
      return res.json({
        ok: true,
        run_id: parsed.runId,
        status: run.status,
        details: run,
      });
    }

    if (!['approve', 'reject', 'cancel'].includes(parsed.action)) {
      return res.status(400).json({ ok: false, error: 'unsupported_callback_action' });
    }

    const trustedSource = verifyTrustedCallbackSource(req);
    if (!trustedSource.ok) {
      return res.status(trustedSource.status).json({
        ok: false,
        error: trustedSource.error,
        run_id: run.id,
        status: run.status,
      });
    }

    const actorContext = extractApprovalActorContext(req);
    const validation = validateApprovalCallback(run, {
      action: parsed.action,
      nonce: parsed.nonce,
      actorId: actorContext.actorId,
      actorUsername: actorContext.actorUsername,
      topicId: actorContext.topicId,
      chatId: actorContext.chatId,
    });
    if (!validation.ok) {
      return res.status(403).json({
        ok: false,
        error: validation.error,
        run_id: run.id,
        status: run.status,
      });
    }

    const updated = await saveRun({
      ...run,
      status: parsed.action === 'approve' ? 'approved' : 'cancelled',
      updatedAt: new Date().toISOString(),
      approval: run.approval
        ? {
            ...run.approval,
            consumedAt: new Date().toISOString(),
          }
        : null,
    });
    return res.json({
      ok: true,
      run_id: updated.id,
      status: updated.status,
    });
  } catch (error) {
    const handled = toServiceUnavailable(res, error);
    if (handled) return handled;
    return res.status(500).json({ ok: false, error: 'control_callback_failed', detail: String((error as any)?.message || error) });
  }
}
