// @ts-nocheck
'use strict';

const { buildSymphonyWorkspacePlan } = require('./workspace-adapter.ts');
const { buildSymphonyRunnerPlan } = require('./runner-adapter.ts');
const { buildSymphonyValidationPlan } = require('./validation-adapter.ts');
const {
  buildDispatchPlan,
  normalizeTicket,
  validateDispatchPlan,
} = require('./team-dispatcher.ts');

function nowIso() {
  return new Date().toISOString();
}

function intParam(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function textOf(input) {
  if (input === undefined || input === null) return '';
  if (Array.isArray(input)) return input.map(textOf).filter(Boolean).join(' ');
  if (typeof input === 'object') return Object.values(input).map(textOf).join(' ');
  return String(input);
}

function isLiveSensitiveTicket(task = {}, dispatch = {}) {
  const text = textOf([task.title, task.body, task.ticket_type, task.metadata]).toLowerCase();
  if (dispatch.targetTeam !== 'luna') return false;
  return /(live|실투자|cutover|strategy-tune|signal-add|position|포지션|매수|매도)/i.test(text);
}

function normalizeHubTask(row = {}) {
  const task = normalizeTicket({
    ...row,
    target_team: row.target_team || row.targetTeam,
    ticket_type: row.ticket_type || row.ticketType,
    source_ref: row.source_ref || row.sourceRef,
    ticket_external_id: row.ticket_external_id || row.ticketExternalId,
  });
  return {
    ...task,
    id: String(row.id || task.id || '').trim(),
    status: String(row.status || 'todo').trim(),
    target_team: row.target_team || row.targetTeam || task.target_team || task.targetTeam,
    workspace_id: row.workspace_id || row.workspaceId || null,
    pr_url: row.pr_url || row.prUrl || null,
    error_msg: row.error_msg || row.errorMsg || null,
  };
}

function toSymphonyTask(task = {}, dispatch = {}) {
  return {
    id: task.id || 'unpersisted-task',
    source: task.source || 'hub',
    sourcePath: task.source_ref || task.ticket_external_id || task.id || null,
    title: task.title || '(untitled symphony task)',
    status: task.status || 'todo',
    metadata: {
      targetTeam: dispatch.targetTeam,
      ownerAgent: dispatch.agent,
      riskTier: task.priority === 'high' ? 'elevated' : 'normal',
      taskType: task.ticket_type || null,
      requiresLiveExecution: isLiveSensitiveTicket(task, dispatch),
    },
    scope: {
      write: task.metadata?.write_scope || [],
      test: task.metadata?.test_scope || [],
    },
  };
}

function buildPatchPayload(task = {}, dispatch = {}, workspace = {}, runner = {}, blockers = []) {
  const status = blockers.length > 0 ? 'blocked' : 'in_progress';
  const payload = {
    status,
    assignee: dispatch.agent,
    error_msg: blockers.length > 0 ? blockers.join('; ') : null,
    metadata: {
      ...(task.metadata || {}),
      symphonyOrchestrator: {
        dispatch,
        plannedWorkspace: workspace,
        runner,
        plannedStatus: status,
        plannedAt: nowIso(),
      },
    },
  };
  if (workspace.createsFiles === true || workspace.mutatesGit === true) {
    payload.workspace_id = workspace.worktreePath || null;
  }
  return payload;
}

function buildTaskPlan(taskInput = {}, options = {}) {
  const task = normalizeHubTask(taskInput);
  const dispatch = buildDispatchPlan(task);
  const dispatchValidation = validateDispatchPlan(dispatch);
  const symphonyTask = toSymphonyTask(task, dispatch);
  const workspace = buildSymphonyWorkspacePlan(symphonyTask, options.workspace || {});
  const runner = buildSymphonyRunnerPlan(symphonyTask, options.runner || {});
  const validation = buildSymphonyValidationPlan(symphonyTask);
  const blockers = [...dispatchValidation.blockers];
  const warnings = [...dispatchValidation.warnings];

  if (!task.title) blockers.push('missing_task_title');
  if (runner.blocked) blockers.push(runner.blockReason || 'runner_blocked');
  if (isLiveSensitiveTicket(task, dispatch)) {
    blockers.push('luna_live_sensitive_ticket_requires_shadow_or_master_approval');
  }
  if (workspace.mutatesGit !== false || workspace.createsFiles !== false) {
    blockers.push('workspace_adapter_must_remain_plan_only_until_approved');
  }

  const patchPayload = buildPatchPayload(task, dispatch, workspace, runner, blockers);
  return {
    ok: blockers.length === 0,
    task,
    dispatch,
    dispatchValidation,
    symphonyTask,
    workspace,
    runner,
    validation,
    blockers,
    warnings,
    patchPayload,
    recommendedNextAction: blockers.length > 0
      ? 'resolve_blockers_before_claim'
      : 'claim_task_when_operator_allows_hub_mutation',
  };
}

async function hubJson(path, {
  method = 'GET',
  body = undefined,
  hubUrl = process.env.HUB_URL || 'http://localhost:7788',
  timeoutMs = 2000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${hubUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHubTasks({
  hubUrl = process.env.HUB_URL || 'http://localhost:7788',
  status = 'todo',
  team = '',
  limit = 10,
  timeoutMs = 2000,
} = {}) {
  const query = new URLSearchParams({ status, limit: String(limit) });
  if (team) query.set('team', team);
  const result = await hubJson(`/hub/tasks?${query.toString()}`, { hubUrl, timeoutMs });
  const tasks = result.ok && Array.isArray(result.payload?.tasks) ? result.payload.tasks : [];
  return { ...result, tasks };
}

async function runSymphonyOrchestratorCycle(options = {}) {
  const maxTasks = intParam(options.maxTasks, 10, 1, 50);
  const dryRun = options.dryRun !== false;
  const apply = options.apply === true && !dryRun;
  const suppliedTasks = Array.isArray(options.tasks) ? options.tasks : [];
  const pollHub = suppliedTasks.length === 0 && options.pollHub !== false;
  const hubPoll = pollHub
    ? await fetchHubTasks({
        hubUrl: options.hubUrl,
        status: options.status || 'todo',
        team: options.team || '',
        limit: maxTasks,
        timeoutMs: intParam(options.timeoutMs, 2000, 100, 10000),
      })
    : { ok: false, skipped: true, tasks: suppliedTasks };
  const tasks = suppliedTasks.length > 0 ? suppliedTasks.slice(0, maxTasks) : hubPoll.tasks.slice(0, maxTasks);
  const plans = tasks.map((task) => buildTaskPlan(task, options));
  const cycleBlockers = [];
  const patchResults = [];

  if (apply) {
    for (const plan of plans) {
      if (!plan.task.id) {
        patchResults.push({ ok: false, skipped: true, reason: 'missing_task_id' });
        continue;
      }
      const result = await hubJson(`/hub/tasks/${encodeURIComponent(plan.task.id)}`, {
        method: 'PATCH',
        body: plan.patchPayload,
        hubUrl: options.hubUrl,
        timeoutMs: intParam(options.timeoutMs, 2000, 100, 10000),
      });
      patchResults.push(result);
      if (!result.ok) cycleBlockers.push(`hub_patch_failed:${plan.task.id}:${result.error || result.status}`);
    }
  }

  const planBlockers = plans.flatMap((plan) => plan.blockers.map((blocker) => `${plan.task.id || 'unpersisted'}:${blocker}`));
  const status = cycleBlockers.length > 0 || planBlockers.length > 0
    ? 'blocked'
    : tasks.length === 0
      ? 'idle'
      : apply
        ? 'applied'
        : 'ready';

  return {
    ok: status === 'ready' || status === 'idle' || status === 'applied',
    status,
    generatedAt: nowIso(),
    mode: apply ? 'hub_patch_apply' : 'dry_run_plan',
    dryRun,
    safety: {
      mutatesHub: apply,
      mutatesGit: false,
      createsWorktree: false,
      executesRunner: false,
      mutatesLaunchd: false,
      mutatesSecrets: false,
    },
    hubPoll,
    count: tasks.length,
    blockers: [...planBlockers, ...cycleBlockers],
    plans,
    patchResults,
  };
}

module.exports = {
  buildTaskPlan,
  fetchHubTasks,
  normalizeHubTask,
  runSymphonyOrchestratorCycle,
};
