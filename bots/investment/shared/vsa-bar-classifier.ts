// @ts-nocheck

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function avg(values = []) {
  if (values.length <= 0) return 0;
  return values.reduce((sum, v) => sum + num(v, 0), 0) / values.length;
}

function barParts(bar = {}) {
  const open = num(bar.open ?? bar[1], 0);
  const high = num(bar.high ?? bar[2], open);
  const low = num(bar.low ?? bar[3], open);
  const close = num(bar.close ?? bar[4], open);
  const volume = num(bar.volume ?? bar[5], 0);
  const spread = Math.max(0, high - low);
  return { open, high, low, close, volume, spread };
}

export function classifyVsaBar(bar = {}, contextBars = []) {
  const current = barParts(bar);
  const history = Array.isArray(contextBars) ? contextBars.slice(-20).map(barParts) : [];
  if (history.length < 5) {
    return { pattern: null, strength: 0, reason: 'insufficient_context' };
  }

  const avgVol = avg(history.map((item) => item.volume));
  const avgSpread = avg(history.map((item) => item.spread));
  const closePos = current.spread > 0 ? (current.close - current.low) / current.spread : 0.5;
  const volRatio = avgVol > 0 ? current.volume / avgVol : 1;
  const spreadRatio = avgSpread > 0 ? current.spread / avgSpread : 1;

  let pattern = null;
  if (volRatio < 0.65 && spreadRatio < 0.75 && closePos < 0.45) {
    pattern = 'no_demand';
  } else if (volRatio < 0.65 && spreadRatio < 0.75 && closePos > 0.55) {
    pattern = 'no_supply';
  } else if (volRatio > 2.2 && spreadRatio < 0.9 && closePos > 0.6) {
    pattern = 'stopping_volume';
  } else if (volRatio > 2.5 && spreadRatio > 1.1) {
    pattern = 'climax_volume';
  } else if (volRatio > 1.8 && spreadRatio < 0.7) {
    pattern = 'effort_no_result';
  } else if (volRatio < 0.7 && spreadRatio > 1.15) {
    pattern = 'result_no_effort';
  }

  const strength = Math.max(0, Math.min(1, Number(((Math.abs(volRatio - 1) * 0.45) + (Math.abs(spreadRatio - 1) * 0.35) + (Math.abs(closePos - 0.5) * 0.2)).toFixed(4))));
  return {
    pattern,
    strength,
    metrics: {
      volRatio: Number(volRatio.toFixed(4)),
      spreadRatio: Number(spreadRatio.toFixed(4)),
      closePos: Number(closePos.toFixed(4)),
    },
  };
}

export default classifyVsaBar;
