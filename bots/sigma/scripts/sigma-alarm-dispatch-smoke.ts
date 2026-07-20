import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-alarm-dispatch-'));
const originalFetch = global.fetch;
const envPatch: Record<string, string | undefined> = {
  HUB_ALARM_RECENT_ALERTS_PATH: path.join(tempWorkspace, 'recent-alerts.json'),
  HUB_ALARM_SKIP_DIRECT: 'false',
  HUB_ALARM_WARN_THROTTLE_MS: '1',
  HUB_AUTH_TOKEN: 'sigma-alarm-dispatch-smoke-token',
  HUB_BASE_URL: 'http://127.0.0.1:7788',
  SIGMA_ALARM_MAX_RETRY_DELAY_MS: '20',
  USE_HUB_SECRETS: 'false',
};
const previousEnv: Record<string, string | undefined> = {};

function applyEnv(): void {
  for (const [key, value] of Object.entries(envPatch)) {
    previousEnv[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreEnv(): void {
  for (const key of Object.keys(envPatch)) {
    const previous = previousEnv[key];
    if (previous == null) delete process.env[key];
    else process.env[key] = previous;
  }
}

async function main(): Promise<void> {
  applyEnv();
  const { postSigmaAlarmWithRetry, summarizeAlarmResult } = await import('./sigma-alarm-dispatch.js');

  let calls = 0;
  global.fetch = async (url: URL | RequestInfo, init: RequestInit = {}) => {
    const normalizedUrl = String(url);
    assert(normalizedUrl.endsWith('/hub/alarm'), `unexpected fetch url: ${normalizedUrl}`);
    assert.equal(String(init.method || 'GET'), 'POST');
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          error: 'rate limit exceeded (200/min)',
          retryAfterMs: 5,
        }),
        {
          status: 429,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        delivered: true,
        event_id: 901,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  const recovered = await postSigmaAlarmWithRetry({
    message: 'sigma alarm dispatch rate-limit smoke',
    team: 'sigma',
    fromBot: 'sigma-alarm-dispatch-smoke',
    payload: { event_type: 'sigma_alarm_dispatch_rate_limit_smoke' },
  }, { attempts: 2, retryDelayMs: 1, maxRetryDelayMs: 20 });
  assert.equal(calls, 2, 'rate-limited hub alarm should be retried once');
  assert.equal(recovered.attempts, 2, 'attempt count should reflect the successful retry');
  assert.equal((recovered.result as { ok?: boolean }).ok, true, 'retry should recover after rate limit');

  calls = 0;
  global.fetch = async (url: URL | RequestInfo, init: RequestInit = {}) => {
    const normalizedUrl = String(url);
    assert(normalizedUrl.endsWith('/hub/alarm'), `unexpected fetch url: ${normalizedUrl}`);
    assert.equal(String(init.method || 'GET'), 'POST');
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ error: 'hub temporarily unavailable' }),
        {
          status: 500,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return new Response(
      JSON.stringify({
        ok: true,
        delivered: true,
        event_id: 902,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  const recoveredAfterServerError = await postSigmaAlarmWithRetry({
    message: 'sigma alarm dispatch server-error smoke',
    team: 'sigma',
    fromBot: 'sigma-alarm-dispatch-smoke',
    payload: { event_type: 'sigma_alarm_dispatch_server_error_smoke' },
  }, { attempts: 2, retryDelayMs: 1, maxRetryDelayMs: 20 });
  assert.equal(calls, 2, 'Hub 5xx alarm failure should be retried once');
  assert.equal(recoveredAfterServerError.attempts, 2, 'attempt count should reflect 5xx retry');
  assert.equal((recoveredAfterServerError.result as { ok?: boolean }).ok, true, 'retry should recover after Hub 5xx');

  calls = 0;
  global.fetch = async (url) => {
    const normalizedUrl = String(url);
    assert(normalizedUrl.endsWith('/hub/alarm'), `unexpected fetch url: ${normalizedUrl}`);
    calls += 1;
    return new Response(
      JSON.stringify({ error: 'validation failed' }),
      {
        status: 400,
        headers: { 'content-type': 'application/json' },
      },
    );
  };

  const nonRetryable = await postSigmaAlarmWithRetry({
    message: 'sigma alarm dispatch nonretryable smoke',
    team: 'sigma',
    fromBot: 'sigma-alarm-dispatch-smoke',
    payload: { event_type: 'sigma_alarm_dispatch_nonretryable_smoke' },
  }, { attempts: 3, retryDelayMs: 1, maxRetryDelayMs: 20 });
  assert.equal(calls, 1, 'nonretryable hub alarm failure should not be retried');
  assert.equal(nonRetryable.attempts, 1, 'failed nonretryable path should report actual attempts');
  assert.deepEqual(summarizeAlarmResult(nonRetryable.result), {
    ok: false,
    status: 400,
    source: 'hub_alarm',
    delivered: undefined,
    suppressed: undefined,
    error: 'validation failed',
    fallback: 'disabled',
    retryable: undefined,
    retryAfterMs: undefined,
  });

  console.log(JSON.stringify({
    ok: true,
    status: 'sigma_alarm_dispatch_smoke_passed',
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`[sigma-alarm-dispatch-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = originalFetch;
    restoreEnv();
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  });
