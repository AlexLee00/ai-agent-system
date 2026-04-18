const { BudgetGuardian } = require('../budget-guardian');

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
