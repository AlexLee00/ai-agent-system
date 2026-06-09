import { createRequire } from 'module';
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import {
  asObject,
  buildDispatchPlan,
  buildSafety,
  completed,
  dryRunEnabled,
  hubJson,
  normalizeTicket,
} from './symphony-common.ts';

const require = createRequire(__filename);
const { buildSymphonyWorkspacePlan } = require('../../lib/symphony/workspace-adapter.ts');
const { buildSymphonyRunnerPlan } = require('../../lib/symphony/runner-adapter.ts');

type AssignPatchPayload = {
  status: string;
  assignee: unknown;
  workspace_id?: unknown;
  metadata: Record<string, unknown>;
};

function symphonyTaskFromHubTask(task: Record<string, unknown>, dispatch: Record<string, unknown>): Record<string, unknown> {
  const metadata = asObject(task.metadata);
  return {
    id: task.id || 'unpersisted-task',
    sourcePath: task.source_ref || task.ticket_external_id || null,
    title: task.title || '(untitled symphony task)',
    metadata: {
      targetTeam: dispatch.targetTeam,
      ownerAgent: dispatch.agent,
      riskTier: task.priority === 'high' ? 'elevated' : 'normal',
    },
    scope: {
      write: metadata.write_scope || [],
      test: metadata.test_scope || [],
    },
  };
}

export async function runAssignAgent(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const dryRun = dryRunEnabled(params);
  let task = normalizeTicket(p.task || p.ticket || p);
  let loadResult = null;

  if (p.taskId && !p.task) {
    loadResult = await hubJson(`/hub/tasks/${encodeURIComponent(String(p.taskId))}`, { timeoutMs: 2000 });
    if (loadResult.ok && (loadResult.payload as any)?.task) task = (loadResult.payload as any).task;
  }

  const dispatch = buildDispatchPlan(task);
  const symphonyTask = symphonyTaskFromHubTask(task, dispatch);
  const workspace = buildSymphonyWorkspacePlan(symphonyTask);
  const runner = buildSymphonyRunnerPlan(symphonyTask);
  const shouldClaim = p.claim === true;
  const patchPayload: AssignPatchPayload = {
    status: 'in_progress',
    assignee: dispatch.agent,
    metadata: {
      ...asObject(task.metadata),
      symphonyAssignment: { dispatch, plannedWorkspace: workspace, runner },
    },
  };
  if (workspace.createsFiles === true || workspace.mutatesGit === true) {
    patchPayload.workspace_id = workspace.worktreePath;
  }
  const claimResult = shouldClaim && !dryRun && task.id
    ? await hubJson(`/hub/tasks/${encodeURIComponent(String(task.id))}`, { method: 'PATCH', body: patchPayload })
    : null;

  return completed('assign-agent', {
    mode: 'assignment_plan',
    task,
    loadResult,
    dispatch,
    workspace,
    runner,
    patchPayload,
    claimResult,
    safety: buildSafety(dryRun, { mutatesHub: shouldClaim && !dryRun }),
  });
}

export function registerAssignAgentSkill(): void {
  registerSkillHandler('assign-agent', runAssignAgent);
}
