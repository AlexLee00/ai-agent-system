#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const localClientPath = path.join(repoRoot, 'packages/core/lib/local-llm-client.ts');
const envPath = path.join(repoRoot, 'packages/core/lib/env.ts');

const originalFetch = global.fetch;
const originalEnv = {
  LOCAL_LLM_BASE_URL: process.env.LOCAL_LLM_BASE_URL,
  EMBED_URL: process.env.EMBED_URL,
  MODE: process.env.MODE,
};

function resetModule(modulePath: string): void {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module may not have been loaded yet.
  }
}

async function main() {
  process.env.MODE = 'ops';
  process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
  delete process.env.EMBED_URL;

  const requestedUrls: string[] = [];
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: [
            { id: 'qwen2.5-7b' },
            { id: 'deepseek-r1-32b' },
            { id: 'qwen3-embed-0.6b' },
          ],
        };
      },
    } as Response;
  }) as typeof fetch;

  try {
    resetModule(localClientPath);
    resetModule(envPath);
    const localLLMClient = require(localClientPath);
    const health = await localLLMClient.checkLocalLLMHealth({ embeddingsOnly: true });

    assert.equal(health.available, true);
    assert.equal(health.embedModelOk, true);
    assert.equal(health.error, undefined);
    assert.ok(
      requestedUrls.some((url) => url === 'http://127.0.0.1:11434/v1/models'),
      `embeddings-only health must use LOCAL_LLM_BASE_URL; requested=${requestedUrls.join(',')}`,
    );

    console.log(JSON.stringify({
      ok: true,
      embeddings_only_uses_local_llm_base_url: true,
      embed_model_detected: true,
    }));
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    resetModule(localClientPath);
    resetModule(envPath);
  }
}

main().catch((error) => {
  console.error('[local-embedding-health-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
