#!/usr/bin/env tsx
'use strict';

/**
 * Polish 1 Stage 3 — Autonomous Mode + Roundtable activation smoke.
 *
 * This smoke is hermetic. It verifies the route contract for Stage 3 without
 * sending real Telegram messages, creating real auto_dev files, or invoking LLMs.
 */

const alarmRouteModule = require('../lib/routes/alarm.ts');
const { shouldTriggerRoundtable, getDailyRoundtableCount } = require('../lib/alarm/alarm-roundtable-engine.ts');

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
  if (!condition) throw new Error(`[stage3-smoke] ${message}`);
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

async function assertRoundtableGate(): Promise<void> {
  await withEnv({ HUB_ALARM_ROUNDTABLE_ENABLED: 'false' }, async () => {
    const disabled = await shouldTriggerRoundtable({ alarmType: 'critical', visibility: 'emergency' });
    assert(disabled === false, 'roundtable gate must be closed when disabled');
  });
  await withEnv({ HUB_ALARM_ROUNDTABLE_ENABLED: 'true' }, async () => {
    const enabled = await shouldTriggerRoundtable({ alarmType: 'critical', visibility: 'emergency' });
    assert(enabled === true, 'critical alarms must trigger roundtable when enabled');
  });
  assert(typeof getDailyRoundtableCount() === 'number', 'daily roundtable counter must be observable');
}

async function assertAutonomousRouteContract(): Promise<void> {
  const originals = {
    fetch: global.fetch,
  };
  const records: any[] = [];
  const dbRuns: string[] = [];
  const telegramRequests: any[] = [];
  const roundtableCalls: any[] = [];
  const autoDevDocs: any[] = [];

  _testOnly_setAlarmEventLakeMocks({
    findRecentDuplicateAlarm: async () => null,
    record: async (payload: any) => {
      records.push(payload);
      return 9300 + records.length;
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
    classifyAlarmWithLLM: async () => ({ type: 'error', confidence: 0.91, source: 'llm' }),
    interpretAlarm: async () => ({
      summary: 'autonomous roundtable interpretation ok',
      actionRecommendation: 'let roundtable produce repair plan',
    }),
    enrichAlarm: async () => ({ clusterCount: 4, recentTeamCount: 4, firstSeenAt: new Date().toISOString() }),
    ensureAlarmAutoDevDocument: async (payload: any) => {
      autoDevDocs.push(payload);
      return {
        ok: true,
        created: true,
        path: 'docs/auto_dev/CODEX_ALARM_INCIDENT_stage3_smoke.md',
      };
    },
    shouldTriggerRoundtable: async () => true,
    runRoundtable: async (payload: any) => {
      roundtableCalls.push(payload);
      return {
        roundtableId: 123,
        incidentKey: payload.incidentKey,
        consensus: {
          rootCause: 'smoke',
          proposedFix: 'verify route contract',
          estimatedComplexity: 'low',
          riskLevel: 'low',
          assignedTo: 'claude-team',
          successCriteria: 'contract holds',
          agreementScore: 0.9,
        },
        participants: ['jay', 'claude_lead', 'team_commander'],
        meetingNote: 'stage3 smoke roundtable',
      };
    },
  });
  global.fetch = async (url: any, init: any) => {
    if (String(url).includes('api.telegram.org')) {
      telegramRequests.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')),
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await withEnv({
      HUB_ALARM_DISPATCH_MODE: 'autonomous',
      HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_ENABLED: 'true',
      HUB_ALARM_ENRICHMENT_ENABLED: 'true',
      HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',
      HUB_ALARM_ROUNDTABLE_ENABLED: 'true',
      HUB_ALARM_ROUNDTABLE_DAILY_LIMIT: '10',
      HUB_ALARM_ROUNDTABLE_TRIGGER_FINGERPRINT_THRESHOLD: '3',
      HUB_ALARM_USE_CLASS_TOPICS: 'true',
      TELEGRAM_BOT_TOKEN: 'stage3-smoke-token',
      TELEGRAM_GROUP_ID: '-1001234567890',
      TELEGRAM_TOPIC_OPS_WORK: '11',
      TELEGRAM_TOPIC_OPS_REPORTS: '12',
      TELEGRAM_TOPIC_OPS_ERROR_RESOLUTION: '13',
      TELEGRAM_TOPIC_OPS_EMERGENCY: '14',
      TELEGRAM_ALERTS_DISABLED: 'false',
    }, async () => {
      assert(getDispatchMode() === 'autonomous', 'dispatch mode must be autonomous');

      const res = makeRes();
      await alarmRoute({
        body: {
          team: 'luna',
          fromBot: 'stage3-smoke',
          severity: 'error',
          alarmType: 'error',
          visibility: 'notify',
          actionability: 'auto_repair',
          title: 'stage3 autonomous roundtable check',
          message: 'synthetic Stage 3 error for roundtable and auto_dev handoff verification',
          incidentKey: `stage3:autonomous:${Date.now()}`,
        },
      }, res);

      assert(res.statusCode === 200, 'autonomous route must return 200');
      assert(res.body.dispatch_mode === 'autonomous', 'response must expose autonomous dispatch mode');
      assert(res.body.delivered === true, 'autonomous mode must keep Telegram delivery open');
      assert(res.body.delivery_team === 'ops-error-resolution', `expected ops-error-resolution, got ${res.body.delivery_team}`);
      assert(res.body.auto_repair?.ok === true, 'autonomous auto-repair path must create document handoff');
      assert(res.body.auto_repair_shadow_skipped === false, 'autonomous must not use shadow auto-repair skip');
      assert(roundtableCalls.length === 1, `expected one roundtable trigger, got ${roundtableCalls.length}`);
      assert(roundtableCalls[0].autoDevDocPath === 'docs/auto_dev/CODEX_ALARM_INCIDENT_stage3_smoke.md', 'roundtable must receive auto_dev doc path');
      assert(autoDevDocs.length === 1, `expected one auto_dev handoff, got ${autoDevDocs.length}`);
      assert(telegramRequests.length === 1, `expected exactly one Telegram request, got ${telegramRequests.length}`);
      assert(String(telegramRequests[0].body.message_thread_id) === '13', 'Telegram must use ops-error-resolution topic');
      assert(records.some((row) => row.eventType === 'hub_alarm_auto_repair_enqueued'), 'auto repair event must be recorded');
      assert(dbRuns.some((sql) => sql.includes('agent.hub_alarm_classifications')), 'classification mirror SQL missing');
      assert(dbRuns.some((sql) => sql.includes('agent.hub_alarms')), 'alarm mirror SQL missing');
    });
  } finally {
    global.fetch = originals.fetch;
    _testOnly_resetAlarmRouteDbMocks();
    _testOnly_resetAlarmRouteHooks();
    _testOnly_resetAlarmEventLakeMocks();
  }
}

async function main(): Promise<void> {
  await assertRoundtableGate();
  await assertAutonomousRouteContract();
  console.log('alarm_activation_stage3_smoke_ok');
}

main().catch((error) => {
  console.error('[alarm-activation-stage3-smoke] failed:', error?.message || error);
  process.exit(1);
});
