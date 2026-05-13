// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerDoctorHealSkill(): void {
  registerSkillHandler('doctor-heal', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { target?: string; level?: 1 | 2 | 3 };
    const target = p?.target || '';
    const level = p?.level || 1;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let healResult: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/claude/doctor/heal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, level }),
      });
      if (res.ok) healResult = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'doctor-heal', target, level, healResult, healedAt: new Date().toISOString() },
    };
  });
}
