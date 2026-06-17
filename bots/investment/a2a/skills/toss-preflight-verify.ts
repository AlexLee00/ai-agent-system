// @ts-nocheck

import { evaluateTossOrderPreflightHook } from '../../shared/brokers/toss-order-preflight-hook.ts';
import { registerSkillHandler } from '../handlers/task-handler.ts';

export const TOSS_PREFLIGHT_VERIFY_SKILL = 'toss-preflight-verify';

export function createTossPreflightVerifyHandler(options: Record<string, any> = {}) {
  return async function tossPreflightVerify(params: any = {}) {
    const candidate = {
      symbol: params.symbol,
      market: params.market || 'domestic',
      side: params.side || params.action || 'buy',
      quantity: params.quantity ?? params.qty ?? null,
    };
    let result;
    try {
      result = await (options.evaluateHook || evaluateTossOrderPreflightHook)(candidate, {
        ...params,
        stageOptions: { stage: params.stage || 's1_paper_mirror' },
      }, options.deps || {});
    } catch (error) {
      result = {
        ok: false,
        advisoryOnly: true,
        placed: false,
        liveMutation: false,
        reason: error?.message || String(error),
        checks: [],
      };
    }
    return {
      status: 'completed',
      output: {
        ok: result.ok,
        skill: TOSS_PREFLIGHT_VERIFY_SKILL,
        advisoryOnly: true,
        shadowMode: true,
        liveMutation: false,
        placed: false,
        result,
      },
      metadata: {
        liveMutation: false,
        protectedPidMutation: false,
      },
    };
  };
}

export function registerTossPreflightVerifySkill(options: Record<string, any> = {}) {
  registerSkillHandler(TOSS_PREFLIGHT_VERIFY_SKILL, createTossPreflightVerifyHandler(options) as any);
}

export default {
  TOSS_PREFLIGHT_VERIFY_SKILL,
  createTossPreflightVerifyHandler,
  registerTossPreflightVerifySkill,
};
