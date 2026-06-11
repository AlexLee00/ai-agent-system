#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import {
  computeAllMarketDeploymentGates,
  formatMarketGateDailyLine,
} from '../shared/luna-market-deployment-gate.ts';
import {
  computeAllRegimeStates,
  formatRegimeDailyLine,
  insertRegimeStateHistory,
  processRegimeAlerts,
} from '../shared/luna-regime-engine.ts';
import {
  computeStrategyFamilySignals,
  insertStrategyFamilySignals,
  summarizeStrategyFamilySignals,
} from '../shared/luna-strategy-families.ts';
import {
  evaluateEntryPreflightsForSignals,
  insertEntryPreflightLogs,
  summarizeEntryPreflightEvaluations,
} from '../shared/luna-entry-preflight-gate.ts';
import {
  evaluateLossCircuits,
  insertCircuitLocks,
  summarizeCircuitLocks,
} from '../shared/luna-loss-circuit.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_PATH = path.join(INVESTMENT_ROOT, 'output', 'luna-market-gate.json');

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function insertMarketGateHistory(gate: any, runFn = db.run) {
  return runFn(
    `INSERT INTO luna_market_gate_history
       (market, score, deployment, signals, computed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [
      gate.market,
      gate.score,
      gate.deployment,
      JSON.stringify({
        effectiveDeployment: gate.effectiveDeployment,
        reason: gate.reason,
        availableSignalCount: gate.availableSignalCount,
        totalSignalCount: gate.totalSignalCount,
        thresholds: gate.thresholds,
        signals: gate.signals,
        shadowOnly: true,
      }),
      gate.computedAt || new Date().toISOString(),
    ],
  );
}

async function writeOutputFile(result: any, outputPath = DEFAULT_OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return outputPath;
}

export async function runLunaMarketGate(options: any = {}, deps: any = {}) {
  const dryRun = options.dryRun === true;
  const writeHistory = options.writeHistory !== false && !dryRun;
  const writeOutput = options.writeOutput !== false && !dryRun;
  let gates = Array.isArray(options.gates) ? options.gates : [];
  let regimes = Array.isArray(options.regimes) ? options.regimes : [];
  let strategySignals = Array.isArray(options.strategySignals) ? options.strategySignals : [];
  let preflightEvaluations = Array.isArray(options.preflightEvaluations) ? options.preflightEvaluations : [];
  let circuitLocks = Array.isArray(options.circuitLocks) ? options.circuitLocks : [];
  let gateError = null;
  let regimeError = null;
  let strategyError = null;
  let preflightError = null;
  let circuitError = null;

  if (!Array.isArray(options.gates)) {
    try {
      const computeGates = deps.computeAllMarketDeploymentGates || computeAllMarketDeploymentGates;
      gates = await computeGates({
        ...options,
        queryFn: deps.queryFn || options.queryFn || db.query,
      });
    } catch (error) {
      gateError = error?.message || String(error);
      gates = [];
    }
  }

  if (!Array.isArray(options.regimes)) {
    try {
      const computeRegimes = deps.computeAllRegimeStates || computeAllRegimeStates;
      regimes = await computeRegimes({
        ...options,
        queryFn: deps.queryFn || options.queryFn || db.query,
      }, deps);
    } catch (error) {
      regimeError = error?.message || String(error);
      regimes = [];
    }
  }

  if (!Array.isArray(options.strategySignals)) {
    try {
      const computeStrategies = deps.computeStrategyFamilySignals || computeStrategyFamilySignals;
      const regimeByMarket = new Map((regimes || []).map((state) => [state.market, state]));
      const strategyResult = await computeStrategies({
        ...options,
        regimes,
        // Strategy-family snapshots must reuse the market-level regime state.
        // Otherwise a large watchlist can recompute per symbol and distort regime operational logs.
        regimeByMarket,
        queryFn: deps.queryFn || options.queryFn || db.query,
      }, deps);
      strategySignals = strategyResult.signals || [];
      if (strategyResult.errors?.length) strategyError = strategyResult.errors;
    } catch (error) {
      strategyError = error?.message || String(error);
      strategySignals = [];
    }
  }

  if (!Array.isArray(options.preflightEvaluations)) {
    try {
      const evaluatePreflights = deps.evaluateEntryPreflightsForSignals || evaluateEntryPreflightsForSignals;
      preflightEvaluations = await evaluatePreflights(strategySignals, {
        ...options,
        queryFn: deps.queryFn || options.queryFn || db.query,
      }, deps);
    } catch (error) {
      preflightError = error?.message || String(error);
      preflightEvaluations = [];
    }
  }

  if (!Array.isArray(options.circuitLocks)) {
    try {
      const evaluateCircuits = deps.evaluateLossCircuits || evaluateLossCircuits;
      const circuitResult = await evaluateCircuits({
        ...options,
        signals: strategySignals,
        queryFn: deps.queryFn || options.queryFn || db.query,
      }, deps);
      circuitLocks = circuitResult.locks || [];
    } catch (error) {
      circuitError = error?.message || String(error);
      circuitLocks = [];
    }
  }

  const inserted = [];
  const regimeInserted = [];
  const strategyInserted = [];
  const preflightInserted = [];
  const circuitInserted = [];
  let circuitSkippedDuplicates = 0;

  if (writeHistory) {
    for (const gate of gates) {
      const result = await insertMarketGateHistory(gate, deps.runFn || db.run);
      inserted.push(result?.rows?.[0]?.id || null);
    }
    for (const regime of regimes) {
      const result = await insertRegimeStateHistory(regime, deps.runFn || db.run);
      regimeInserted.push(result?.rows?.[0]?.id || null);
    }
    try {
      const result = await insertStrategyFamilySignals(strategySignals, deps.runFn || db.run);
      strategyInserted.push(...result);
    } catch (error) {
      strategyError = error?.message || String(error);
    }
    try {
      const idBySignalKey = new Map();
      strategySignals.forEach((signal, index) => {
        const key = `${signal.market}:${signal.symbol}:${signal.family}:${signal.candleTs}:${signal.signalType}`;
        idBySignalKey.set(key, strategyInserted[index] || null);
      });
      const enrichedPreflights = preflightEvaluations.map((row) => {
        if (row.strategySignalId != null) return row;
        const key = `${row.market}:${row.symbol}:${row.family}:${row.candleTs}:entry`;
        return { ...row, strategySignalId: idBySignalKey.get(key) || null };
      });
      const result = await insertEntryPreflightLogs(enrichedPreflights, deps.runFn || db.run);
      preflightInserted.push(...result);
    } catch (error) {
      preflightError = error?.message || String(error);
    }
    try {
      const result = await insertCircuitLocks(circuitLocks, deps.runFn || db.run, {
        skipActiveDuplicates: true,
        queryFn: deps.queryFn || options.queryFn || db.query,
        now: options.now,
      });
      circuitInserted.push(...result);
      circuitSkippedDuplicates = Number(result?.skippedDuplicates || 0);
    } catch (error) {
      circuitError = error?.message || String(error);
    }
  }

  const regimeAlerts = regimes.length > 0
    ? await processRegimeAlerts(regimes, {
        ...options,
        writeOutput,
        publish: options.publishRegimeAlerts !== false && !dryRun,
        alertOutputPath: options.alertOutputPath,
      }, deps)
    : null;
  const gateLine = formatMarketGateDailyLine(gates);
  const regimeLine = formatRegimeDailyLine(regimes);
  const strategyLine = summarizeStrategyFamilySignals(strategySignals);
  const preflightSummary = summarizeEntryPreflightEvaluations(preflightEvaluations);
  const circuitSummary = summarizeCircuitLocks(circuitLocks);
  const circuitDuplicateSuffix = circuitSkippedDuplicates > 0 ? `·중복스킵 ${circuitSkippedDuplicates}` : '';
  const preflightCircuitLine = `${preflightSummary.line} / ${circuitSummary.line}${circuitDuplicateSuffix}`;

  const payload = {
    ok: gateError == null || regimeError == null || strategyError == null || preflightError == null || circuitError == null,
    dryRun,
    writeHistory,
    writeOutput,
    inserted,
    regimeInserted,
    strategyInserted,
    preflightInserted,
    circuitInserted,
    circuitSkippedDuplicates,
    computedAt: new Date().toISOString(),
    summary: [gateLine, regimeLine, strategyLine, preflightCircuitLine].join('\n'),
    gateError,
    regimeError,
    strategyError,
    preflightError,
    circuitError,
    regimeAlerts,
    gates,
    regimes,
    strategySignals,
    preflightEvaluations,
    circuitLocks,
    shadowOnly: true,
    liveMutation: false,
    protectedPidMutation: false,
  };
  const outputPath = writeOutput ? await writeOutputFile(payload, options.outputPath || DEFAULT_OUTPUT_PATH) : null;
  return { ...payload, outputPath };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaMarketGate({
      dryRun: hasFlag('dry-run') || hasFlag('no-write'),
      writeOutput: !hasFlag('no-output'),
      outputPath: argValue('output', DEFAULT_OUTPUT_PATH),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ runtime-luna-market-gate 실패:',
  });
}
