#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildEntryTriggerAgentPlan,
  shouldRunEntryTriggerPhase,
} from '../shared/entry-trigger-agent-plan.ts';

export async function runEntryTriggerAgentPlanSmoke({ json = false } = {}) {
  const defaults = buildEntryTriggerAgentPlan({
    runtime: {
      entryTriggerEnabled: true,
      signalRefreshEnabled: true,
      deriveMarketEventsRequested: true,
    },
  });
  assert.equal(defaults.source, 'default_entry_trigger_worker_plan');
  assert.equal(shouldRunEntryTriggerPhase(defaults, 'signal_refresh'), true);
  assert.equal(shouldRunEntryTriggerPhase(defaults, 'derive_market_events'), true);
  assert.equal(shouldRunEntryTriggerPhase(defaults, 'active_evaluation'), true);

  const reduced = buildEntryTriggerAgentPlan({
    agentPlan: {
      entryTrigger: {
        disabledPhases: ['signal_refresh', 'derive_market_events'],
      },
    },
    runtime: {
      entryTriggerEnabled: true,
      signalRefreshEnabled: true,
      deriveMarketEventsRequested: true,
    },
  });
  assert.equal(reduced.signalRefreshEnabled, false);
  assert.equal(reduced.deriveMarketEventsEnabled, false);
  assert.equal(reduced.activeEvaluationEnabled, true);

  const immutable = buildEntryTriggerAgentPlan({
    agentPlan: {
      entry_trigger_worker: {
        active_evaluation_enabled: false,
      },
    },
    runtime: {
      entryTriggerEnabled: true,
      signalRefreshEnabled: true,
      deriveMarketEventsRequested: true,
    },
  });
  assert.equal(immutable.activeEvaluationEnabled, true);
  assert.equal(immutable.warnings.includes('immutable_entry_trigger_phase:active_evaluation'), true);

  const disabledRuntime = buildEntryTriggerAgentPlan({
    agentPlan: {
      entryTrigger: {
        enabledPhases: ['active', 'derive'],
      },
    },
    runtime: {
      entryTriggerEnabled: false,
      signalRefreshEnabled: false,
      deriveMarketEventsRequested: false,
    },
  });
  assert.equal(disabledRuntime.activeEvaluationEnabled, false);
  assert.equal(disabledRuntime.signalRefreshEnabled, false);
  assert.equal(disabledRuntime.deriveMarketEventsEnabled, false);
  assert.equal(disabledRuntime.warnings.includes('runtime_disabled_phase_not_enabled:active_evaluation'), true);
  assert.equal(disabledRuntime.warnings.includes('derive_market_events_requires_runtime_request'), true);

  const oldEnv = process.env.LUNA_ENTRY_TRIGGER_AGENT_PLAN_JSON;
  process.env.LUNA_ENTRY_TRIGGER_AGENT_PLAN_JSON = JSON.stringify({
    entry_trigger: {
      enabled_phases: ['signal_refresh', 'unknown_phase'],
    },
  });
  try {
    const envPlan = buildEntryTriggerAgentPlan({
      runtime: {
        entryTriggerEnabled: true,
        signalRefreshEnabled: true,
        deriveMarketEventsRequested: true,
      },
    });
    assert.equal(envPlan.source, 'override');
    assert.equal(envPlan.signalRefreshEnabled, true);
    assert.equal(envPlan.deriveMarketEventsEnabled, false);
    assert.equal(envPlan.activeEvaluationEnabled, true);
    assert.equal(envPlan.warnings.includes('unknown_entry_trigger_phase:unknown_phase'), true);
    assert.equal(envPlan.warnings.includes('immutable_entry_trigger_phase:active_evaluation'), true);
  } finally {
    if (oldEnv === undefined) delete process.env.LUNA_ENTRY_TRIGGER_AGENT_PLAN_JSON;
    else process.env.LUNA_ENTRY_TRIGGER_AGENT_PLAN_JSON = oldEnv;
  }

  const summary = {
    ok: true,
    checked: 5,
    optionalPhases: ['signal_refresh', 'derive_market_events'],
    immutablePhases: ['active_evaluation'],
  };
  if (json) return summary;
  return { ...summary, text: 'entry trigger agent plan smoke ok' };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runEntryTriggerAgentPlanSmoke({ json: process.argv.includes('--json') }),
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[entry-trigger-agent-plan-smoke]',
  });
}
