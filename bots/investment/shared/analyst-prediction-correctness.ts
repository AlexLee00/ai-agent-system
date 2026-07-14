// @ts-nocheck

export function isAnalystPredictionCorrect(prediction, side, profitable) {
  if (prediction === 'neutral') return null;
  const marketWentUp = String(side || '').toLowerCase() === 'buy' ? profitable : !profitable;
  if (prediction === 'bullish') return marketWentUp;
  if (prediction === 'bearish') return !marketWentUp;
  return null;
}
