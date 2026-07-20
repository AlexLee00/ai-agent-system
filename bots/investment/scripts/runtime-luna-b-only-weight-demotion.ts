#!/usr/bin/env node
// @ts-nocheck

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  B_ONLY_WEIGHT_DEMOTION_DEFAULTS,
  B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE,
  buildBOnlyWeightDemotionProposal,
  normalizeBOnlySymbol,
} from '../shared/b-only-weight-demotion.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { query } from '../shared/db/core.ts';

const DAY_MS = 86_400_000;
const REPORT_DIR = path.join(os.homedir(), '.ai-agent-system', 'reports');
const REPORT_PATTERN = /^luna-crypto-major-universe-simulation-\d{8}\.json$/;
const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const WRITE_CONFIRMATION = 'b-only-weight-demotion-proposal-only';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function valueArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  const number = finiteNumber(value, null);
  return number == null ? null : Number(number.toFixed(digits));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function latestSimulationReport(reportDir = REPORT_DIR) {
  const candidates = fs.readdirSync(reportDir)
    .filter((name) => REPORT_PATTERN.test(name))
    .map((name) => {
      const filePath = path.join(reportDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath));
  if (!candidates.length) throw new Error('major_universe_simulation_report_missing');
  return candidates[0].filePath;
}

export function validateSimulationReport(report) {
  const invalid = (reason) => {
    throw new Error(`major_universe_simulation_report_invalid:${reason}`);
  };
  if (!report || typeof report !== 'object' || Array.isArray(report)) invalid('shape');
  if (report.status !== 'done') invalid('status');
  if (report.readOnly !== true || Number(report.dbWrites) !== 0 || Number(report.orderPathAccess) !== 0) {
    invalid('read_only_contract');
  }
  const generatedAtMs = Date.parse(String(report.generatedAt || ''));
  const closedDailyCutoffMs = Date.parse(String(report?.layer2?.dataCutoffs?.dailyLastClosedBefore || ''));
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(closedDailyCutoffMs) || closedDailyCutoffMs > generatedAtMs) {
    invalid('closed_daily_cutoff');
  }
  if (Number(report?.layer2?.lookbackDays) !== B_ONLY_WEIGHT_DEMOTION_DEFAULTS.lookbackDays) {
    invalid('lookback_days');
  }
  if (Number(report?.layer2?.costAssumption?.totalRoundTripCostPct) !== B_ONLY_WEIGHT_DEMOTION_DEFAULTS.roundTripCostPct) {
    invalid('round_trip_cost');
  }
  const intervals = new Set(report?.layer2?.intervals || []);
  if (!intervals.has('1h') || !intervals.has('1d')) invalid('intervals');
  const groups = report?.layer2?.groups;
  if (!groups || !['A', 'B', 'C', 'D'].every((name) => Array.isArray(groups[name]))) invalid('groups');
  const normalizedGroups = Object.fromEntries(['A', 'B', 'C', 'D'].map((name) => [
    name,
    groups[name].map(normalizeBOnlySymbol).filter(Boolean),
  ]));
  if (
    normalizedGroups.A.length !== 30
    || normalizedGroups.B.length !== 20
    || normalizedGroups.C.length !== 10
    || normalizedGroups.D.length < 10
    || ['A', 'B', 'C', 'D'].some((name) => new Set(normalizedGroups[name]).size !== normalizedGroups[name].length)
  ) invalid('group_membership');
  const bSet = new Set(normalizedGroups.B);
  if (!normalizedGroups.C.every((symbol) => bSet.has(symbol))) invalid('c_not_subset_b');
  const expectedD = normalizedGroups.A.filter((symbol) => bSet.has(symbol));
  if (JSON.stringify(normalizedGroups.D) !== JSON.stringify(expectedD)) invalid('d_not_a_b_intersection');
  if (!Array.isArray(report?.layer2?.events)) invalid('events');
  const requiredGateNames = [
    '1_units',
    '2_missingness',
    '3_outliers',
    '4_exclusions',
    '5_membership',
    '6_costs',
    '7_read_only',
    '8_raw_samples',
    '9_time',
  ];
  if (!requiredGateNames.every((name) => report?.qualityGates?.[name]?.pass === true)) {
    invalid('quality_gate');
  }
  if (report.qualityGates['5_membership'].dIsExactIntersection !== true) invalid('membership_gate');
  if (report.qualityGates['1_units'].replayReturnUnit !== 'percent_points_net_of_cost') invalid('return_unit');
  return report;
}

