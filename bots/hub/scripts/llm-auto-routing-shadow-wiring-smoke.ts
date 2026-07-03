#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyAutoRoutingShadowWiring,
  buildAutoRoutingInput,
  mapAutoRoutingResultUpdate,
  recordAutoRoutingResult,
  resolveAutoRoutingMode,
} from '../lib/routes/llm.ts';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

function fixtureRequest(overrides = {}) {
  return {
    callerTeam: 'hub',
    agent: 'archer',
    prompt: 'Analyze this issue and propose a fix.',
    systemPrompt: 'You are a careful reviewer.',
    abstractModel: 'anthropic_haiku',
    taskType: 'analysis',
    ...overrides,
  };
}

function assertDisabledModeDoesNotCallRouteModel() {
  for (const env of [{}, { LLM_AUTO_ROUTING_ENABLED: 'false' }, { LLM_AUTO_ROUTING_ENABLED: '' }]) {
    let calls = 0;
    const request = fixtureRequest();
    const decision = applyAutoRoutingShadowWiring(request, {
      env,
      routeModel: () => {
        calls += 1;
        throw new Error('routeModel should not be called');
      },
    });
    assert.equal(resolveAutoRoutingMode(env), 'disabled');
    assert.equal(calls, 0);
    assert.equal(decision.request, request);
    assert.equal(decision.result, null);
    assert.equal(decision.activeApplied, false);
  }
}

function assertShadowDoesNotMutateRequest() {
  let input = null;
  const request = fixtureRequest();
  const decision = applyAutoRoutingShadowWiring(request, {
    env: { LLM_AUTO_ROUTING_ENABLED: 'shadow' },
    routeModel: (value) => {
      input = value;
      return {
        mode: 'shadow',
        autoModel: 'anthropic_opus',
        resolvedModel: 'anthropic_opus',
        modelOverridden: false,
      };
    },
  });
  assert.deepEqual(input, buildAutoRoutingInput(request));
  assert.equal(decision.mode, 'shadow');
  assert.equal(decision.request, request);
  assert.equal(decision.request.abstractModel, 'anthropic_haiku');
  assert.equal(decision.activeApplied, false);
}

function assertActiveOnlyInjectsWhenNoManualModel() {
  const requestWithoutManual = fixtureRequest({ abstractModel: undefined });
  const injected = applyAutoRoutingShadowWiring(requestWithoutManual, {
    env: { LLM_AUTO_ROUTING_ENABLED: 'true' },
    routeModel: () => ({
      mode: 'active',
      autoModel: 'anthropic_sonnet',
      resolvedModel: 'anthropic_sonnet',
      modelOverridden: true,
    }),
  });
  assert.equal(injected.mode, 'active');
  assert.equal(injected.activeApplied, true);
  assert.notEqual(injected.request, requestWithoutManual);
  assert.equal(injected.request.abstractModel, 'anthropic_sonnet');

  const requestWithManual = fixtureRequest({ abstractModel: 'anthropic_haiku' });
  const preserved = applyAutoRoutingShadowWiring(requestWithManual, {
    env: { LLM_AUTO_ROUTING_ENABLED: 'true' },
    routeModel: () => ({
      mode: 'active',
      autoModel: 'anthropic_opus',
      resolvedModel: 'anthropic_opus',
      modelOverridden: true,
    }),
  });
  assert.equal(preserved.request, requestWithManual);
  assert.equal(preserved.request.abstractModel, 'anthropic_haiku');
  assert.equal(preserved.activeApplied, false);
}

async function assertResultUpdateMapping() {
  const decision = {
    mode: 'shadow',
    result: { autoModel: 'anthropic_sonnet' },
    request: fixtureRequest({ callerTeam: 'claude' }),
  };
  const successPayload = mapAutoRoutingResultUpdate(decision, {
    ok: true,
    provider: 'openai-oauth',
    durationMs: 1234,
    totalCostUsd: 0.0042,
  });
  assert.deepEqual(successPayload, {
    agent: 'archer',
    callerTeam: 'claude',
    autoModel: 'anthropic_sonnet',
    selectedProvider: 'openai-oauth',
    latencyMs: 1234,
    costUsd: 0.0042,
    success: true,
    errorCode: null,
  });

  const failurePayload = mapAutoRoutingResultUpdate(decision, {
    ok: false,
    provider: 'failed',
    durationMs: 0,
    error: 'provider_timeout',
  });
  assert.equal(failurePayload.success, false);
  assert.equal(failurePayload.errorCode, 'provider_timeout');

  let captured = null;
  const result = await recordAutoRoutingResult(decision, { ok: true, provider: 'groq', durationMs: 50, costUsd: 0 }, {
    updateRoutingResult: async (payload) => {
      captured = payload;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(captured.selectedProvider, 'groq');
  assert.equal(captured.costUsd, 0);
}

function assertConcurrentMatchSqlShape() {
  const source = fs.readFileSync(
    path.join(PROJECT_ROOT, 'bots/hub/lib/llm/llm-auto-router.ts'),
    'utf8',
  );
  assert.match(source, /agent IS NOT DISTINCT FROM \$7/);
  assert.match(source, /caller_team IS NOT DISTINCT FROM \$8/);
  assert.match(source, /auto_model = \$9/);
  assert.match(source, /success IS NULL/);
  assert.match(source, /ORDER BY created_at DESC/);
  assert.match(source, /LIMIT 1/);
}

export async function runLlmAutoRoutingShadowWiringSmoke() {
  assertDisabledModeDoesNotCallRouteModel();
  assertShadowDoesNotMutateRequest();
  assertActiveOnlyInjectsWhenNoManualModel();
  await assertResultUpdateMapping();
  assertConcurrentMatchSqlShape();
  return {
    ok: true,
    smoke: 'llm-auto-routing-shadow-wiring',
    disabledNoCall: true,
    shadowNoMutation: true,
    activeManualPreserved: true,
    resultUpdateMapped: true,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLlmAutoRoutingShadowWiringSmoke()
    .then((result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log('llm-auto-routing-shadow-wiring-smoke ok');
    })
    .catch((error) => {
      console.error(`llm-auto-routing-shadow-wiring-smoke failed: ${error?.message || error}`);
      process.exit(1);
    });
}
