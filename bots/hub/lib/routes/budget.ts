const { BudgetGuardian } = require('../budget-guardian');
const {
  getTokenBudgetUsageSummary,
  listTokenBudgetProfiles,
  resolveTokenBudget,
} = require('../../../../packages/core/lib/token-budget');

export async function reserveBudgetRoute(req: any, res: any) {
  const { team, estimated_cost } = req.body ?? {};
  if (!team || typeof estimated_cost !== 'number') {
    return res.status(400).json({ error: 'team and estimated_cost required' });
  }
  const result = BudgetGuardian.getInstance().checkAndReserve(team, estimated_cost);
  res.json(result);
}

export async function budgetUsageRoute(_req: any, res: any) {
  const bg = BudgetGuardian.getInstance();
  const usage = bg.getCurrentUsage();
  res.json({ ok: true, ...usage });
}

export async function tokenBudgetCheckRoute(req: any, res: any) {
  const budget = resolveTokenBudget(req.body || {});
  res.status(budget.ok ? 200 : 429).json({
    ok: budget.ok,
    reason: budget.reason || null,
    profile: budget.profileName,
    inputTokens: budget.inputTokens,
    maxOutputTokens: budget.maxOutputTokens,
    estimatedTotalTokens: budget.estimatedTotalTokens,
    estimatedCostUsd: budget.estimatedCostUsd,
    budgetCostUsd: budget.budgetCostUsd,
    timeoutMs: budget.timeoutMs,
    perAttemptTimeoutMs: budget.perAttemptTimeoutMs,
    fallbackAttempts: budget.fallbackAttempts,
  });
}

export async function tokenBudgetProfilesRoute(_req: any, res: any) {
  res.json({
    ok: true,
    profiles: listTokenBudgetProfiles(),
  });
}

export async function tokenBudgetUsageRoute(req: any, res: any) {
  const minutes = Math.max(1, Math.min(10080, Number(req.query?.minutes || 60) || 60));
  const usage = await getTokenBudgetUsageSummary(minutes);
  res.json({
    ok: true,
    minutes,
    usage,
  });
}
