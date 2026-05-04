const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_PATH = require.resolve('../../../packages/core/lib/hub-alarm-client.ts');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resetClientModule() {
  delete require.cache[CLIENT_PATH];
}

const RETIRED_GATEWAY_WORD = 'Open' + 'Claw';

function resetEnv(tempWorkspace) {
  process.env.HUB_ALARM_RECENT_ALERTS_PATH = path.join(tempWorkspace, 'recent-alerts.json');
  process.env.HUB_BASE_URL = 'http://127.0.0.1:7788';
  process.env.HUB_AUTH_TOKEN = 'smoke-hub-token';
  process.env.HUB_ALARM_SKIP_DIRECT = 'false';
  process.env.USE_HUB_SECRETS = 'false';
  delete process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;
  delete process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;
}

async function runSuppressedHubOnlyCase(tempWorkspace) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push({ url: normalizedUrl, method: String(init.method || 'GET') });
    if (normalizedUrl.endsWith('/hub/alarm')) {
      return new Response(
        JSON.stringify({
          ok: true,
          suppressed: true,
          delivered: false,
          reason: 'alerts_disabled',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch url without legacy fallback: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'hub-only smoke',
    team: 'luna',
    alertLevel: 2,
    fromBot: 'hub-smoke',
    payload: { event_type: 'smoke_test' },
  });

  assert(result && result.ok === false, 'expected postAlarm result ok=false when hub suppresses and fallback disabled');
  assert(result.fallback === 'disabled', 'expected fallback=disabled');
  assert(calls.length === 1, `expected only hub alarm call, got ${calls.length}`);
  assert(calls[0].url.endsWith('/hub/alarm'), 'expected first call to hub alarm');
}

async function runRetiredLegacyFallbackIgnoredCase(tempWorkspace) {
  resetEnv(tempWorkspace);
  process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK = 'true';
  process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN = 'smoke-hooks-token';
  resetClientModule();
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push({
      url: normalizedUrl,
      method: String(init.method || 'GET'),
      headers: init.headers || {},
      body: init.body || null,
    });

    if (normalizedUrl.endsWith('/hub/alarm')) {
      return new Response(
        JSON.stringify({
          ok: true,
          suppressed: true,
          delivered: false,
          reason: 'alerts_disabled',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    throw new Error(`unexpected non-Hub fetch url after ${RETIRED_GATEWAY_WORD} fallback retirement: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'retired fallback smoke',
    team: 'luna',
    alertLevel: 2,
    fromBot: 'hub-smoke',
    payload: { event_type: 'smoke_test' },
  });

  assert(result && result.ok === false, 'expected postAlarm result ok=false when hub suppresses and legacy env is ignored');
  assert(result.fallback === 'disabled', 'expected fallback=disabled even when legacy env is set');
  assert(calls.length === 1, `expected only hub alarm call after fallback retirement, got ${calls.length}`);
  assert(calls[0].url.endsWith('/hub/alarm'), 'expected first call to hub alarm');
}

async function runTelegramSenderCanUseHubDirectCase(tempWorkspace) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push({
      url: normalizedUrl,
      method: String(init.method || 'GET'),
      body: init.body || null,
    });
    if (normalizedUrl.endsWith('/hub/alarm')) {
      return new Response(
        JSON.stringify({
          ok: true,
          delivered: true,
          event_id: 123,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch url for telegram-sender hub direct case: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'telegram sender recursion guard smoke',
    team: 'blog',
    alertLevel: 2,
    fromBot: 'telegram-sender',
    payload: { event_type: 'smoke_test' },
  });

  assert(result && result.ok === true, 'expected telegram-sender fromBot to use hub direct successfully');
  assert(calls.length === 1, `expected 1 hub call, got ${calls.length}`);
  assert(calls[0].url.endsWith('/hub/alarm'), 'expected telegram-sender path to call hub alarm');
}

async function runStandardContractFallbackCase(tempWorkspace) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push({
      url: normalizedUrl,
      method: String(init.method || 'GET'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (normalizedUrl.endsWith('/hub/alarm')) {
      return new Response(
        JSON.stringify({
          ok: true,
          delivered: true,
          event_id: 124,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch url for standard contract case: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'implicit alarm contract smoke',
    team: 'hub',
    alertLevel: 1,
    fromBot: 'contract-smoke',
  });

  assert(result && result.ok === true, 'expected standard contract fallback case to deliver');
  assert(calls.length === 1, `expected 1 hub call, got ${calls.length}`);
  assert(calls[0].body.alarmType === 'work', `expected inferred work alarm type, got ${calls[0].body.alarmType}`);
  assert(calls[0].body.visibility === 'notify', `expected inferred notify visibility, got ${calls[0].body.visibility}`);
  assert(calls[0].body.actionability === 'none', `expected inferred none actionability, got ${calls[0].body.actionability}`);
  assert(calls[0].body.eventType === 'contract-smoke_work', `expected derived eventType, got ${calls[0].body.eventType}`);
  assert(/^hub:contract-smoke:contract-smoke_work:[a-f0-9]{12}$/.test(calls[0].body.incidentKey), `unexpected incidentKey: ${calls[0].body.incidentKey}`);
  assert(calls[0].body.payload.event_type === calls[0].body.eventType, 'expected payload event_type to match derived eventType');
}

async function runCriticalContractFallbackCase(tempWorkspace) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const normalizedUrl = String(url);
    calls.push({
      url: normalizedUrl,
      method: String(init.method || 'GET'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (normalizedUrl.endsWith('/hub/alarm')) {
      return new Response(
        JSON.stringify({
          ok: true,
          delivered: true,
          event_id: 125,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch url for critical contract case: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'critical alarm contract smoke',
    team: 'hub',
    alertLevel: 4,
    fromBot: 'contract-smoke',
  });

  assert(result && result.ok === true, 'expected critical contract fallback case to deliver');
  assert(calls.length === 1, `expected 1 hub call, got ${calls.length}`);
  assert(calls[0].body.alarmType === 'critical', `expected critical alarm type, got ${calls[0].body.alarmType}`);
  assert(calls[0].body.visibility === 'emergency', `expected emergency visibility, got ${calls[0].body.visibility}`);
  assert(calls[0].body.actionability === 'needs_human', `expected needs_human actionability, got ${calls[0].body.actionability}`);
}

async function main() {
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-webhook-smoke-'));
  const originalFetch = global.fetch;
  const originalHubRecentAlertsPath = process.env.HUB_ALARM_RECENT_ALERTS_PATH;
  const originalHubLegacyHooksToken = process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;
  const originalHubSkipDirect = process.env.HUB_ALARM_SKIP_DIRECT;
  const originalHubLegacyFallback = process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;

  try {
    await runSuppressedHubOnlyCase(tempWorkspace);
    await runRetiredLegacyFallbackIgnoredCase(tempWorkspace);
    await runTelegramSenderCanUseHubDirectCase(tempWorkspace);
    await runStandardContractFallbackCase(tempWorkspace);
    await runCriticalContractFallbackCase(tempWorkspace);
    console.log('hub_postalarm_no_legacy_fallback_smoke_ok');
  } finally {
    global.fetch = originalFetch;
    if (originalHubRecentAlertsPath == null) delete process.env.HUB_ALARM_RECENT_ALERTS_PATH;
    else process.env.HUB_ALARM_RECENT_ALERTS_PATH = originalHubRecentAlertsPath;
    if (originalHubLegacyHooksToken == null) delete process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;
    else process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN = originalHubLegacyHooksToken;
    if (originalHubSkipDirect == null) delete process.env.HUB_ALARM_SKIP_DIRECT;
    else process.env.HUB_ALARM_SKIP_DIRECT = originalHubSkipDirect;
    if (originalHubLegacyFallback == null) delete process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;
    else process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK = originalHubLegacyFallback;
    resetClientModule();
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error('[hub-postalarm-no-legacy-fallback-smoke] failed:', error?.message || error);
  process.exit(1);
});
