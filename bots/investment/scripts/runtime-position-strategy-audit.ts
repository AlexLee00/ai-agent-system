// @ts-nocheck

import * as db from '../shared/db.ts';
import { getInvestmentSyncRuntimeConfig } from '../shared/runtime-config.ts';

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

function getDustThresholdUsdt() {
  const syncRuntime = getInvestmentSyncRuntimeConfig();
  const threshold = Number(syncRuntime?.cryptoMinNotionalUsdt);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 10;
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
  const dustThresholdUsdt = getDustThresholdUsdt();

  const positionsWithProfiles = [];
  const positionsWithoutProfiles = [];
  const managedPositions = [];
  const dustPositions = [];
  for (const position of livePositions) {
    const notionalUsdt = Number(position.amount || 0) * Number(position.avg_price || 0);
    const isDust = position.exchange === 'binance' && notionalUsdt > 0 && notionalUsdt < dustThresholdUsdt;
    const key = `${position.exchange}:${position.symbol}`;
    const profile = profileMap.get(key) || null;
    if (isDust) dustPositions.push(position);
    else managedPositions.push(position);
    if (profile) {
      positionsWithProfiles.push({ position, profile });
    } else {
      positionsWithoutProfiles.push(position);
    }
  }

  const managedSymbols = new Set(managedPositions.map((position) => `${position.exchange}:${position.symbol}`));
  const dustSymbols = new Set(dustPositions.map((position) => `${position.exchange}:${position.symbol}`));
  const orphanProfiles = activeProfiles.filter((profile) => {
    const key = `${profile.exchange}:${profile.symbol}`;
    return !livePositions.some((position) => `${position.exchange}:${position.symbol}` === key);
  });
  const managedProfiles = activeProfiles.filter((profile) => managedSymbols.has(`${profile.exchange}:${profile.symbol}`));
  const dustProfiles = activeProfiles.filter((profile) => dustSymbols.has(`${profile.exchange}:${profile.symbol}`));

  const lifecycleDistribution = countBy(
    managedProfiles,
    (row) => String(row?.strategy_state?.lifecycleStatus || 'unknown'),
  );
  const setupDistribution = countBy(
    managedProfiles,
    (row) => String(row?.setup_type || 'unknown'),
  );
  const ownerDistribution = countBy(
    managedProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.ownerMode || 'unknown'),
  );
  const riskDistribution = countBy(
    managedProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.riskMission || 'unknown'),
  );
  const watchDistribution = countBy(
    managedProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.watchMission || 'unknown'),
  );
  const executionDistribution = countBy(
    managedProfiles,
    (row) => String(row?.strategy_context?.responsibilityPlan?.executionMission || 'unknown'),
  );

  const responsibilityCoverage = {
    owner: managedProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.ownerAgent).length,
    risk: managedProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.riskAgent).length,
    watch: managedProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.watchAgent).length,
    execution: managedProfiles.filter((row) => row?.strategy_context?.responsibilityPlan?.executionAgent).length,
  };

  const result = {
    ok: true,
    dustThresholdUsdt,
    livePositions: livePositions.length,
    managedPositions: managedPositions.length,
    dustPositions: dustPositions.length,
    activeProfiles: activeProfiles.length,
    managedProfiles: managedProfiles.length,
    dustProfiles: dustProfiles.length,
    matchedPositions: positionsWithProfiles.length,
    unmatchedPositions: positionsWithoutProfiles.length,
    unmatchedManagedPositions: positionsWithoutProfiles.filter((row) => !dustSymbols.has(`${row.exchange}:${row.symbol}`)).length,
    unmatchedDustPositions: positionsWithoutProfiles.filter((row) => dustSymbols.has(`${row.exchange}:${row.symbol}`)).length,
    orphanProfiles: orphanProfiles.length,
    responsibilityCoverage,
    responsibilityCoveragePct: {
      owner: managedProfiles.length ? safeNumber((responsibilityCoverage.owner / managedProfiles.length) * 100) : 0,
      risk: managedProfiles.length ? safeNumber((responsibilityCoverage.risk / managedProfiles.length) * 100) : 0,
      watch: managedProfiles.length ? safeNumber((responsibilityCoverage.watch / managedProfiles.length) * 100) : 0,
      execution: managedProfiles.length ? safeNumber((responsibilityCoverage.execution / managedProfiles.length) * 100) : 0,
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
      notionalUsdt: Number(row.amount || 0) * Number(row.avg_price || 0),
      isDust: dustSymbols.has(`${row.exchange}:${row.symbol}`),
    })),
    dustProfileSymbols: dustProfiles.map((row) => ({
      symbol: row.symbol,
      exchange: row.exchange,
      setupType: row.setup_type,
      lifecycleStatus: row?.strategy_state?.lifecycleStatus || 'unknown',
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
