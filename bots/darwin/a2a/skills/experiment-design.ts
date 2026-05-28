import { registerSkillHandler } from '../handlers/task-handler.ts';
import type { A2ATaskResult } from '../types.ts';

export function registerExperimentDesignSkill(): void {
  registerSkillHandler('experiment-design', async (params: unknown): Promise<A2ATaskResult> => {
    const p = params as { hypothesis?: string; duration_days?: number };
    const hypothesis = p?.hypothesis || '';
    const duration_days = p?.duration_days || 7;

    return {
      id: '',
      status: 'completed',
      output: {
        skill: 'experiment-design',
        hypothesis,
        design: {
          type: 'shadow_ab',
          duration_days,
          metrics: ['win_rate', 'sharpe_delta', 'cost_delta'],
          control: 'current_policy',
          treatment: 'proposed_policy',
          shadow_mode: true,
        },
        designedAt: new Date().toISOString(),
      },
    };
  });
}
