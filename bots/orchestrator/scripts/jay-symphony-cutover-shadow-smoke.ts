#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const {
  buildSymphonyCutoverShadowReports,
  evaluateSymphonyShadowDecision,
  isLiveSensitivePlanStep,
  resolveSymphonyCutoverConfig,
} = require('../lib/jay-symphony-cutover-shadow.ts');

const incident = {
  incidentKey: 'luna:entry:test',
  team: 'investment',
  intent: 'entry_trigger',
  message: 'Luna live position review',
  priority: 'high',
  args: {},
};

const moneyStep = {
  id: 'place-order',
  tool: 'luna.placeOrder',
  sideEffect: 'money_movement',
  notes: 'Place crypto order if approved',
  args: {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    quantity: 0.01,
  },
};

function stubBuildTaskPlan(task: any, overrides: any = {}) {
  const team = overrides.team || task.target_team || 'claude';
  const liveSensitive = overrides.liveSensitive ?? Boolean(task.metadata?.requires_live_execution);
  return {
    ok: liveSensitive ? false : true,
    dispatch: {
      targetTeam: team,
      agent: `${team}.lead`,
      role: 'team_lead_gateway',
      confidence: 0.9,
    },
    symphonyTask: {
      metadata: {
        requiresLiveExecution: liveSensitive,
      },
    },
    blockers: liveSensitive ? ['luna_live_sensitive_ticket_requires_shadow_or_master_approval'] : [],
    warnings: [],
  };
}

const offConfig = resolveSymphonyCutoverConfig({});
assert.equal(offConfig.mode, 'off');
assert.equal(offConfig.enabled, false);
assert.equal(offConfig.forceCommander, true);
assert.equal(
  buildSymphonyCutoverShadowReports({
    incident,
    plan: {},
    steps: [moneyStep],
    goal: 'test',
  }, {
    env: {},
    buildTaskPlan: stubBuildTaskPlan,
  }).length,
  0,
);

const shadowConfig = resolveSymphonyCutoverConfig({
  JAY_SYMPHONY_CUTOVER_MODE: 'shadow',
});
assert.equal(shadowConfig.enabled, true);
assert.equal(isLiveSensitivePlanStep({ incident, step: moneyStep }, shadowConfig), true);

const reports = buildSymphonyCutoverShadowReports({
  incident,
  plan: {},
  steps: [moneyStep],
  goal: 'test',
}, {
  config: shadowConfig,
  buildTaskPlan: stubBuildTaskPlan,
});
assert.equal(reports.length, 1);
assert.equal(reports[0].selectedRoute, 'legacy_commander');
assert.equal(reports[0].legacy.team, 'luna');
assert.equal(reports[0].symphony.team, 'luna');
assert.equal(reports[0].agreement.teamMatches, true);
assert.equal(reports[0].agreement.liveSensitiveFalseNegative, false);
assert.deepEqual(reports[0].safety, {
  mutatesRuntime: false,
  mutatesHub: false,
  mutatesGit: false,
  mutatesLaunchd: false,
  mutatesSecrets: false,
  executesRunner: false,
  executesCommander: false,
  sourceOfTruth: 'legacy_commander',
});

const falseNegative = evaluateSymphonyShadowDecision({
  incident,
  plan: {},
  step: moneyStep,
  goal: 'test',
}, {
  config: shadowConfig,
  buildTaskPlan: (task: any) => stubBuildTaskPlan(task, { liveSensitive: false, team: 'luna' }),
});
assert.equal(falseNegative.legacy.liveSensitive, true);
assert.equal(falseNegative.symphony.liveSensitive, false);
assert.equal(falseNegative.agreement.liveSensitiveFalseNegative, true);

console.log('jay_symphony_cutover_shadow_smoke_ok');
