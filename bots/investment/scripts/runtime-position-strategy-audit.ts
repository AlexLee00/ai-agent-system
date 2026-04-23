// @ts-nocheck

import * as db from '../shared/db.ts';

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function countBy(rows = [], selector) {
  return rows.reduce((acc, row) => {
    const key = selector(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function main() {
  await db.initSchema();

  const livePositions = await db.getAllPositions(null, false);
  const activeProfiles = await db.query(
    `SELECT *
       FROM position_strategy_profiles
      WHERE status = 'active'
      ORDER BY symbol, exchange, updated_at DESC`,
  );

  const profileMap = new Map(
    activeProfiles.map((row) => [`${row.exchange}:${row.symbol}`, row]),
  );

  const positionsWithProfiles = [];
  const positionsWithoutProfiles = [];
  for (const position of livePositions) {
    const key = `${position.exchange}:${position.symbol}`;
    const profile = profileMap.get(key) || null;
    if (profile) {
      positionsWithProfiles.push({ position, profile });
    } else {
      positionsWithoutProfiles.push(position);
    }
  }

  const orphanProfiles = activeProfiles.filter((profile) => {
    const key = `${profile.exchange}:${profile.symbol}`;
    return !livePositions.some((position) => `${position.exchange}:${position.symbol}` === key);
  });

  const lifecycleDistribution = countBy(
    activeProfiles,
    (row) => String(row?.strategy_state?.lifecycleStatus || 'unknown'),
  );
  const setupDistribution = countBy(
    activeProfiles,
    (row) => String(row?.setup_type || 'unknown'),
  );
  const ownerDistribution = countBy(
    activeProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.ownerMode || 'unknown'),
  );
  const riskDistribution = countBy(
    activeProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.riskMission || 'unknown'),
  );
  const watchDistribution = countBy(
    activeProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.watchMission || 'unknown'),
  );
  const executionDistribution = countBy(
    activeProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.executionMission || 'unknown'),
  );

  const responsibilityCoverage = {
    owner: activeProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.ownerAgent).length,
    risk: activeProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.riskAgent).length,
    watch: activeProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.watchAgent).length,
    execution: activeProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.executionAgent).length,
  };

  const result = {
    ok: true,
    livePositions: livePositions.length,
    activeProfiles: activeProfiles.length,
    matchedPositions: positionsWithProfiles.length,
    unmatchedPositions: positionsWithoutProfiles.length,
    orphanProfiles: orphanProfiles.length,
    responsibilityCoverage,
    responsibilityCoveragePct: {
      owner: activeProfiles.length ? safeNumber((responsibilityCoverage.owner / activeProfiles.length) * 100) : 0,
      risk: activeProfiles.length ? safeNumber((responsibilityCoverage.risk / activeProfiles.length) * 100) : 0,
      watch: activeProfiles.length ? safeNumber((responsibilityCoverage.watch / activeProfiles.length) * 100) : 0,
      execution: activeProfiles.length ? safeNumber((responsibilityCoverage.execution / activeProfiles.length) * 100) : 0,
    },
    lifecycleDistribution,
    setupDistribution,
    ownerDistribution,
    riskDistribution,
    watchDistribution,
    executionDistribution,
    unmatchedSymbols: positionsWithoutProfiles.map((row) => ({
      symbol: row.symbol,
      exchange: row.exchange,
      amount: row.amount,
      avgPrice: row.avg_price,
      unrealizedPnl: row.unrealized_pnl,
    })),
    orphanSymbols: orphanProfiles.map((row) => ({
      symbol: row.symbol,
      exchange: row.exchange,
      setupType: row.setup_type,
      lifecycleStatus: row?.strategy_state?.lifecycleStatus || 'unknown',
    })),
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error),
  }, null, 2));
  process.exit(1);
});
