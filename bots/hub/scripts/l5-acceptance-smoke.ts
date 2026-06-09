const eventLake = require('../../../packages/core/lib/event-lake');

import type { Server } from 'node:http';

type ExpressLikeApp = {
  listen: (port: number, host: string, callback: () => void) => Server;
};

type JsonResponse = {
  status: number;
  body: Record<string, any>;
};

type EventLakeRecord = {
  eventType?: string;
  [key: string]: unknown;
};

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

async function withServer(app: ExpressLikeApp, fn: (baseUrl: string) => Promise<void>) {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server_address_unavailable');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function requestJson(baseUrl: string, token: string, method: string, route: string, body: unknown): Promise<JsonResponse> {
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
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    TELEGRAM_ALERTS_DISABLED: process.env.TELEGRAM_ALERTS_DISABLED,
  };

  const originalFns = {
    findRecentDuplicateAlarm: eventLake.findRecentDuplicateAlarm,
    record: eventLake.record,
    fetch: global.fetch,
  };

  const smokeToken = 'l5-acceptance-token';
  process.env.HUB_AUTH_TOKEN = smokeToken;
  process.env.HUB_CONTROL_PLANNER_FORCE_HEURISTIC = '1';
  process.env['TELEGRAM_' + 'BOT_TOKEN'] = 'l5-acceptance-smoke-fixture';
  process.env.TELEGRAM_GROUP_ID = '-100123456';
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';

  const eventLakeRecords: EventLakeRecord[] = [];
  const dbWrites: string[] = [];
  let eventId = 500;
  let humanImmediateSends = 0;
  eventLake.findRecentDuplicateAlarm = async () => null;
  eventLake.record = async (payload: EventLakeRecord) => {
    eventLakeRecords.push(payload);
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
    const alarmRoute = require('../lib/routes/alarm.ts');
    if (typeof alarmRoute._testOnly_setAlarmEventLakeMocks === 'function') {
      alarmRoute._testOnly_setAlarmEventLakeMocks({
        findRecentDuplicateAlarm: async () => null,
        record: async (payload: EventLakeRecord) => {
          eventLakeRecords.push(payload);
          eventId += 1;
          return eventId;
        },
      });
    }
    if (typeof alarmRoute._testOnly_setAlarmRouteDbMocks === 'function') {
      alarmRoute._testOnly_setAlarmRouteDbMocks({
        query: async () => [],
        get: async () => null,
        run: async (_schema: string, sql: string) => {
          dbWrites.push(String(sql));
          return { rowCount: 1, rows: [] };
        },
      });
    }
    const { createHubApp } = require('../src/app.ts');
    const app = createHubApp({
      isShuttingDown: () => false,
      isStartupComplete: () => true,
    });

    await withServer(app, async (baseUrl: string) => {
      const stamp = Date.now();
      const health = await fetch(`${baseUrl}/hub/health`);
      assert(health.status === 200, `expected /hub/health 200, got ${health.status}`);

      for (let index = 0; index < 100; index += 1) {
        const alarmResp = await requestJson(baseUrl, smokeToken, 'POST', '/hub/alarm', {
          message: `synthetic warning ${index}`,
          team: 'luna',
          fromBot: 'l5-warning-smoke',
          severity: 'warn',
          eventType: 'synthetic_warning',
          alarmType: 'error',
          visibility: 'digest',
          actionability: 'none',
        });
        assert(alarmResp.status === 200, `expected alarm status 200, got ${alarmResp.status} at ${index}`);
        assert(alarmResp.body.ok === true, 'expected alarm ok=true');
        assert(alarmResp.body.visibility === 'digest', `expected digest visibility, got ${alarmResp.body.visibility}`);
      }
      assert(
        humanImmediateSends === 0,
        `expected no immediate human send for warning flood, got ${humanImmediateSends}`,
      );

      const emergencyResp = await requestJson(baseUrl, smokeToken, 'POST', '/hub/alarm', {
        message: `critical service down ${stamp}`,
        team: 'luna',
        fromBot: 'l5-warning-smoke',
        severity: 'critical',
        eventType: `synthetic_emergency_${Math.random().toString(36).slice(2, 8)}`,
        visibility: 'emergency',
        incidentKey: `smoke:emergency:${stamp}`,
      });
      assert(emergencyResp.status === 200, `expected emergency alarm 200, got ${emergencyResp.status}`);
      assert(emergencyResp.body.visibility === 'emergency', 'expected emergency visibility');
      assert(humanImmediateSends >= 1, 'expected emergency to trigger immediate send');
      assert(
        eventLakeRecords.some((row) => row?.eventType === 'hub_alarm'),
        'expected l5 smoke to exercise the mocked hub_alarm EventLake path',
      );
      assert(
        dbWrites.some((sql) => sql.includes('agent.hub_alarm_classifications')),
        'expected l5 smoke to exercise the mocked alarm classification mirror path',
      );
      assert(
        dbWrites.some((sql) => sql.includes('agent.hub_alarms')),
        'expected l5 smoke to exercise the mocked alarm mirror path',
      );

      const planResp = await requestJson(baseUrl, smokeToken, 'POST', '/hub/control/plan', {
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
    try {
      const alarmRoute = require('../lib/routes/alarm.ts');
      if (typeof alarmRoute._testOnly_resetAlarmEventLakeMocks === 'function') {
        alarmRoute._testOnly_resetAlarmEventLakeMocks();
      }
      if (typeof alarmRoute._testOnly_resetAlarmRouteDbMocks === 'function') {
        alarmRoute._testOnly_resetAlarmRouteDbMocks();
      }
    } catch {
      // Best-effort cleanup for smoke-only hooks.
    }
    eventLake.findRecentDuplicateAlarm = originalFns.findRecentDuplicateAlarm;
    eventLake.record = originalFns.record;
    global.fetch = originalFns.fetch;

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error: unknown) => {
  console.error('[l5-acceptance-smoke] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
