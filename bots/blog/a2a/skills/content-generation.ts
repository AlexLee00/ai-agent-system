// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerContentGenerationSkill(): void {
  registerSkillHandler('content-generation', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { keyword?: string; category?: string; length?: number };
    const keyword = p?.keyword || '';
    const category = p?.category || 'general';
    const length = p?.length || 1000;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let draft: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/blog/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword, category, length }),
      });
      if (res.ok) draft = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'content-generation', keyword, category, draft, generatedAt: new Date().toISOString() },
    };
  });
}
