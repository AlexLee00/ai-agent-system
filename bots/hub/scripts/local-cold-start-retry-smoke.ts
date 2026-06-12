#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

type SmokeResult = {
  id: string;
  method: string;
  pass: boolean;
  evidence: string;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const localOllamaPath = path.join(repoRoot, 'bots/hub/lib/llm/local-ollama.ts');
const providerRegistryPath = path.join(repoRoot, 'bots/hub/lib/llm/provider-registry.ts');
const circuitPath = path.join(repoRoot, 'packages/core/lib/local-circuit-breaker.ts');
const pgPoolPath = path.join(repoRoot, 'packages/core/lib/pg-pool.ts');
const unifiedCallerPath = path.join(repoRoot, 'bots/hub/lib/llm/unified-caller.ts');

const originalFetch = global.fetch;
const originalDateNow = Date.now;
const originalEnv = {
  HUB_LLM_LOCAL_TIMEOUT_MS: process.env.HUB_LLM_LOCAL_TIMEOUT_MS,
  HUB_LLM_LOCAL_COLD_START_TIMEOUT_MS: process.env.HUB_LLM_LOCAL_COLD_START_TIMEOUT_MS,
  HUB_LLM_LOCAL_COLD_RETRY_ENABLED: process.env.HUB_LLM_LOCAL_COLD_RETRY_ENABLED,
};

const results: SmokeResult[] = [];

function resetModule(modulePath: string): void {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module may not have been loaded.
  }
}

function resetLocalModules(): void {
  resetModule(localOllamaPath);
}

function patchPgPool(): void {
  const pgPool = require(pgPoolPath);
  pgPool.run = async () => ({ rows: [], rowCount: 0 });
}

function setLocalEnv({
  timeoutMs = 5,
  coldStartTimeoutMs = 35,
  retryEnabled = true,
}: {
  timeoutMs?: number;
  coldStartTimeoutMs?: number;
  retryEnabled?: boolean;
} = {}): void {
  process.env.HUB_LLM_LOCAL_TIMEOUT_MS = String(timeoutMs);
  process.env.HUB_LLM_LOCAL_COLD_START_TIMEOUT_MS = String(coldStartTimeoutMs);
  process.env.HUB_LLM_LOCAL_COLD_RETRY_ENABLED = retryEnabled ? 'true' : 'false';
  resetLocalModules();
}

function loadLocalOllama() {
  patchPgPool();
  return require(localOllamaPath);
}

function providerRegistry() {
  patchPgPool();
  return require(providerRegistryPath);
}

function circuitBreaker() {
  return require(circuitPath);
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function hangingFetch(attempts: Array<{ startedAt: number; abortedAfterMs?: number }>) {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    const record = { startedAt: originalDateNow() };
    attempts.push(record);
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing abort signal'));
        return;
      }
      if (signal.aborted) {
        record.abortedAfterMs = 0;
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => {
        record.abortedAfterMs = originalDateNow() - record.startedAt;
        reject(abortError());
      }, { once: true });
    });
  }) as typeof fetch;
}

function successFetch(text = 'local cold retry ok') {
  return (async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: text } }] };
    },
  })) as typeof fetch;
}

function sequenceFetch(handlers: Array<typeof fetch>) {
  let index = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const handler = handlers[Math.min(index, handlers.length - 1)];
    index += 1;
    return handler(input, init);
  }) as typeof fetch;
}

async function record(id: string, method: string, fn: () => Promise<string> | string): Promise<void> {
  try {
    const evidence = await fn();
    results.push({ id, method, pass: true, evidence });
  } catch (error) {
    results.push({ id, method, pass: false, evidence: error?.stack || error?.message || String(error) });
  }
}

