import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerSystemMonitorSkill(): void {
  registerSkillHandler('system-monitor', async (_params: unknown): Promise<A2ATaskResult> => {
    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let snapshot: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/claude/dexter/snapshot`);
      if (res.ok) snapshot = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'system-monitor', snapshot, capturedAt: new Date().toISOString() },
    };
  });
}
