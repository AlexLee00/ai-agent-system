#!/usr/bin/env tsx
// @ts-nocheck

'use strict';

const env = require('../../../packages/core/lib/env');

const SCENARIOS = [
  {
    name: 'digest',
    selectorKey: 'orchestrator.steward.digest',
    model: 'gemini-cli-oauth/gemini-2.5-flash-lite',
    maxTokens: 96,
    temperature: 0.1,
    timeoutMs: 25_000,
    prompt: '스튜어드 digest 모델 점검입니다. 한국어로 "digest ok"만 답하세요.',
  },
  {
    name: 'work',
    selectorKey: 'orchestrator.steward.work',
    model: 'gemini-cli-oauth/gemini-2.5-flash',
    fallbackModels: ['gemini-cli-oauth/gemini-2.5-flash-lite'],
    maxTokens: 96,
    temperature: 0.2,
    timeoutMs: 35_000,
    prompt: '스튜어드 work 모델 점검입니다. 한국어로 "work ok"만 답하세요.',
  },
  {
    name: 'incident_plan',
    selectorKey: 'orchestrator.steward.incident_plan',
    model: 'gemini-cli-oauth/gemini-2.5-flash',
    fallbackModels: ['gemini-cli-oauth/gemini-2.5-flash-lite'],
    maxTokens: 128,
    temperature: 0.2,
    timeoutMs: 45_000,
    prompt: '스튜어드 incident 모델 점검입니다. 한국어로 "incident ok"만 답하세요.',
    required: true,
  },
  {
    name: 'pro_canary',
    selectorKey: 'orchestrator.steward.pro_canary',
    provider: 'gemini-cli-oauth',
    model: 'gemini-cli-oauth/gemini-2.5-pro',
    maxTokens: 64,
    temperature: 0.2,
    timeoutMs: 60_000,
    prompt: '스튜어드 pro canary 점검입니다. 한국어로 "pro ok"만 답하세요.',
    required: false,
  },
];

function flag(name) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function hubBaseUrl() {
  return String(process.env.HUB_BASE_URL || env.HUB_BASE_URL || 'http://127.0.0.1:7788').replace(/\/+$/, '');
}

function hubAuthToken() {
  return String(process.env.HUB_AUTH_TOKEN || env.HUB_AUTH_TOKEN || '').trim();
}

async function resetGeminiCircuit(baseUrl, token) {
  for (const provider of ['gemini-oauth', 'gemini-cli-oauth', 'gemini-codeassist-oauth']) {
    try {
      await fetch(`${baseUrl}/hub/llm/circuit?provider=${encodeURIComponent(provider)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Circuit reset is a best-effort prep step; the call result below is authoritative.
    }
  }
}

function scenarioProvider(scenario) {
  return String(scenario.provider || modelProvider(scenario.model));
}

function modelProvider(model) {
  const value = String(model || '');
  if (value.startsWith('gemini-codeassist-oauth/')) return 'gemini-codeassist-oauth';
  if (value.startsWith('gemini-cli-oauth/')) return 'gemini-cli-oauth';
  return 'gemini-oauth';
}

function scenarioChain(scenario) {
  const models = [scenario.model, ...(Array.isArray(scenario.fallbackModels) ? scenario.fallbackModels : [])];
  return models.map((model, index) => ({
    provider: index === 0 ? scenarioProvider(scenario) : modelProvider(model),
    model,
    maxTokens: scenario.maxTokens,
    temperature: scenario.temperature,
    timeoutMs: index === 0 ? scenario.timeoutMs : Math.min(scenario.timeoutMs, 20_000),
  }));
}

async function callScenario(scenario, baseUrl, token) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}/hub/llm/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Hub-Team': 'orchestrator',
        'X-Hub-Agent': 'steward',
        'X-Hub-Priority': 'low',
      },
      body: JSON.stringify({
        callerTeam: 'orchestrator',
        agent: 'steward',
        selectorKey: scenario.selectorKey,
        abstractModel: 'anthropic_haiku',
        taskType: 'steward_gemini_model_drill',
        urgency: 'low',
        systemPrompt: '너는 운영 스튜어드 모델 점검 응답기입니다. 비밀값을 출력하지 말고 요청한 짧은 확인 문구만 답하세요.',
        prompt: scenario.prompt,
        chain: scenarioChain(scenario),
        timeoutMs: scenario.timeoutMs,
        maxBudgetUsd: 0.03,
        cacheEnabled: false,
      }),
      signal: AbortSignal.timeout(scenario.timeoutMs + 5000),
    });
    const payload = await response.json().catch(() => ({}));
    const wallMs = Date.now() - started;
    return {
      name: scenario.name,
      selectorKey: scenario.selectorKey,
      model: scenario.model,
      ok: response.ok && payload?.ok !== false && String(payload?.provider || '') === scenarioProvider(scenario),
      status: response.status,
      provider: payload?.provider || null,
      selectedRoute: payload?.selected_route || payload?.model || null,
      hubDurationMs: Number(payload?.durationMs || 0),
      wallMs,
      fallbackCount: Number(payload?.fallbackCount || 0),
      attemptedProviders: payload?.attempted_providers || [],
      traceIdPresent: Boolean(payload?.traceId),
      responsePreview: String(payload?.result || payload?.text || '').slice(0, 80),
      error: payload?.error || null,
    };
  } catch (error) {
    return {
      name: scenario.name,
      selectorKey: scenario.selectorKey,
      model: scenario.model,
      ok: false,
      status: null,
      provider: null,
      selectedRoute: null,
      hubDurationMs: 0,
      wallMs: Date.now() - started,
      fallbackCount: 0,
      attemptedProviders: [],
      traceIdPresent: false,
      responsePreview: '',
      error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error),
    };
  }
}

function render(report) {
  console.log(`steward gemini model drill: ${report.ok ? 'ok' : 'failed'} (${report.baseUrl})`);
  for (const item of report.results) {
    const mark = item.ok ? 'OK' : 'FAIL';
    console.log(`${mark} ${item.name} ${item.model} wall=${item.wallMs}ms hub=${item.hubDurationMs}ms route=${item.selectedRoute || '-'}${item.error ? ` error=${item.error}` : ''}`);
  }
}

async function main() {
  const baseUrl = hubBaseUrl();
  const token = hubAuthToken();
  if (!token || token.length < 12) {
    throw new Error('HUB_AUTH_TOKEN is required for steward Gemini model drill');
  }
  await resetGeminiCircuit(baseUrl, token);
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await callScenario(scenario, baseUrl, token));
  }
  const requiredResults = results.filter((item) => SCENARIOS.find((scenario) => scenario.name === item.name)?.required !== false);
  const report = {
    ok: requiredResults.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    baseUrl,
    results,
  };
  if (flag('STEWARD_GEMINI_DRILL_JSON') || process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    render(report);
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((error) => {
  console.error('[steward-gemini-model-drill] failed:', error?.message || error);
  process.exit(1);
});
