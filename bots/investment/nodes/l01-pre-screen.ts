// @ts-nocheck
import { screenCryptoSymbols, screenDomesticSymbols, screenOverseasSymbols } from '../team/argos.ts';
import { buildPreScreenPlannerContext } from '../shared/pre-screen-planner-bridge.ts';

const NODE_ID = 'L01';

async function run({ market, meta = {} }) {
  const plannerContext = buildPreScreenPlannerContext({
    market,
    researchOnly: Boolean(meta?.research_only),
  });

  if (market === 'binance') {
    const symbols = await screenCryptoSymbols();
    return { market, symbols, source: 'argos', planner_context: plannerContext };
  }
  if (market === 'kis') {
    const symbols = await screenDomesticSymbols();
    return { market, symbols, source: 'argos', planner_context: plannerContext };
  }
  if (market === 'kis_overseas') {
    const symbols = await screenOverseasSymbols();
    return { market, symbols, source: 'argos', planner_context: plannerContext };
  }
  throw new Error(`지원하지 않는 market: ${market}`);
}

export default {
  id: NODE_ID,
  type: 'collect',
  label: 'pre-screen',
  run,
};
