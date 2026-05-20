/**
 * GitHub Issues Webhook 핸들러
 *
 * GitHub → Hub → symphony_tasks 동기화
 *   - issues.opened  → INSERT (todo)
 *   - issues.closed  → UPDATE status=done
 *   - issues.labeled → team label 동기화 (target_team 갱신)
 *   - issues.reopened → UPDATE status=todo
 *
 * 팀 감지 규칙:
 *   issue label 'team:claude'|'team:luna'|... → target_team
 *   label 없으면 'claude' (기본값)
 *
 * 인증: X-Hub-Signature-256 HMAC (GITHUB_WEBHOOK_SECRET 설정 시)
 */

import crypto from 'crypto';

const pgPool = require('../../../../packages/core/lib/pg-pool');

const TEAM_LABELS: Record<string, string> = {
  'team:claude':  'claude',
  'team:luna':    'luna',
  'team:blog':    'blog',
  'team:ska':     'ska',
  'team:darwin':  'darwin',
  'team:sigma':   'sigma',
};

const PRIORITY_LABELS: Record<string, string> = {
  'priority:high':   'high',
  'priority:normal': 'normal',
  'priority:low':    'low',
};

const TYPE_LABELS: Record<string, string> = {
  'type:code-patch':  'code-patch',
  'type:analysis':    'analysis',
  'type:auto-dev':    'auto-dev',
  'type:config':      'config-update',
  'type:research':    'research',
};

function generateTaskId(): string {
  return `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function extractTeam(labels: Array<{ name: string }>): string {
  for (const label of labels) {
    const team = TEAM_LABELS[label.name];
    if (team) return team;
  }
  return 'claude';
}

function extractPriority(labels: Array<{ name: string }>): string {
  for (const label of labels) {
    const priority = PRIORITY_LABELS[label.name];
    if (priority) return priority;
  }
  return 'normal';
}

function extractType(labels: Array<{ name: string }>): string | null {
  for (const label of labels) {
    const type = TYPE_LABELS[label.name];
    if (type) return type;
  }
  return null;
}

function isSymphonyIssue(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name === 'symphony-task');
}

export async function handleIssueOpened(issue: any, repo: string): Promise<void> {
  const labels: Array<{ name: string }> = Array.isArray(issue.labels) ? issue.labels : [];

  if (!isSymphonyIssue(labels)) return;

  const existingTask = await pgPool.get('agent',
    'SELECT id FROM symphony_tasks WHERE source_ref = ? AND source = ?',
    [String(issue.number), 'github'],
  );
  if (existingTask) return;

  const id = generateTaskId();
  const target_team = extractTeam(labels);
  const priority = extractPriority(labels);
  const ticket_type = extractType(labels);
  const ticket_external_id = String(issue.html_url || '');
  const title = String(issue.title || '').trim() || `GitHub Issue #${issue.number}`;
  const body = String(issue.body || '').trim() || null;

  await pgPool.run('agent', `
    INSERT INTO symphony_tasks (
      id, source, target_team, ticket_type, title, body,
      priority, source_ref, ticket_external_id, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    'github',
    target_team,
    ticket_type,
    title,
    body,
    priority,
    String(issue.number),
    ticket_external_id,
    JSON.stringify({ repo, issue_number: issue.number, user: issue.user?.login }),
  ]);

  console.log(`[github-webhook] issue #${issue.number} → symphony_tasks ${id} (team=${target_team})`);
}

export async function handleIssueClosed(issue: any): Promise<void> {
  const task = await pgPool.get('agent',
    'SELECT id, status FROM symphony_tasks WHERE source_ref = ? AND source = ?',
    [String(issue.number), 'github'],
  );
  if (!task) return;
  if (task.status === 'done') return;

  await pgPool.run('agent',
    'UPDATE symphony_tasks SET status = ? WHERE id = ?',
    ['done', task.id],
  );
  console.log(`[github-webhook] issue #${issue.number} closed → task ${task.id} done`);
}

export async function handleIssueReopened(issue: any): Promise<void> {
  const task = await pgPool.get('agent',
    'SELECT id, status FROM symphony_tasks WHERE source_ref = ? AND source = ?',
    [String(issue.number), 'github'],
  );
  if (!task) {
    await handleIssueOpened(issue, '');
    return;
  }

  await pgPool.run('agent',
    'UPDATE symphony_tasks SET status = ? WHERE id = ?',
    ['todo', task.id],
  );
  console.log(`[github-webhook] issue #${issue.number} reopened → task ${task.id} todo`);
}

export async function handleIssueLabeled(issue: any): Promise<void> {
  const labels: Array<{ name: string }> = Array.isArray(issue.labels) ? issue.labels : [];
  const task = await pgPool.get('agent',
    'SELECT id, target_team FROM symphony_tasks WHERE source_ref = ? AND source = ?',
    [String(issue.number), 'github'],
  );
  if (!task) return;

  const newTeam = extractTeam(labels);
  const newPriority = extractPriority(labels);
  const newType = extractType(labels);

  const updates: string[] = [];
  const params: any[] = [];

  if (newTeam !== task.target_team) {
    updates.push('target_team = ?');
    params.push(newTeam);
  }
  updates.push('priority = ?');
  params.push(newPriority);

  if (newType !== null) {
    updates.push('ticket_type = ?');
    params.push(newType);
  }

  if (updates.length === 0) return;

  params.push(task.id);
  await pgPool.run('agent', `UPDATE symphony_tasks SET ${updates.join(', ')} WHERE id = ?`, params);
  console.log(`[github-webhook] issue #${issue.number} labeled → task ${task.id} team=${newTeam}`);
}

/**
 * GitHub Webhook Signature 검증 (HMAC-SHA256)
 * 운영 기본값은 fail-closed: GITHUB_WEBHOOK_SECRET 누락 시 거부한다.
 */
export function verifyGithubSignature(payload: Buffer, signature: string | undefined): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;

  const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
