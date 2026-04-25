const eventLake = require('../../../packages/core/lib/event-lake');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function requestJson(baseUrl, token, method, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

async function main() {
  const originalEnv = {
    HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN,
    HUB_CONTROL_PLANNER_FORCE_HEURISTIC: process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC,
    HUB_ALARM_LEGACY_OPENCLAW_FALLBACK: process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK,
    OPENCLAW_LEGACY_FALLBACK: process.env.OPENCLAW_LEGACY_FALLBACK,
    OPENCLAW_PORT: process.env.OPENCLAW_PORT,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TELEGRAM_ALERTS_DISABLED: process.env.TELEGRAM_ALERTS_DISABLED,
  };

  const originalFns = {
    findRecentDuplicateAlarm: eventLake.findRecentDuplicateAlarm,
    record: eventLake.record,
    fetch: global.fetch,
  };

  process.env.HUB_AUTH_TOKEN = 'l5-acceptance-token';
  process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = '1';
  process.env.HUB_ALARM_LEGACY_OPENCLAW_FALLBACK = 'false';
  process.env.OPENCLAW_LEGACY_FALLBACK = 'false';
  process.env.OPENCLAW_PORT = '18789';
  process.env['TELEGRAM_' + 'BOT_TOKEN'] = 'l5-acceptance-smoke-fixture';
  process.env.TELEGRAM_CHAT_ID = '123456';
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';

  let eventId = 500;
  let humanImmediateSends = 0;
  eventLake.findRecentDuplicateAlarm = async () => null;
  eventLake.record = async () => {
    eventId += 1;
    return eventId;
  };
  global.fetch = async (url, init) => {
    if (String(url).includes('api.telegram.org')) {
      humanImmediateSends += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFns.fetch(url, init);
  };

  try {
    const { createHubApp } = require('../src/app.ts');
    const app = createHubApp({
      isShuttingDown: () => false,
      isStartupComplete: () => true,
    });

    await withServer(app, async (baseUrl) => {
      const stamp = Date.now();
      const health = await fetch(`${baseUrl}/hub/health`);
      assert(health.status === 200, `expected /hub/health 200, got ${health.status}`);

      for (let index = 0; index < 100; index += 1) {
        const alarmResp = await requestJson(baseUrl, process.env.HUB_AUTH_TOKEN, 'POST', '/hub/alarm', {
          message: `synthetic warning ${index}`,
          team: 'luna',
          fromBot: 'l5-warning-smoke',
          severity: 'warn',
          eventType: 'synthetic_warning',
        });
        assert(alarmResp.status === 200, `expected alarm status 200, got ${alarmResp.status} at ${index}`);
        assert(alarmResp.body.ok === true, 'expected alarm ok=true');
        assert(alarmResp.body.visibility === 'digest', `expected digest visibility, got ${alarmResp.body.visibility}`);
      }
      assert(
        humanImmediateSends === 0,
        `expected no immediate human send for warning flood, got ${humanImmediateSends}`,
      );

      const emergencyResp = await requestJson(baseUrl, process.env.HUB_AUTH_TOKEN, 'POST', '/hub/alarm', {
        message: `critical service down ${stamp}`,
        team: 'luna',
        fromBot: 'l5-warning-smoke',
        severity: 'critical',
        incidentKey: `smoke:emergency:${stamp}`,
      });
      assert(emergencyResp.status === 200, `expected emergency alarm 200, got ${emergencyResp.status}`);
      assert(emergencyResp.body.visibility === 'emergency', 'expected emergency visibility');
      assert(humanImmediateSends >= 1, 'expected emergency to trigger immediate send');

      const planResp = await requestJson(baseUrl, process.env.HUB_AUTH_TOKEN, 'POST', '/hub/control/plan', {
        message: '루나팀 상태 보고해줘',
        team: 'luna',
        dryRun: true,
      });
      assert(planResp.status === 200, `expected control plan 200, got ${planResp.status}`);
      assert(planResp.body.ok === true, 'expected control plan ok');
      assert(planResp.body.audit?.dry_run === true, 'expected audit dry-run payload');
    });

    console.log('l5_acceptance_smoke_ok');
  } finally {
    eventLake.findRecentDuplicateAlarm = originalFns.findRecentDuplicateAlarm;
    eventLake.record = originalFns.record;
    global.fetch = originalFns.fetch;

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error('[l5-acceptance-smoke] failed:', error?.message || error);
  process.exit(1);
});
