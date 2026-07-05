// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerTrendCheckSkill(): void {
  registerSkillHandler('trend-check', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { sources?: string[]; limit?: number };
    const sources = p?.sources || ['hn', 'naver_it', 'devto'];
    const limit = p?.limit || 10;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let trends: unknown[] = [];
    try {
      const res = await fetch(`${HUB_URL}/api/blog/trends`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, limit }),
      });
      if (res.ok) trends = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'trend-check', sources, trends, checkedAt: new Date().toISOString() },
    };
  });
}
