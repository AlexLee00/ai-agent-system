#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { parseLlmCallPayload } = require('../lib/llm/request-schema');
const { resolveHubLlmSelection } = require('../src/llm-selector');

const CONFIRM = 'hub-stage-d-external-gateway-canary';

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : null;
}

function buildCanaryRequest() {
  return {
    callerTeam: 'justin-court-appraisal',
    agent: 'justin',
    selectorKey: 'justin.stage-3',
    abstractModel: 'anthropic_haiku',
    runtimePurpose: 'external_gateway_canary',
    taskType: 'external_gateway_canary',
    requestId: 'hub-stage-d-external-gateway-canary',
    prompt: 'Stage D external gateway canary. Reply with one Korean sentence saying the gateway path works.',
    timeoutMs: 25_000,
    maxBudgetUsd: 0.05,
    temperature: 0,
  };
}

function evaluateCanaryResponse(status: number, bodyText: string) {
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(bodyText || '{}');
  } catch {
    payload = {};
  }
  const httpOk = status >= 200 && status < 300;
  const ok = httpOk && payload.ok === true;
  return {
    ok,
    status,
    bodyPreview: String(bodyText || '').slice(0, 500),
    traceId: payload.traceId || null,
    provider: payload.provider || null,
    selectedRoute: payload.selected_route || payload.selectedRoute || null,
    error: ok ? null : (payload.error || (httpOk ? 'hub_response_not_ok' : `http_${status}`)),
  };
}

async function main() {
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm');
  const baseUrl = argValue('--base-url') || process.env.HUB_BASE_URL || 'http://127.0.0.1:7788';
  const token = process.env.HUB_AUTH_TOKEN || '';
  const canaryRequest = buildCanaryRequest();
  const requestContract = parseLlmCallPayload(canaryRequest);
  const selector = resolveHubLlmSelection(canaryRequest);

  const result: {
    ok: boolean;
    checkedAt: string;
    stage: string;
    task: string;
    dryRun: boolean;
    project: string;
    selector: any;
    requestContract: { ok: boolean; requestId: string; abstractModel: string; timeoutMs: number };
    baseUrl: string;
    liveCall: null | ReturnType<typeof evaluateCanaryResponse>;
    applyGate: string;
    error?: string;
    requiredConfirm?: string;
  } = {
    ok: Boolean(selector.ok),
    checkedAt: new Date().toISOString(),
    stage: 'hub_stage_d',
    task: 'D7_external_llm_gateway',
    dryRun: !apply,
    project: 'justin-court-appraisal',
    selector,
    requestContract: {
      ok: requestContract.ok,
      requestId: canaryRequest.requestId,
      abstractModel: canaryRequest.abstractModel,
      timeoutMs: canaryRequest.timeoutMs,
    },
    baseUrl,
    liveCall: null,
    applyGate: `--apply --confirm=${CONFIRM}`,
  };

  assert.equal(selector.ok, true, `selector route must resolve: ${selector.error || 'unknown'}`);
  assert.equal(selector.selectorKey, 'justin.stage-3');
  assert(Array.isArray(selector.providerTiers) && selector.providerTiers.length > 0, 'provider tiers required');
  assert.equal(requestContract.ok, true, 'canary request must satisfy /hub/llm/call schema');

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
    body: JSON.stringify(canaryRequest),
    signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await response.text();
  result.liveCall = evaluateCanaryResponse(response.status, bodyText);
  result.ok = result.liveCall.ok;
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

module.exports = { buildCanaryRequest, evaluateCanaryResponse };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
