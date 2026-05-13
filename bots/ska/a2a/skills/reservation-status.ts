// @ts-nocheck
import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerReservationStatusSkill(): void {
  registerSkillHandler('reservation-status', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { period?: 'today' | 'week'; branch_id?: string };
    const period = p?.period || 'today';
    const branch_id = p?.branch_id;

    const HUB_URL = process.env.HUB_URL || 'http://localhost:7788';
    let status: unknown = {};
    try {
      const url = `${HUB_URL}/api/ska/reservations?period=${period}${branch_id ? `&branch_id=${branch_id}` : ''}`;
      const res = await fetch(url);
      if (res.ok) status = await res.json();
    } catch (_) {}

    return {
      id: '',
      status: 'completed',
      output: { skill: 'reservation-status', period, branch_id, status, fetchedAt: new Date().toISOString() },
    };
  });
}
