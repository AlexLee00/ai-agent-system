import type { A2ATask, A2ATaskResult } from '../types.ts';

const SKILL_HANDLERS: Record<string, (params: unknown) => Promise<A2ATaskResult>> = {};

export function registerSkillHandler(
  skillId: string,
  handler: (params: unknown) => Promise<A2ATaskResult>
): void {
  SKILL_HANDLERS[skillId] = handler;
}

export async function handleTask(task: A2ATask): Promise<A2ATaskResult> {
  const skillId = task.skill?.id;
  if (!skillId) {
    return { id: task.id, status: 'failed', error: { code: -32602, message: 'skill.id 필수' } };
  }

  const handler = SKILL_HANDLERS[skillId];
  if (!handler) {
    return {
      id: task.id,
      status: 'failed',
      error: { code: -32601, message: `스킬 없음: ${skillId}` },
    };
  }

  try {
    const result = await handler(task.params);
    return { ...result, id: task.id, status: result.status || 'completed' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { id: task.id, status: 'failed', error: { code: -32000, message: msg } };
  }
}
