#!/usr/bin/env node
// @ts-nocheck
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function safeExec(command, args = []) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 5000 });
  } catch (error) {
    return error?.stdout?.toString?.() || '';
  }
}

export function buildLunaFullIntegrationBaseline() {
  const root = new URL('..', import.meta.url).pathname;
  const manualReconcile = safeExec('node', ['scripts/luna-reconcile-blocker-report.ts', '--json']);
  const launchd = safeExec('launchctl', ['list']);
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    phase: 'phase_0_baseline',
    liveTradeCommandsExecuted: false,
    files: {
      packageJson: existsSync(`${root}/package.json`),
      luna: existsSync(`${root}/team/luna.ts`),
      hephaestos: existsSync(`${root}/team/hephaestos.ts`),
      kairos: existsSync(`${root}/team/kairos.ts`),
      backtestMigration: existsSync(`${root}/migrations/20260501_backtest_runs.sql`),
    },
    scripts: {
      hasFullIntegrationCheck: Boolean(packageJson.scripts?.['check:luna-full-integration']),
      hasOmegaCheck: Boolean(packageJson.scripts?.['check:luna-final-omega']),
    },
    processSnapshot: {
      tradingviewWsVisible: launchd.includes('ai.luna.tradingview-ws'),
      commanderVisible: launchd.includes('ai.investment.commander') || launchd.includes('ai.luna.commander'),
    },
    manualReconcileSample: manualReconcile.slice(0, 1200),
  };
}

async function main() {
  const result = buildLunaFullIntegrationBaseline();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`[luna-full-integration] baseline ok=${result.ok}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-full-integration-baseline 실패:' });
}
