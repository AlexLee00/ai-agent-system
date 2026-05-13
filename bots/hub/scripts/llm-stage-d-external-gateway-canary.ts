#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { resolveHubLlmSelection } = require('../src/llm-selector');

const CONFIRM = 'hub-stage-d-external-gateway-canary';

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name) {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

async function main() {
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm');
  const baseUrl = argValue('--base-url') || process.env.HUB_BASE_URL || 'http://127.0.0.1:7788';
  const token = process.env.HUB_AUTH_TOKEN || '';
  const selector = resolveHubLlmSelection({
    callerTeam: 'justin-court-appraisal',
    agent: 'justin',
    selectorKey: 'justin.stage-3',
    taskType: 'external_gateway_canary',
    requestId: 'hub-stage-d-external-gateway-canary',
    maxBudgetUsd: 0.05,
  });

  const result = {
    ok: Boolean(selector.ok),
    checkedAt: new Date().toISOString(),
    stage: 'hub_stage_d',
    task: 'D7_external_llm_gateway',
    dryRun: !apply,
    project: 'justin-court-appraisal',
    selector,
    baseUrl,
    liveCall: null,
    applyGate: `--apply --confirm=${CONFIRM}`,
  };

  assert.equal(selector.ok, true, `selector route must resolve: ${selector.error || 'unknown'}`);
  assert.equal(selector.selectorKey, 'justin.stage-3');
  assert(Array.isArray(selector.providerTiers) && selector.providerTiers.length > 0, 'provider tiers required');

  if (!apply) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (confirm !== CONFIRM) {
    result.ok = false;
    result.error = 'confirm_required';
    result.requiredConfirm = CONFIRM;
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }
  if (!token) {
    result.ok = false;
    result.error = 'hub_auth_token_missing';
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const response = await fetch(`${baseUrl}/hub/llm/call`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Hub-Team': 'justin-court-appraisal',
      'X-Hub-Agent': 'justin',
    },
    body: JSON.stringify({
      callerTeam: 'justin-court-appraisal',
      agent: 'justin',
      selectorKey: 'justin.stage-3',
      taskType: 'external_gateway_canary',
      prompt: 'Stage D external gateway canary. Reply with one Korean sentence saying the gateway path works.',
      maxBudgetUsd: 0.05,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await response.text();
  result.liveCall = {
    ok: response.ok,
    status: response.status,
    bodyPreview: bodyText.slice(0, 500),
  };
  result.ok = response.ok;
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
