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
  const gates = options.gates || await computeAllMarketDeploymentGates({
    ...options,
    queryFn: deps.queryFn || options.queryFn || db.query,
  });
  const inserted = [];

  if (writeHistory) {
    for (const gate of gates) {
      const result = await insertMarketGateHistory(gate, deps.runFn || db.run);
      inserted.push(result?.rows?.[0]?.id || null);
    }
  }

  const payload = {
    ok: true,
    dryRun,
    writeHistory,
    writeOutput,
    inserted,
    computedAt: new Date().toISOString(),
    summary: formatMarketGateDailyLine(gates),
    gates,
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
