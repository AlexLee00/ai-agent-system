#!/usr/bin/env tsx
'use strict';

/**
 * Polish 1 Stage 2 — Supervised Mode activation smoke.
 *
 * This is hermetic: it mocks Telegram HTTP, DB writes, and event-lake.
 * The contract verified here is:
 *   - dispatch_mode=supervised
 *   - Telegram delivery path is opened
 *   - interpreter/enrichment still run before delivery
 *   - Roundtable remains disabled until Stage 3 direct approval
 */

const alarmRouteModule = require('../lib/routes/alarm.ts');

const {
  alarmRoute,
  getDispatchMode,
  _testOnly_setAlarmRouteDbMocks,
  _testOnly_resetAlarmRouteDbMocks,
  _testOnly_setAlarmRouteHooks,
  _testOnly_resetAlarmRouteHooks,
  _testOnly_setAlarmEventLakeMocks,
  _testOnly_resetAlarmEventLakeMocks,
} = alarmRouteModule;

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`[stage2-smoke] ${message}`);
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return payload;
    },
  };
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (patch[key] == null) delete process.env[key];
    else process.env[key] = patch[key]!;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] == null) delete process.env[key];
      else process.env[key] = previous[key]!;
    }
  }
}

async function main(): Promise<void> {
  const originals = {
    fetch: global.fetch,
  };
  const records: any[] = [];
  const telegramRequests: any[] = [];
  const dbRuns: string[] = [];
  let roundtableCalls = 0;
  let autoDevCalls = 0;

  _testOnly_setAlarmEventLakeMocks({
    findRecentDuplicateAlarm: async () => null,
    record: async (payload: any) => {
      records.push(payload);
      return 9200 + records.length;
    },
  });
  _testOnly_setAlarmRouteDbMocks({
    query: async () => [],
    get: async () => null,
    run: async (_schema: string, sql: string) => {
      dbRuns.push(String(sql));
      return { rowCount: 1, rows: [] };
    },
  });
  _testOnly_setAlarmRouteHooks({
    classifyAlarmWithLLM: async () => ({ type: 'work', confidence: 0.91, source: 'llm' }),
    interpretAlarm: async () => ({
      summary: 'supervised delivery interpretation ok',
      actionRecommendation: 'review delivery only',
    }),
    enrichAlarm: async () => ({ clusterCount: 1, recentTeamCount: 1, firstSeenAt: new Date().toISOString() }),
    ensureAlarmAutoDevDocument: async () => {
      autoDevCalls += 1;
      throw new Error('auto_dev must not run in Stage 2 work-alarm smoke');
    },
    shouldTriggerRoundtable: async () => false,
    runRoundtable: async () => {
      roundtableCalls += 1;
      return null;
    },
  });
  global.fetch = async (url: any, init: any) => {
    if (String(url).includes('api.telegram.org')) {
      telegramRequests.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')),
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await withEnv({
      HUB_ALARM_DISPATCH_MODE: 'supervised',
      HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_ENABLED: 'true',
      HUB_ALARM_ENRICHMENT_ENABLED: 'true',
      HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',
      HUB_ALARM_ROUNDTABLE_ENABLED: 'false',
      HUB_ALARM_USE_CLASS_TOPICS: 'true',
      TELEGRAM_BOT_TOKEN: 'stage2-smoke-token',
      TELEGRAM_GROUP_ID: '-1001234567890',
      TELEGRAM_TOPIC_OPS_WORK: '11',
      TELEGRAM_TOPIC_OPS_REPORTS: '12',
      TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: '13',
      TELEGRAM_TOPIC_OPS_EMERGENCY: '14',
      TELEGRAM_ALERTS_DISABLED: 'false',
    }, async () => {
      assert(getDispatchMode() === 'supervised', 'dispatch mode must be supervised');

      const res = makeRes();
      await alarmRoute({
        body: {
          team: 'hub',
          fromBot: 'stage2-smoke',
          severity: 'info',
          alarmType: 'work',
          visibility: 'notify',
          actionability: 'none',
          title: 'stage2 supervised delivery check',
          message: 'synthetic Stage 2 supervised delivery verification',
          incidentKey: `stage2:supervised:${Date.now()}`,
        },
      }, res);

      assert(res.statusCode === 200, 'supervised route must return 200');
      assert(res.body.dispatch_mode === 'supervised', 'response must expose supervised dispatch mode');
      assert(res.body.delivered === true, 'supervised mode must attempt and report Telegram delivery');
      assert(res.body.delivery_team === 'ops-work', `expected ops-work delivery team, got ${res.body.delivery_team}`);
      assert(res.body.auto_repair == null, 'work notification must not create auto_dev');
      assert(res.body.auto_repair_shadow_skipped === false, 'supervised work notification must not mark shadow skip');
      assert(res.body.mirror_records?.classification?.ok === true, 'classification mirror write must be attempted');
      assert(res.body.mirror_records?.alarm?.ok === true, 'alarm mirror write must be attempted');
      assert(telegramRequests.length === 1, `expected exactly one Telegram request, got ${telegramRequests.length}`);
      assert(telegramRequests[0].body.chat_id === '-1001234567890', 'Telegram must use group chat id');
      assert(String(telegramRequests[0].body.message_thread_id) === '11', 'Telegram must use ops-work topic');
      assert(roundtableCalls === 0, 'Stage 2 must not run roundtable');
      assert(autoDevCalls === 0, 'Stage 2 work notification must not run auto_dev');
      assert(records.some((row) => row.eventType === 'hub_alarm'), 'event lake hub_alarm record missing');
      assert(dbRuns.some((sql) => sql.includes('agent.hub_alarm_classifications')), 'classification mirror SQL missing');
      assert(dbRuns.some((sql) => sql.includes('agent.hub_alarms')), 'alarm mirror SQL missing');
    });
  } finally {
    global.fetch = originals.fetch;
    _testOnly_resetAlarmRouteDbMocks();
    _testOnly_resetAlarmRouteHooks();
    _testOnly_resetAlarmEventLakeMocks();
  }

  console.log('alarm_activation_stage2_smoke_ok');
}

main().catch((error) => {
  console.error('[alarm-activation-stage2-smoke] failed:', error?.message || error);
  process.exit(1);
});
