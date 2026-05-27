// @ts-nocheck

import { registerSkillHandler } from '../handlers/task-handler.ts';
import { runSigmaLunaFeedback } from '../../scripts/runtime-sigma-luna-feedback.ts';

export function registerSigmaToLunaFeedbackSkill() {
  registerSkillHandler('sigma-to-luna-feedback', async (params) => {
    const p = params || {};
    const output = await runSigmaLunaFeedback({
      limit: Math.max(1, Number(p.limit || 20)),
      dryRun: p.write !== true,
      write: p.write === true,
    });
    return { id: '', status: 'completed', output: { skill: 'sigma-to-luna-feedback', ...output } };
  });
}
