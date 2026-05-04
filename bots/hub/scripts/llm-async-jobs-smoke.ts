#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-jobs-smoke-'));
const limiterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-llm-jobs-limiter-smoke-'));

process.env.HUB_AUTH_TOKEN = 'hub-llm-jobs-smoke-token';
process.env.HUB_LLM_JOB_DIR = jobDir;
process.env.HUB_LLM_JOB_STORE_BACKEND = 'file';
process.env.HUB_LLM_JOB_SMOKE_MOCK = '1';
process.env.HUB_LLM_SHARED_LIMITER_DIR = limiterDir;
process.env.HUB_LLM_SHARED_LIMITER_BACKEND = 'file';
process.env.HUB_LLM_SHARED_LIMITER_ENABLED = 'true';
process.env.HUB_LLM_SHARED_MAX_IN_FLIGHT = '2';
process.env.HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT = '2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function requestJson(baseUrl, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

async function main() {
  const { resetJobStoreForTests } = require('../lib/llm/job-store.ts');
  const { resetSharedLimiterForTests } = require('../lib/llm/shared-limiter.ts');
  await resetJobStoreForTests();
  resetSharedLimiterForTests();

  const { createHubApp } = require('../src/app.ts');
  const app = createHubApp({
    isShuttingDown: () => false,
    isStartupComplete: () => true,
  });

  await withServer(app, async (baseUrl) => {
    const created = await requestJson(baseUrl, 'POST', '/hub/llm/jobs', {
      prompt: 'job smoke',
      callerTeam: 'luna',
      agent: 'default',
      abstractModel: 'anthropic_sonnet',
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.ok, true);
    assert.match(created.body.jobId, /^llm_job_/);

    let status = null;
    for (let index = 0; index < 20; index += 1) {
      status = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${created.body.jobId}`);
      if (status.body?.job?.status === 'completed') break;
      await sleep(50);
    }
    assert.equal(status.status, 200);
    assert.equal(status.body.job.status, 'completed');
    assert.equal(status.body.job.payload, undefined, 'job status must not expose full prompt payload');

    const result = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${created.body.jobId}/result`);
    assert.equal(result.status, 200);
    assert.equal(result.body.result.ok, true);
    assert.equal(result.body.result.provider, 'mock');

    const list = await requestJson(baseUrl, 'GET', '/hub/llm/jobs?limit=5');
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert(list.body.jobs.some((job) => job.id === created.body.jobId), 'job list must include created job');
  });

  console.log(JSON.stringify({
    ok: true,
    async_jobs: true,
    store: jobDir,
  }));
}

main().finally(() => {
  fs.rmSync(jobDir, { recursive: true, force: true });
  fs.rmSync(limiterDir, { recursive: true, force: true });
}).catch((error) => {
  console.error('[llm-async-jobs-smoke] failed:', error?.message || error);
  process.exitCode = 1;
});
