// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerPromotionGateSkill(): void {
  registerSkillHandler('promotion-gate', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { promotion_id?: string; shadow_days?: number };
    const promotion_id = p?.promotion_id || '';
    const shadow_days = p?.shadow_days || 3;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let gateResult: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/ska/promotion-gate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ promotion_id, shadow_days }),
      });
      if (res.ok) gateResult = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'promotion-gate', promotion_id, shadow_days, gateResult, evaluatedAt: new Date().toISOString() },
    };
  });
}
