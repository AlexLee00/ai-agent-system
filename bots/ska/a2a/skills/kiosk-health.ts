// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerKioskHealthSkill(): void {
  registerSkillHandler('kiosk-health', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { kiosk_id?: string; auto_heal?: boolean };
    const kiosk_id = p?.kiosk_id;
    const auto_heal = p?.auto_heal ?? false;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let health: unknown = {};
    try {
      const res = await fetch(`${HUB_URL}/api/ska/kiosk/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kiosk_id, auto_heal }),
      });
      if (res.ok) health = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'kiosk-health', kiosk_id, health, checkedAt: new Date().toISOString() },
    };
  });
}
