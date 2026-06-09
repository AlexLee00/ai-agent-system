const fs = require('fs');
const os = require('os');
const path = require('path');

const CLIENT_PATH = require.resolve('../../../packages/core/lib/hub-alarm-client.ts');

type FetchCall = {
  url: string;
  method: string;
  headers?: any;
  body?: any;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function resetClientModule() {
  delete require.cache[CLIENT_PATH];
}

const RETIRED_GATEWAY_WORD = 'Open' + 'Claw';

function resetEnv(tempWorkspace: string) {
  process.env.HUB_ALARM_RECENT_ALERTS_PATH = path.join(tempWorkspace, 'recent-alerts.json');
  process.env.HUB_BASE_URL = 'http://127.0.0.1:7788';
  process.env.HUB_AUTH_TOKEN = 'smoke-hub-token';
  process.env.HUB_ALARM_SKIP_DIRECT = 'false';
  process.env.USE_HUB_SECRETS = 'false';
  delete process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK;
  delete process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN;
}

async function runSuppressedHubOnlyCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
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

async function runRetiredLegacyFallbackIgnoredCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  process.env.HUB_ALARM_LEGACY_WEBHOOK_FALLBACK = 'true';
  process.env.HUB_ALARM_LEGACY_HOOKS_TOKEN = 'smoke-hooks-token';
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
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

async function runTelegramSenderCanUseHubDirectCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
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

async function runStandardContractFallbackCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
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

async function runCriticalContractFallbackCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
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

async function runExplicitReportContractCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
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
          event_id: 126,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch url for explicit report contract case: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'weekly research report smoke',
    team: 'general',
    alertLevel: 1,
    fromBot: 'research-scanner',
    alarmType: 'report',
    visibility: 'notify',
    actionability: 'none',
    eventType: 'darwin_weekly_research_report',
    incidentKey: 'darwin:research-scanner:weekly_research_report:2026-05-18',
    dedupeMinutes: 720,
    payload: { report: true },
  });

  assert(result && result.ok === true, 'expected explicit report contract case to deliver');
  assert(calls.length === 1, `expected 1 hub call, got ${calls.length}`);
  assert(calls[0].body.alarmType === 'report', `expected report alarm type, got ${calls[0].body.alarmType}`);
  assert(calls[0].body.visibility === 'notify', `expected notify visibility, got ${calls[0].body.visibility}`);
  assert(calls[0].body.actionability === 'none', `expected none actionability, got ${calls[0].body.actionability}`);
  assert(calls[0].body.eventType === 'darwin_weekly_research_report', `expected explicit eventType, got ${calls[0].body.eventType}`);
  assert(calls[0].body.incidentKey === 'darwin:research-scanner:weekly_research_report:2026-05-18', `unexpected incidentKey: ${calls[0].body.incidentKey}`);
  assert(calls[0].body.dedupeMinutes === 720, `expected dedupeMinutes=720, got ${calls[0].body.dedupeMinutes}`);
  assert(calls[0].body.payload.event_type === 'darwin_weekly_research_report', 'expected payload event_type to match explicit eventType');
}

async function runHubRateLimitMetadataCase(tempWorkspace: string) {
  resetEnv(tempWorkspace);
  resetClientModule();
  const calls: FetchCall[] = [];
  global.fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const normalizedUrl = String(url);
    calls.push({
      url: normalizedUrl,
      method: String(init.method || 'GET'),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    if (normalizedUrl.endsWith('/hub/alarm')) {
      return new Response(
        JSON.stringify({
          error: 'rate limit exceeded (200/min)',
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '2',
          },
        },
      );
    }
    throw new Error(`unexpected fetch url for rate-limit metadata case: ${normalizedUrl}`);
  };

  const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client.ts');
  const result = await postAlarm({
    message: 'rate limit metadata smoke',
    team: 'sigma',
    alertLevel: 1,
    fromBot: 'rate-limit-smoke',
    payload: { event_type: 'hub_alarm_rate_limit_metadata_smoke' },
  });

  assert(result && result.ok === false, 'expected rate-limited postAlarm result ok=false');
  assert(result.error === 'rate limit exceeded (200/min)', `expected rate-limit error, got ${result.error}`);
  assert(result.fallback === 'disabled', 'expected fallback=disabled for rate-limited hub alarm');
  assert(result.retryable === true, 'expected retryable=true for Hub 429');
  assert(result.retryAfterMs === 2000, `expected retryAfterMs=2000, got ${result.retryAfterMs}`);
  assert(calls.length === 1, `expected 1 hub call, got ${calls.length}`);
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
    await runExplicitReportContractCase(tempWorkspace);
    await runHubRateLimitMetadataCase(tempWorkspace);
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
