// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerHealthCheckSkill(): void {
  registerSkillHandler('health-check', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { checks?: string[] };
    const checks = p?.checks || ['all'];

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let healthResult: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/claude/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checks }),
      });
      if (res.ok) healthResult = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'health-check', checks, healthResult, checkedAt: new Date().toISOString() },
    };
  });
}