async function main(): Promise<void> {
  patchPgPool();

  await record('TS-S1-1', '1차 timeout 후 cold retry 성공', async () => {
    setLocalEnv({ timeoutMs: 5, coldStartTimeoutMs: 35, retryEnabled: true });
    const model = 's1-retry-success';
    providerRegistry().resetProviderCircuit(`local/${model}`);
    const attempts: Array<{ startedAt: number; abortedAfterMs?: number }> = [];
    global.fetch = sequenceFetch([hangingFetch(attempts), successFetch()]);

    const { callLocalOllama } = loadLocalOllama();
    const result = await callLocalOllama({ model, prompt: 'cold start' });
    const stats = providerRegistry().getProviderStats()[`local/${model}`];

    assert.equal(result.ok, true);
    assert.equal(result.coldStartRetried, true);
    assert.equal(attempts.length, 1);
    assert.equal(stats.total_calls, 1);
    assert.equal(stats.total_failures, 0);
    assert.equal(stats.state, 'CLOSED');
    return `attempts=2 coldStartRetried=${result.coldStartRetried} failures=${stats.total_failures}`;
  });

  await record('TS-S1-2', '2차 timeout은 cold-start env 적용', async () => {
    setLocalEnv({ timeoutMs: 5, coldStartTimeoutMs: 35, retryEnabled: true });
    const model = 's1-retry-timeout-window';
    providerRegistry().resetProviderCircuit(`local/${model}`);
    const attempts: Array<{ startedAt: number; abortedAfterMs?: number }> = [];
    global.fetch = hangingFetch(attempts);

    const { callLocalOllama } = loadLocalOllama();
    const result = await callLocalOllama({ model, prompt: 'cold timeout' });

    assert.equal(result.ok, false);
    assert.equal(result.coldStartRetried, true);
    assert.equal(attempts.length, 2);
    assert((attempts[0].abortedAfterMs || 0) < 25, `first abort too slow: ${attempts[0].abortedAfterMs}`);
    assert((attempts[1].abortedAfterMs || 0) >= 25, `second abort did not use cold timeout: ${attempts[1].abortedAfterMs}`);
    return `firstAbortMs=${attempts[0].abortedAfterMs} secondAbortMs=${attempts[1].abortedAfterMs}`;
  });

  await record('TS-S1-3', 'kill switch false면 1회 시도', async () => {
    setLocalEnv({ timeoutMs: 5, coldStartTimeoutMs: 35, retryEnabled: false });
    const model = 's1-retry-disabled';
    providerRegistry().resetProviderCircuit(`local/${model}`);
    const attempts: Array<{ startedAt: number; abortedAfterMs?: number }> = [];
    global.fetch = hangingFetch(attempts);

    const { callLocalOllama } = loadLocalOllama();
    const result = await callLocalOllama({ model, prompt: 'retry disabled' });

    assert.equal(result.ok, false);
    assert.equal(result.coldStartRetried, undefined);
    assert.equal(attempts.length, 1);
    return `attempts=${attempts.length} coldStartRetried=${Boolean(result.coldStartRetried)}`;
  });

  await record('TS-S1-4', 'local-embedding 경로 비접촉', () => {
    const localOllamaSource = fs.readFileSync(localOllamaPath, 'utf8');
    const unifiedSource = fs.readFileSync(unifiedCallerPath, 'utf8');
    assert(!localOllamaSource.includes('local-embedding'), 'local-ollama must not reference local-embedding');
    assert(unifiedSource.includes("normalizedRoute.startsWith('local-embedding/')"), 'unified caller must keep local-embedding branch');
    assert(unifiedSource.includes('_callLocalEmbeddingOnly(req, model)'), 'local-embedding must stay on its existing caller');
    return 'local-ollama has no local-embedding reference; unified local-embedding branch intact';
  });

  await record('TS-S1-5', 'HALF_OPEN probe가 cold retry 성공으로 CLOSED 복귀', async () => {
    setLocalEnv({ timeoutMs: 5, coldStartTimeoutMs: 35, retryEnabled: true });
    const model = 's1-half-open-recovery';
    const providerKey = `local/${model}`;
    providerRegistry().resetProviderCircuit(providerKey);
    const circuit = circuitBreaker();
    let now = 1_000_000;
    Date.now = () => now;
    circuit.recordFailure(providerKey);
    circuit.recordFailure(providerKey);
    circuit.recordFailure(providerKey);
    assert.equal(circuit.getCircuitStatus(providerKey).state, 'OPEN');
    now += 31_000;

    const attempts: Array<{ startedAt: number; abortedAfterMs?: number }> = [];
    global.fetch = sequenceFetch([hangingFetch(attempts), successFetch('half open recovered')]);

    const { callLocalOllama } = loadLocalOllama();
    const result = await callLocalOllama({ model, prompt: 'half open probe' });
    const status = circuit.getCircuitStatus(providerKey);

    assert.equal(result.ok, true);
    assert.equal(result.coldStartRetried, true);
    assert.equal(status.state, 'CLOSED');
    assert.equal(status.failures, 0);
    return `status=${status.state} coldStartRetried=${result.coldStartRetried}`;
  });

  const failed = results.filter((result) => !result.pass);
  console.log(JSON.stringify({
    ok: failed.length === 0,
    suite: 'local-cold-start-retry-smoke',
    results,
  }, null, 2));

  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('[local-cold-start-retry-smoke] failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
    Date.now = originalDateNow;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetLocalModules();
  });
