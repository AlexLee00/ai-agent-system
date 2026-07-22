// @ts-nocheck

import { registerSkillHandler } from '../handlers/task-handler.ts';
import { runSigmaLunaFeedback } from '../../scripts/runtime-sigma-luna-feedback.ts';

export function isSigmaToLunaFeedbackWriteEnabled(env = process.env) {
  return String(env.SIGMA_LUNA_FEEDBACK_WRITE_ENABLED || '').trim().toLowerCase() === 'true';
}

export function registerSigmaToLunaFeedbackSkill() {
  registerSkillHandler('sigma-to-luna-feedback', async (params) => {
    const p = params || {};
    const writeRequested = p.write === true;
    const writeEnabled = writeRequested && isSigmaToLunaFeedbackWriteEnabled();
    const output = await runSigmaLunaFeedback({
      limit: Math.max(1, Number(p.limit || 20)),
      dryRun: !writeEnabled,
      write: writeEnabled,
    });
    return {
      id: '',
      status: 'completed',
      output: {
        skill: 'sigma-to-luna-feedback',
        writeRequested,
        writeEnabled,
        warning: writeRequested && !writeEnabled ? 'sigma_luna_feedback_write_disabled' : null,
        ...output,
      },
    };
  });
}
