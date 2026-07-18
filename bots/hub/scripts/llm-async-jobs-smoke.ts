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

async function requestJson(baseUrl, method, route, body, callerTeam = null) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.HUB_AUTH_TOKEN}`,
      ...(callerTeam ? { 'X-Hub-Team': callerTeam } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

async function main() {
  const {
    listOwnedLlmJobs,
    readJobForWorker: readRawJob,
    readOwnedLlmJob,
    resetJobStoreForTests,
  } = require('../lib/llm/job-store.ts');
  const { resetSharedLimiterForTests } = require('../lib/llm/shared-limiter.ts');
  await resetJobStoreForTests();
  resetSharedLimiterForTests();
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, 'collision_id.json'), JSON.stringify({ id: 'different-id' }));
  assert.equal(await readRawJob('collision/id'), null, 'sanitized filename collision must not return a different job');

  const { createHubApp } = require('../src/app.ts');
  const app = createHubApp({
    isShuttingDown: () => false,
    isStartupComplete: () => true,
  });

  await withServer(app, async (baseUrl) => {
    const missingCreateTeam = await requestJson(baseUrl, 'POST', '/hub/llm/jobs', {
      prompt: 'missing create team smoke',
      agent: 'synthesis',
      selectorKey: 'darwin.agent_policy',
      abstractModel: 'anthropic_sonnet',
    });
    assert.equal(missingCreateTeam.status, 400, 'direct job creation requires an explicit caller team');

    const created = await requestJson(baseUrl, 'POST', '/hub/llm/jobs', {
      prompt: 'job smoke',
      callerTeam: 'luna',
      agent: 'default',
      abstractModel: 'anthropic_sonnet',
      authPrincipalId: 'body-spoof-must-be-ignored',
    });
    assert.equal(created.status, 202);
    assert.equal(created.body.ok, true);
    assert.match(created.body.jobId, /^llm_job_/);
    const stored = await readRawJob(created.body.jobId);
    assert.equal(stored.ownerTeam, 'investment');
    assert.equal(stored.ownerPrincipalId, 'legacy-root');
    assert.equal(stored.payload.authPrincipalId, 'legacy-root', 'body principal must be replaced by auth context');
    assert.equal((await readOwnedLlmJob(created.body.jobId, {
      callerTeam: 'investment',
      authPrincipalId: 'legacy-root',
    })).id, created.body.jobId);
    assert.equal(await readOwnedLlmJob(created.body.jobId, {
      callerTeam: 'darwin',
      authPrincipalId: 'legacy-root',
    }), null);
    await assert.rejects(
      () => listOwnedLlmJobs(5, null),
      /llm_job_owner_required/,
      'owned list API must fail closed when owner is omitted',
    );

    let status = null;
    for (let index = 0; index < 20; index += 1) {
      status = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${created.body.jobId}`, null, 'luna');
      if (status.body?.job?.status === 'completed') break;
      await sleep(50);
    }
    assert.equal(status.status, 200);
    assert.equal(status.body.job.status, 'completed');
    assert.equal(status.body.job.payload, undefined, 'job status must not expose full prompt payload');
    assert.equal(status.body.job.ownerPrincipalId, undefined, 'job status must not expose auth principal metadata');

    const result = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${created.body.jobId}/result`, null, 'luna');
    assert.equal(result.status, 200);
    assert.equal(result.body.result.ok, true);
    assert.equal(result.body.result.provider, 'mock');

    const aliasStatus = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${created.body.jobId}`, null, 'investment');
    assert.equal(aliasStatus.status, 200, 'luna and investment must share canonical job ownership');

    const mismatchedCreate = await requestJson(baseUrl, 'POST', '/hub/llm/jobs', {
      prompt: 'mismatched owner smoke',
      callerTeam: 'darwin',
      agent: 'synthesis',
      selectorKey: 'darwin.agent_policy',
      abstractModel: 'anthropic_sonnet',
    }, 'luna');
    assert.equal(mismatchedCreate.status, 400, 'job create must reject conflicting body and header teams');

    const other = await requestJson(baseUrl, 'POST', '/hub/llm/jobs', {
      prompt: 'other team job smoke',
      callerTeam: 'darwin',
      agent: 'synthesis',
      selectorKey: 'darwin.agent_policy',
      abstractModel: 'anthropic_sonnet',
    });
    assert.equal(other.status, 202);

    const list = await requestJson(baseUrl, 'GET', '/hub/llm/jobs?limit=5', null, 'luna');
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert(list.body.jobs.some((job) => job.id === created.body.jobId), 'job list must include created job');
    assert(!list.body.jobs.some((job) => job.id === other.body.jobId), 'job list must exclude another team job');

    const crossTeamStatus = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${other.body.jobId}`, null, 'luna');
    assert.equal(crossTeamStatus.status, 404, 'cross-team job status must not be disclosed');
    const crossTeamResult = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${other.body.jobId}/result`, null, 'luna');
    assert.equal(crossTeamResult.status, 404, 'cross-team job result must not be disclosed');

    const missingTeamList = await requestJson(baseUrl, 'GET', '/hub/llm/jobs?limit=5');
    assert.equal(missingTeamList.status, 400, 'job list requires caller team ownership context');
    const missingTeamStatus = await requestJson(baseUrl, 'GET', `/hub/llm/jobs/${created.body.jobId}`);
    assert.equal(missingTeamStatus.status, 400, 'job status requires caller team ownership context');
  });

  const { createLlmJob, processJob, readJobForWorker } = require('../lib/llm/job-store.ts');
  const overflowLike = await createLlmJob({
    prompt: 'selector-owned admission overflow smoke',
    agent: 'synthesis',
    selectorKey: 'darwin.agent_policy',
    abstractModel: 'anthropic_sonnet',
  }, {
    authPrincipalId: 'legacy-root',
  }, { start: false, source: 'admission_overflow' });
  assert.equal(overflowLike.ownerTeam, 'darwin', 'selector target must provide an owner for admission overflow');
  let overflowRequest = null;
  await processJob(overflowLike.id, {
    callWithFallback: async (request) => {
      overflowRequest = request;
      return { ok: true, provider: 'mock', result: 'overflow processed' };
    },
  });
  assert.equal(overflowRequest.callerTeam, 'darwin', 'overflow worker must preserve selector-derived owner team');
  const scoped = await createLlmJob({
    prompt: 'scoped owner smoke',
    callerTeam: 'luna',
    agent: 'default',
    abstractModel: 'anthropic_sonnet',
    authPrincipalId: 'body-spoof-must-be-ignored',
  }, {
    callerTeam: 'investment',
    authPrincipalId: 'investment-worker',
  }, { start: false });
  assert.equal(scoped.ownerTeam, 'investment');
  assert.equal(scoped.ownerPrincipalId, 'investment-worker');
  assert.equal(scoped.payload.authPrincipalId, 'investment-worker');
  assert.equal(await readOwnedLlmJob(scoped.id, {
    callerTeam: 'investment',
    authPrincipalId: 'other-worker',
  }), null, 'scoped job must reject a different principal');
  assert.equal((await readOwnedLlmJob(scoped.id, {
    callerTeam: 'luna',
    authPrincipalId: 'investment-worker',
  })).id, scoped.id);
  const deferred = await createLlmJob({
    prompt: 'job admission backpressure',
    callerTeam: 'luna',
    agent: 'default',
    abstractModel: 'anthropic_sonnet',
  }, {}, { start: false });
  const scheduled = [];
  await processJob(deferred.id, {
    callWithFallback: async () => ({
      ok: false,
      provider: 'failed',
      error: 'shared_limiter_full:provider:openai-oauth',
      limiterBackpressure: true,
      retryAfterMs: 1_250,
      admissionScope: 'provider:openai-oauth',
      providerAttempted: false,
    }),
    scheduleJob: (jobId, retryAfterMs) => scheduled.push({ jobId, retryAfterMs }),
  });
  const deferredState = await readJobForWorker(deferred.id);
  assert.equal(deferredState.status, 'queued');
  assert.equal(deferredState.retryAfterMs, 1_250);
  assert.deepEqual(deferredState.limiter, {
    error: 'shared_limiter_full:provider:openai-oauth',
    admissionScope: 'provider:openai-oauth',
  });
  assert.deepEqual(scheduled, [{ jobId: deferred.id, retryAfterMs: 1_250 }]);

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
