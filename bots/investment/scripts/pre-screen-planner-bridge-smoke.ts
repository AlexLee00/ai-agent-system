// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPreScreenPlannerContext } from '../shared/pre-screen-planner-bridge.ts';
import { buildPreScreenPlannerReport } from '../shared/pre-screen-planner-report.ts';

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
    timeMode: getValue('time-mode', null),
    tradeMode: getValue('trade-mode', null),
    researchOnly: args.includes('--research-only'),
    regime: getValue('regime', 'ranging'),
    atrRatio: numberOrNull(getValue('atr-ratio', '0.02')),
    fearGreed: numberOrNull(getValue('fear-greed', '50')),
    volumeRatio: numberOrNull(getValue('volume-ratio', '1')),
    consecutiveLosses: Number(getValue('consecutive-losses', '0')) || 0,
    highConviction: args.includes('--high-conviction'),
    capitalGuardTight: args.includes('--capital-guard-tight'),
    perceptionEnabled: args.includes('--perception-enabled') ? true : null,
    symbolCount: Number(getValue('symbol-count', '8')) || 0,
    json: args.includes('--json'),
  };
}

export async function runPreScreenPlannerBridgeSmoke(options = {}) {
  const plannerContext = buildPreScreenPlannerContext({
    market: options.market,
    tradeMode: options.tradeMode,
    researchOnly: Boolean(options.researchOnly),
    regimeSnapshot: {
      market: options.market,
      regime: options.regime,
      atrRatio: options.atrRatio,
    },
    runtimeSignals: {
      fearGreed: options.fearGreed,
      volumeRatio: options.volumeRatio,
      consecutiveLosses: options.consecutiveLosses,
      highConviction: Boolean(options.highConviction),
      capitalGuardTight: Boolean(options.capitalGuardTight),
      perceptionEnabled: options.perceptionEnabled,
    },
  });

  const payload = {
    market: options.market,
    source: 'planner-bridge-smoke',
    symbols: Array.from({ length: Math.max(0, options.symbolCount) }, (_, index) => `SYM${index + 1}`),
    planner_context: plannerContext,
  };

  return {
    payload,
    report: buildPreScreenPlannerReport(payload),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const parsed = parseArgs(process.argv.slice(2));
      return runPreScreenPlannerBridgeSmoke(parsed);
    },
    onSuccess: async (result) => {
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.report.text);
    },
    errorPrefix: '[pre-screen-planner-bridge-smoke]',
  });
}

export default {
  runPreScreenPlannerBridgeSmoke,
};
