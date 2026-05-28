import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import { buildSafety, completed, hubJson, toStringArray } from './symphony-common.ts';

function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export async function runPollTasks(params: unknown): Promise<A2ATaskResult> {
  const p = params && typeof params === 'object' ? params as any : {};
  const status = String(p.status || 'todo');
  const team = String(p.team || p.target_team || '');
  const limit = intParam(p.limit, 25, 1, 100);
  const offline = p.offline === true;
  const query = new URLSearchParams({ status, limit: String(limit) });
  if (team) query.set('team', team);

  const hubResult = offline
    ? { ok: false, skipped: true, reason: 'offline_fixture_mode' }
    : await hubJson(`/hub/tasks?${query.toString()}`, { timeoutMs: intParam(p.timeoutMs, 2000, 100, 10000) });

  const tasks = hubResult?.ok && (hubResult.payload as any)?.tasks
    ? (hubResult.payload as any).tasks
    : toStringArray(p.fixtureTaskIds).map((id) => ({ id, status, target_team: team || null }));

  return completed('poll-tasks', {
    mode: 'read_only_poll',
    query: { status, team: team || null, limit },
    hubReachable: hubResult?.ok === true,
    hubResult,
    tasks,
    safety: buildSafety(true),
  });
}

export function registerPollTasksSkill(): void {
  registerSkillHandler('poll-tasks', runPollTasks);
}