export function readSimulationReport(filePath) {
  const raw = fs.readFileSync(filePath);
  const report = validateSimulationReport(JSON.parse(raw.toString('utf8')));
  return {
    report,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

async function fetchDailyKlines(symbol, startTime, endTime, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const params = new URLSearchParams({
      symbol: normalizeBOnlySymbol(symbol).replace('/', ''),
      interval: '1d',
      startTime: String(startTime),
      endTime: String(endTime),
      limit: '1000',
    });
    const response = await fetchImpl(`${BINANCE_KLINES_URL}?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LunaBOnlyWeightDemotion/1.0' },
    });
    if (!response?.ok) throw new Error(`binance_klines_http_${response?.status || 'unknown'}:${symbol}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error(`binance_klines_not_array:${symbol}`);
    return rows
      .filter((row) => Array.isArray(row) && row.length === 12)
      .map((row) => ({ closeTime: Number(row[6]), close: Number(row[4]) }))
      .filter((row) => Number.isFinite(row.closeTime)
        && row.closeTime <= endTime
        && Number.isFinite(row.close)
        && row.close > 0)
      .sort((left, right) => left.closeTime - right.closeTime);
  } finally {
    clearTimeout(timer);
  }
}

export async function loadRealD20Observations({
  symbols = [],
  windowEndAt,
  closedCandleCutoffAt = windowEndAt,
  config = B_ONLY_WEIGHT_DEMOTION_DEFAULTS,
  queryFn = query,
  fetchImpl = fetch,
} = {}) {
  const windowEndMs = Date.parse(String(windowEndAt));
  if (!Number.isFinite(windowEndMs)) throw new Error('window_end_invalid');
  const closedCandleCutoffMs = Date.parse(String(closedCandleCutoffAt));
  if (!Number.isFinite(closedCandleCutoffMs) || closedCandleCutoffMs > windowEndMs) {
    throw new Error('closed_candle_cutoff_invalid');
  }
  const windowStartMs = windowEndMs - config.lookbackDays * DAY_MS;
  const maturityCutoffMs = closedCandleCutoffMs - config.horizonDays * DAY_MS;
  const canonicalSymbols = [...new Set(symbols.map(normalizeBOnlySymbol).filter(Boolean))];
  if (!canonicalSymbols.length) return [];
  const rows = await queryFn(`
    SELECT trade_id, symbol, entry_time, entry_price
      FROM investment.trade_journal
     WHERE LOWER(COALESCE(exchange, '')) = 'binance'
       AND COALESCE(is_paper, false) = false
       AND COALESCE(exclude_from_learning, false) = false
       AND COALESCE(quality_flag, 'trusted') = 'trusted'
       AND entry_time >= ?
       AND entry_time <= ?
       AND entry_price > 0
       AND UPPER(REPLACE(symbol, '-', '/')) = ANY(?::text[])
     ORDER BY entry_time ASC, trade_id ASC
  `, [windowStartMs, maturityCutoffMs, canonicalSymbols]);
  const bySymbol = new Map();
  for (const row of rows || []) {
    const symbol = normalizeBOnlySymbol(row.symbol);
    const list = bySymbol.get(symbol) || [];
    list.push(row);
    bySymbol.set(symbol, list);
  }

  const observations = [];
  for (const [symbol, trades] of bySymbol.entries()) {
    const firstEntry = Math.min(...trades.map((row) => Number(row.entry_time)));
    const dailyRows = await fetchDailyKlines(symbol, firstEntry - DAY_MS, closedCandleCutoffMs, fetchImpl);
    for (const trade of trades) {
      const entryTime = Number(trade.entry_time);
      const entryPrice = Number(trade.entry_price);
      const targetTime = entryTime + config.horizonDays * DAY_MS;
      const forward = dailyRows.find((row) => row.closeTime >= targetTime);
      if (!forward || !Number.isFinite(entryPrice) || entryPrice <= 0) continue;
      observations.push({
        symbol,
        observedAt: new Date(entryTime).toISOString(),
        d20NetPct: round((forward.close / entryPrice - 1) * 100 - config.roundTripCostPct, 6),
        source: 'real',
        tradeId: trade.trade_id || null,
      });
    }
  }
  return observations;
}

function summarizeWeightedEvents(events, weightForSymbol) {
  const rows = events.filter((event) => finiteNumber(event.d20NetPct, null) != null);
  const weightedReturn = rows.reduce(
    (sum, event) => sum + Number(event.d20NetPct) * weightForSymbol(event.symbol),
    0,
  );
  const deployedUnits = rows.reduce((sum, event) => sum + weightForSymbol(event.symbol), 0);
  const positiveUnits = rows.reduce(
    (sum, event) => sum + (Number(event.d20NetPct) > 0 ? weightForSymbol(event.symbol) : 0),
    0,
  );
  return {
    observations: rows.length,
    deployedUnits: round(deployedUnits, 4),
    positiveObservationRatePct: rows.length
      ? round(rows.filter((event) => Number(event.d20NetPct) > 0).length / rows.length * 100, 4)
      : null,
    profitableCapitalRatePct: deployedUnits > 0 ? round(positiveUnits / deployedUnits * 100, 4) : null,
    meanReturnPct: round(mean(rows.map((event) => Number(event.d20NetPct))), 6),
    contributionPerOriginalUnitPct: rows.length ? round(weightedReturn / rows.length, 6) : null,
    returnOnDeployedUnitPct: deployedUnits > 0 ? round(weightedReturn / deployedUnits, 6) : null,
    totalReturnUnits: round(weightedReturn, 6),
  };
}

export function buildWeightDemotionSimulation({ report, proposal, realEvents = [] } = {}) {
  const bSymbols = new Set((report?.layer2?.groups?.B || []).map(normalizeBOnlySymbol));
  const windowStartMs = Date.parse(String(proposal?.windowStartAt || ''));
  const maturityCutoffMs = Date.parse(String(proposal?.windowEndAt || ''))
    - Number(proposal?.config?.horizonDays || B_ONLY_WEIGHT_DEMOTION_DEFAULTS.horizonDays) * DAY_MS;
  const events = [
    ...(report?.layer2?.events || []).map((event) => ({ ...event, observedAt: event.firedAt, source: 'virtual' })),
    ...(realEvents || []),
  ].filter((event) => {
    const observedAtMs = Date.parse(String(event.observedAt || event.firedAt || ''));
    return bSymbols.has(normalizeBOnlySymbol(event.symbol))
      && finiteNumber(event.d20NetPct, null) != null
      && Number.isFinite(observedAtMs)
      && observedAtMs >= windowStartMs
      && observedAtMs <= maturityCutoffMs;
  });
  const weightForSymbol = (symbol) => proposal?.symbols?.[normalizeBOnlySymbol(symbol)]?.recommendedWeight || 1;
  const before = summarizeWeightedEvents(events, () => 1);
  const after = summarizeWeightedEvents(events, weightForSymbol);
  const perSymbol = [...bSymbols].map((symbol) => {
    const symbolEvents = events.filter((event) => normalizeBOnlySymbol(event.symbol) === symbol);
    const returns = symbolEvents.map((event) => Number(event.d20NetPct));
    const weight = weightForSymbol(symbol);
    return {
      symbol,
      observations: returns.length,
      realObservations: symbolEvents.filter((event) => event.source === 'real').length,
      virtualObservations: symbolEvents.filter((event) => event.source !== 'real').length,
      winRatePct: returns.length ? round(returns.filter((value) => value > 0).length / returns.length * 100, 4) : null,
      meanReturnPct: round(mean(returns), 6),
      beforeWeight: 1,
      afterWeight: weight,
      afterContributionPct: returns.length ? round(mean(returns) * weight, 6) : null,
      changed: weight !== 1,
    };
  });
  return {
    basis: 'D-anchor combined real-entry and virtual d20, net of 0.30% round-trip cost',
    before,
    after,
    delta: {
      deployedUnits: round(after.deployedUnits - before.deployedUnits, 4),
      contributionPerOriginalUnitPct: round(
        after.contributionPerOriginalUnitPct - before.contributionPerOriginalUnitPct,
        6,
      ),
    },
    changedSymbols: perSymbol.filter((row) => row.changed),
    unchangedSymbols: perSymbol.filter((row) => !row.changed).map((row) => row.symbol),
    perSymbol,
  };
}

function writeProposalSnapshot(proposal, filePath, confirmation) {
  if (confirmation !== WRITE_CONFIRMATION) throw new Error('proposal_write_confirmation_missing');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
  return { written: true, filePath };
}

export async function runLunaBOnlyWeightDemotion(options = {}) {
  const simulationPath = options.simulationPath || latestSimulationReport(options.reportDir);
  const { report, sha256 } = readSimulationReport(simulationPath);
  const windowEndAt = report.generatedAt;
  const closedCandleCutoffAt = report.layer2.dataCutoffs.dailyLastClosedBefore;
  const realEvents = options.realEvents || (options.includeReal === false
    ? []
    : await loadRealD20Observations({
      symbols: report.layer2.groups.B,
      windowEndAt,
      closedCandleCutoffAt,
      queryFn: options.queryFn || query,
      fetchImpl: options.fetchImpl || fetch,
    }));
  const generatedAt = options.now instanceof Date
    ? options.now.toISOString()
    : new Date(options.now || Date.now()).toISOString();
  const proposal = buildBOnlyWeightDemotionProposal({
    groups: report.layer2.groups,
    virtualEvents: report.layer2.events,
    realEvents,
    generatedAt,
    windowEndAt,
  });
  const sensitivityProposal = buildBOnlyWeightDemotionProposal({
    groups: report.layer2.groups,
    virtualEvents: report.layer2.events,
    realEvents,
    generatedAt,
    windowEndAt,
    config: { minSamples: 50 },
  });
  const simulation = buildWeightDemotionSimulation({ report, proposal, realEvents });
  const sensitivity = Object.fromEntries(['BCH/USDT', 'ADA/USDT', 'SUI/USDT'].map((symbol) => [symbol, {
    baseMinSamples: proposal.symbols[symbol]?.recommendedWeight ?? 1,
    minSamples50: sensitivityProposal.symbols[symbol]?.recommendedWeight ?? 1,
  }]));
  const snapshot = options.writeProposal === true
    ? writeProposalSnapshot(
      proposal,
      options.proposalPath || B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE,
      options.confirmation,
    )
    : { written: false, filePath: options.proposalPath || B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE };
  return {
    ok: true,
    status: 'b_only_weight_demotion_shadow_proposal_ready',
    generatedAt,
    dryRun: options.writeProposal !== true,
    readOnlySources: true,
    liveMutation: false,
    databaseWrites: 0,
    orderPathAccess: false,
    source: { simulationPath, sha256, windowEndAt, closedCandleCutoffAt },
    realLayer: {
      observations: realEvents.length,
      symbols: [...new Set(realEvents.map((event) => normalizeBOnlySymbol(event.symbol)))],
    },
    proposal,
    simulation,
    sensitivity,
    interactions: {
      psr: 'admission allow/block only; never multiplied into B-only sizing',
      guardSizingAuthority: 'responsibility -> B-only multiplier -> minimum absolute guard cap',
      cadence: 'weekly proposal_only after Monday 09:20 major20 drift; no scheduler auto-apply added',
    },
    snapshot,
  };
}

async function main() {
  const result = await runLunaBOnlyWeightDemotion({
    simulationPath: valueArg('simulation'),
    includeReal: !hasFlag('no-real'),
    writeProposal: hasFlag('write-proposal'),
    proposalPath: valueArg('proposal-path') || B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE,
    confirmation: valueArg('confirm'),
  });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-b-only-weight-demotion] changed=${result.simulation.changedSymbols.length} dryRun=${result.dryRun}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-b-only-weight-demotion error:' });
}
