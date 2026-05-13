// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerPublishScheduleSkill(): void {
  registerSkillHandler('publish-schedule', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { action?: 'list' | 'add' | 'cancel'; post_id?: string; scheduled_at?: string };
    const action = p?.action || 'list';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let result: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/blog/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      if (res.ok) result = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'publish-schedule', action, result, processedAt: new Date().toISOString() },
    };
  });
}
