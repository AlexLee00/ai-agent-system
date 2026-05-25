// @ts-nocheck
// Shadow-only HMM-style regime detector. This keeps Phase A usable without
// requiring heavy Python dependencies in the live path.

const REGIMES = ['bull', 'bear', 'sideways', 'volatile'];

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function round(value, digits = 6) {
  return Number(finite(value, 0).toFixed(digits));
}

function normalizeBars(input = {}) {
  const raw = Array.isArray(input) ? input : input.bars || input.ohlcv || input.candles || [];
  return raw.map((bar) => Array.isArray(bar)
    ? { open: finite(bar[1]), high: finite(bar[2]), low: finite(bar[3]), close: finite(bar[4]), volume: finite(bar[5]) }
    : {
        open: finite(bar.open ?? bar.o ?? bar.close ?? bar.price),
        high: finite(bar.high ?? bar.h ?? bar.close ?? bar.price),
        low: finite(bar.low ?? bar.l ?? bar.close ?? bar.price),
        close: finite(bar.close ?? bar.c ?? bar.price),
        volume: finite(bar.volume ?? bar.v),
      }).filter((bar) => bar.close > 0);
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values = []) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function softmax(scores = {}) {
  const values = REGIMES.map((regime) => finite(scores[regime], 0));
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(REGIMES.map((regime, index) => [regime, round(exp[index] / total, 4)]));
}

function transitionMatrix(probabilities = {}) {
  return Object.fromEntries(REGIMES.map((from) => {
    const stay = clamp(0.55 + finite(probabilities[from], 0.25) * 0.25, 0.55, 0.82);
    const spill = (1 - stay) / (REGIMES.length - 1);
    return [from, Object.fromEntries(REGIMES.map((to) => [to, round(to === from ? stay : spill, 4)]))];
  }));
}

export function detectHMMRegime(input = {}, options = {}) {
  const bars = normalizeBars(input);
  if (bars.length < 8) {
    return {
      ok: false,
      status: 'insufficient_bars',
      currentRegime: 'sideways',
      regimeProbabilities: { bull: 0.25, bear: 0.25, sideways: 0.25, volatile: 0.25 },
      transitionMatrix: transitionMatrix({ bull: 0.25, bear: 0.25, sideways: 0.25, volatile: 0.25 }),
      confidence: 0,
      shadowOnly: true,
    };
  }

  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume);
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);

  const recentReturns = returns.slice(-Math.min(20, returns.length));
  const recentTrend = mean(recentReturns);
  const vol = stdev(recentReturns);
  const volBaseline = stdev(returns.slice(-Math.min(60, returns.length))) || vol || 0.0001;
  const volumeRatio = mean(volumes.slice(-5)) / Math.max(1, mean(volumes.slice(-20)) || mean(volumes));
  const momentum20 = closes.length >= 21 ? (closes.at(-1) - closes.at(-21)) / closes.at(-21) : recentTrend * 20;
  const vixProxy = finite(options.vix ?? input.vix ?? input.vixProxy, null);

  const volatilityScore = clamp(vol / Math.max(0.0001, volBaseline), 0, 3);
  const scores = {
    bull: recentTrend * 80 + momentum20 * 6 + Math.max(0, volumeRatio - 1) * 0.25 - Math.max(0, volatilityScore - 1.8) * 0.6,
    bear: -recentTrend * 90 - momentum20 * 6 + Math.max(0, volatilityScore - 1.4) * 0.35,
    sideways: 1.2 - Math.abs(recentTrend) * 120 - Math.abs(momentum20) * 4 - Math.max(0, volatilityScore - 1.2) * 0.5,
    volatile: Math.max(0, volatilityScore - 0.8) * 1.2 + Math.max(0, Math.abs(recentTrend) * 50) + (vixProxy != null ? clamp((vixProxy - 18) / 20, 0, 1) : 0),
  };
  const regimeProbabilities = softmax(scores);
  const currentRegime = REGIMES
    .map((regime) => ({ regime, probability: regimeProbabilities[regime] }))
    .sort((a, b) => b.probability - a.probability)[0].regime;
  const confidence = clamp(regimeProbabilities[currentRegime] - 0.25, 0, 0.75) / 0.75;

  return {
    ok: true,
    status: 'hmm_regime_shadow_ready',
    currentRegime,
    regimeProbabilities,
    transitionMatrix: transitionMatrix(regimeProbabilities),
    confidence: round(confidence, 4),
    features: {
      recentTrend: round(recentTrend),
      momentum20: round(momentum20),
      volatility: round(vol),
      volatilityScore: round(volatilityScore, 4),
      volumeRatio: round(volumeRatio, 4),
      bars: bars.length,
    },
    shadowOnly: true,
  };
}

export default { detectHMMRegime };
