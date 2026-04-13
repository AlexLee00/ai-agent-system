// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPlannerRuntimeDecision } from '../shared/analysis-planner-adapter.ts';

function parseArgs(args = []) {
  const getValue = (key, fallback = null) => {
    const match = args.find((arg) => String(arg).startsWith(`--${key}=`));
    return match ? String(match).split('=').slice(1).join('=') : fallback;
  };

  const numberOrNull = (value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };

  return {
    market: getValue('market', 'binance'),
    tradeMode: getValue('trade-mode', 'normal'),
    regime: getValue('regime', 'ranging'),
    atrRatio: numberOrNull(getValue('atr-ratio', '0.02')),
    fearGreed: numberOrNull(getValue('fear-greed', '50')),
    volumeRatio: numberOrNull(getValue('volume-ratio', '1')),
    consecutiveLosses: Number(getValue('consecutive-losses', '0')) || 0,
    highConviction: args.includes('--high-conviction'),
    capitalGuardTight: args.includes('--capital-guard-tight'),
    perceptionEnabled: args.includes('--perception-enabled') ? true : null,
    json: args.includes('--json'),
  };
}

export async function runPreScreenPlannerDryrun(options = {}) {
  const decision = buildPlannerRuntimeDecision({
    regimeSnapshot: {
      market: options.market,
      regime: options.regime,
      atrRatio: options.atrRatio,
    },
    tradeMode: options.tradeMode,
    fearGreed: options.fearGreed,
    volumeRatio: options.volumeRatio,
    consecutiveLosses: options.consecutiveLosses,
    highConviction: Boolean(options.highConviction),
    capitalGuardTight: Boolean(options.capitalGuardTight),
    perceptionEnabled: options.perceptionEnabled,
  });

  return {
    market: options.market,
    tradeMode: options.tradeMode,
    regime: options.regime,
    decision,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const parsed = parseArgs(process.argv.slice(2));
      return runPreScreenPlannerDryrun(parsed);
    },
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.decision.text);
    },
    errorPrefix: '[pre-screen-planner-dryrun]',
  });
}

export default {
  runPreScreenPlannerDryrun,
};
