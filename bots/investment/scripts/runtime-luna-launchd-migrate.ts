#!/usr/bin/env node
// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const TARGET_LABELS = [
  'ai.luna.commander',
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.investment.domestic',
  'ai.investment.overseas',
  'ai.investment.runtime-autopilot',
  'ai.elixir.supervisor',
  'ai.investment.health-check',
];

const PROTECTED_LABELS = new Set([
  'ai.luna.tradingview-ws',
  'ai.investment.commander',
]);

const RETIRE_GROUPS = [
  ['marketdata_ws_to_mcp', ['ai.luna.binance-ws', 'ai.luna.kis-ws-domestic', 'ai.luna.kis-ws-overseas']],
  ['maintenance_to_sweeper', ['ai.investment.maintenance-collect', 'ai.investment.position-watch', 'ai.investment.unrealized-pnl']],
  ['reports_to_skills', ['ai.luna.daily-report', 'ai.luna.weekly-review', 'ai.luna.shadow-auto-promote']],
  ['cycle_workers_to_luna_skills', ['ai.investment.luna-entry-trigger-worker', 'ai.investment.posttrade-feedback-worker']],
  ['market_alerts_to_reporter', [
    'ai.investment.market-alert-crypto-daily',
    'ai.investment.market-alert-domestic-open',
    'ai.investment.market-alert-domestic-close',
    'ai.investment.market-alert-overseas-open',
    'ai.investment.market-alert-overseas-close',
  ]],
  ['prescreen_to_argos', ['ai.investment.prescreen-domestic', 'ai.investment.prescreen-overseas']],
];

export function buildLaunchdMigrationPlan({ visibleLabels = [] } = {}) {
  const visible = new Set(visibleLabels);
  const retire = RETIRE_GROUPS.flatMap(([group, labels]) => labels.map((label) => ({
    group,
    label,
    visible: visible.has(label),
    protected: PROTECTED_LABELS.has(label),
    action: PROTECTED_LABELS.has(label) ? 'keep_protected' : 'retire_candidate',
  })));
  return {
    ok: retire.every((item) => !item.protected || item.action === 'keep_protected'),
    dryRun: true,
    targetLabels: TARGET_LABELS,
    retireCandidates: retire.filter((item) => item.action === 'retire_candidate'),
    protectedLabels: Array.from(PROTECTED_LABELS),
    steps: RETIRE_GROUPS.map(([group, labels]) => ({
      group,
      labels,
      action: 'dry_run_only',
      validation: 'wait_5m_and_run_luna_checks_before_next_group',
    })),
    note: 'No launchctl unload/load is executed by this script without a future explicit migration operator.',
  };
}

async function main() {
  const result = buildLaunchdMigrationPlan();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-launchd-migrate dry-run retire=${result.retireCandidates.length}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-launchd-migrate 실패:' });
}
