import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';
import {
  buildDispatchPlan,
  buildSafety,
  completed,
  dryRunEnabled,
  hubJson,
  normalizeTicket,
} from './symphony-common.ts';

export async function runDispatchTicket(params: unknown): Promise<A2ATaskResult> {
  const ticket = normalizeTicket(params);
  const plan = buildDispatchPlan(ticket);
  const dryRun = dryRunEnabled(params);
  const shouldCreate = (params as any)?.createTask === true;
  const hubResult = shouldCreate && !dryRun
    ? await hubJson('/hub/tasks', { method: 'POST', body: plan.hubTaskPayload })
    : null;

  return completed('dispatch-ticket', {
    mode: 'dispatch_plan',
    ticket,
    dispatch: plan,
    hubResult,
    safety: buildSafety(dryRun, { mutatesHub: shouldCreate && !dryRun }),
  });
}

export function registerDispatchTicketSkill(): void {
  registerSkillHandler('dispatch-ticket', runDispatchTicket);
}
