import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import {
  buildDispatchPlan,
  buildSafety,
  completed,
  dryRunEnabled,
  hubJson,
  toStringArray,
} from './symphony-common.ts';

function labelsFromIssue(issue: Record<string, unknown>): string[] {
  const raw = Array.isArray(issue.labels) ? issue.labels : [];
  return raw.map((label) => typeof label === 'string' ? label : String((label as any)?.name || '')).filter(Boolean);
}

export async function runSyncGithub(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const dryRun = dryRunEnabled(params);
  const issue = p.issue && typeof p.issue === 'object' ? p.issue : {};
  const labels = [...labelsFromIssue(issue), ...toStringArray(p.labels)];
  const action = String(p.action || 'opened');
  const ticket = {
    source: 'github',
    title: issue.title || p.title || '(untitled github issue)',
    body: issue.body || p.body || '',
    source_ref: issue.number ? String(issue.number) : p.source_ref,
    ticket_external_id: issue.html_url || p.ticket_external_id,
    labels,
    priority: labels.includes('priority:high') ? 'high' : 'normal',
    metadata: {
      githubAction: action,
      repository: p.repository?.full_name || p.repository || null,
      sender: p.sender?.login || p.sender || null,
    },
  };
  const dispatch = buildDispatchPlan(ticket);
  const shouldCreate = ['opened', 'reopened', 'labeled'].includes(action) && p.createTask === true;
  const createResult = shouldCreate && !dryRun
    ? await hubJson('/hub/tasks', { method: 'POST', body: dispatch.hubTaskPayload })
    : null;

  return completed('sync-github', {
    mode: 'github_sync_plan',
    action,
    ticket,
    dispatch,
    createResult,
    statusMapping: action === 'closed' ? { status: 'done' } : { status: 'todo' },
    safety: buildSafety(dryRun, { mutatesHub: shouldCreate && !dryRun }),
  });
}

export function registerSyncGithubSkill(): void {
  registerSkillHandler('sync-github', runSyncGithub);
}
