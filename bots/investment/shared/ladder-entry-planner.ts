// @ts-nocheck

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeWeights(steps, weights = []) {
  const clean = Array.from({ length: steps }, (_, index) => Math.max(0, n(weights[index], 0)));
  const sum = clean.reduce((acc, item) => acc + item, 0);
  if (sum > 0) return clean.map((item) => item / sum);
  return Array.from({ length: steps }, () => 1 / steps);
}

export function buildLadderEntryPlan({
  symbol = '',
  side = 'BUY',
  totalAmount = 0,
  entryPrice = 0,
  steps = 3,
  stepPct = 0.01,
  weights = null,
} = {}) {
  const amount = Math.max(0, n(totalAmount, 0));
  const price = Math.max(0, n(entryPrice, 0));
  const count = Math.max(1, Math.min(10, Math.floor(n(steps, 3))));
  const interval = Math.max(0, n(stepPct, 0.01));
  const normalizedWeights = normalizeWeights(count, Array.isArray(weights) ? weights : []);
  const rows = normalizedWeights.map((weight, index) => {
    const priceMultiplier = String(side).toUpperCase() === 'BUY'
      ? 1 - (interval * index)
      : 1 + (interval * index);
    const targetPrice = price > 0 ? price * priceMultiplier : null;
    return {
      step: index + 1,
      symbol,
      side: String(side || 'BUY').toUpperCase(),
      weight,
      amount: amount * weight,
      targetPrice,
      status: 'planned',
    };
  });
  const plannedTotal = rows.reduce((acc, row) => acc + row.amount, 0);
  return {
    enabled: rows.length > 1,
    shadowOnly: true,
    liveMutation: false,
    symbol,
    side: String(side || 'BUY').toUpperCase(),
    totalAmount: amount,
    plannedTotal,
    exceedsOriginalSizing: plannedTotal > amount + 1e-8,
    steps: rows,
  };
}

export async function evaluateLadderStepGate(step = {}, deps = {}) {
  const halt = deps.checkHalt ? await deps.checkHalt(step) : { halted: false };
  if (halt?.halted) return { ok: false, reason: 'halt_active', step };
  if (deps.preTradeCheck) {
    const check = await deps.preTradeCheck(step.symbol, step.side, step.amount, deps.exchange || 'binance', deps.tradeMode || 'normal');
    if (check?.allowed === false) return { ok: false, reason: check.reason || 'pre_trade_check_rejected', step, check };
  }
  return { ok: true, reason: null, step };
}

export async function buildGatedLadderPreview(plan = {}, deps = {}) {
  const accepted = [];
  const rejected = [];
  for (const step of plan.steps || []) {
    const gate = await evaluateLadderStepGate(step, deps);
    if (!gate.ok) {
      rejected.push(gate);
      break;
    }
    accepted.push(gate);
  }
  return {
    ...plan,
    acceptedSteps: accepted.length,
    rejectedSteps: rejected.length,
    stopped: rejected.length > 0,
    firstRejectReason: rejected[0]?.reason || null,
  };
}

export default {
  buildLadderEntryPlan,
  evaluateLadderStepGate,
  buildGatedLadderPreview,
};
