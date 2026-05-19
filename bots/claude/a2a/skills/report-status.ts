// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { buildSafety, completed, dryRunEnabled, hubJson } from './symphony-common.ts';

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['review', 'blocked', 'done'],
  review: ['done', 'in_progress', 'blocked'],
  blocked: ['todo', 'in_progress'],
  done: [],
};

export async function runReportStatus(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const dryRun = dryRunEnabled(params);
  const taskId = String(p.taskId || p.id || '');
  const fromStatus = String(p.fromStatus || p.currentStatus || p.task?.status || '');
  const toStatus = String(p.status || p.toStatus || '');
  const allowed = fromStatus ? (ALLOWED_TRANSITIONS[fromStatus] || []) : [];
  const transitionAllowed = !fromStatus || allowed.includes(toStatus);
  const patchPayload = {
    status: toStatus || undefined,
    assignee: p.assignee,
    workspace_id: p.workspace_id || p.workspaceId,
    pr_url: p.pr_url || p.prUrl,
    error_msg: p.error_msg || p.errorMsg,
    metadata: p.metadata,
  };
  Object.keys(patchPayload).forEach((key) => patchPayload[key] === undefined && delete patchPayload[key]);

  const patchResult = taskId && toStatus && transitionAllowed && !dryRun
    ? await hubJson(`/hub/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: patchPayload })
    : null;

  return completed('report-status', {
    mode: 'status_report_plan',
    taskId: taskId || null,
    fromStatus: fromStatus || null,
    toStatus: toStatus || null,
    allowedTransitions: allowed,
    transitionAllowed,
    patchPayload,
    patchResult,
    githubSyncPlan: p.pr_url || p.prUrl ? { action: 'link_pr', url: p.pr_url || p.prUrl } : null,
    safety: buildSafety(dryRun, { mutatesHub: Boolean(taskId && toStatus && transitionAllowed && !dryRun) }),
  });
}

export function registerReportStatusSkill(): void {
  registerSkillHandler('report-status', runReportStatus);
}
