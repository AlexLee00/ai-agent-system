import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerMeasureEffectSkill(): void {
  registerSkillHandler('measure-effect', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { cycle_id?: string; windows?: string[] };
    const cycle_id = p?.cycle_id || '';
    const windows = p?.windows || ['24h', '7d', '30d'];

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let measurements: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/darwin/measure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cycle_id, windows }),
      });
      if (res.ok) measurements = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'measure-effect', cycle_id, windows, measurements, measuredAt: new Date().toISOString() },
    };
  });
}
