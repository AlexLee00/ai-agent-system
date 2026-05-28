import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerCodeGenerationSkill(): void {
  registerSkillHandler('code-generation', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { spec?: string; target_team?: string; language?: string };
    const spec = p?.spec || '';
    const target_team = p?.target_team || 'investment';
    const language = p?.language || 'typescript';

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let result: unknown = { status: 'queued', message: '코드 생성 큐에 추가됨' };
    try {
      const res = await fetch(`${HUB_URL}/api/darwin/codegen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec, target_team, language }),
      });
      if (res.ok) result = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'code-generation', spec, target_team, language, result, requestedAt: new Date().toISOString() },
    };
  });
}
