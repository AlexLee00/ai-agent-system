'use strict';

/**
 * Polish 1 Stage 1 — Shadow Mode activation smoke.
 *
 * This is hermetic: it mocks Telegram, DB writes, classifier/interpreter hooks,
 * and event-lake so unit checks can validate the contract without sending
 * alerts or creating auto_dev documents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const alarmRouteModule = require('../lib/routes/alarm.ts');
const { isCriticalTypeEnabled } = require('../lib/alarm/classify-alarm-llm.ts');

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`[stage1-smoke] ${message}`);
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

function assertRepoPlistStage1(): void {
  const plistPath = path.resolve(__dirname, '../launchd/ai.hub.resource-api.plist');
  const text = fs.readFileSync(plistPath, 'utf8');
  const requiredPairs = [
    ['HUB_ALARM_LLM_CLASSIFIER_ENABLED', 'true'],
    ['HUB_ALARM_INTERPRETER_ENABLED', 'true'],
    ['HUB_ALARM_ENRICHMENT_ENABLED', 'true'],
    ['HUB_ALARM_CRITICAL_TYPE_ENABLED', 'true'],
    ['HUB_ALARM_INTERPRETER_FAIL_OPEN', 'true'],
  ];
  for (const [key, value] of requiredPairs) {
    const keyIndex = text.indexOf(`<key>${key}</key>`);
    assert(keyIndex >= 0, `repo plist missing ${key}`);
    assert(text.indexOf(`<string>${value}</string>`, keyIndex) > keyIndex, `repo plist ${key} must be ${value}`);
  }
  const dispatchKeyIndex = text.indexOf('<key>HUB_ALARM_DISPATCH_MODE</key>');
  assert(dispatchKeyIndex >= 0, 'repo plist missing HUB_ALARM_DISPATCH_MODE');
  const autonomous = text.indexOf('<string>autonomous</string>', dispatchKeyIndex) > dispatchKeyIndex;
  const supervised = text.indexOf('<string>supervised</string>', dispatchKeyIndex) > dispatchKeyIndex;
  const shadow = text.indexOf('<string>shadow</string>', dispatchKeyIndex) > dispatchKeyIndex;
  assert(autonomous || supervised || shadow, 'repo plist dispatch mode must be a known alarm dispatch mode');
  const roundtableKeyIndex = text.indexOf('<key>HUB_ALARM_ROUNDTABLE_ENABLED</key>');
  assert(roundtableKeyIndex >= 0, 'repo plist missing HUB_ALARM_ROUNDTABLE_ENABLED');
  const roundtableEnabled = text.indexOf('<string>true</string>', roundtableKeyIndex) > roundtableKeyIndex;
  const roundtableDisabled = text.indexOf('<string>false</string>', roundtableKeyIndex) > roundtableKeyIndex;
  assert(roundtableEnabled || roundtableDisabled, 'repo plist roundtable flag must be boolean text');
  assert(text.includes('__SET_IN_LOCAL_LAUNCHAGENT__'), 'repo plist must keep secret placeholders');
}

function assertMigrationCoversTables(): void {
  const migrationPath = path.resolve(__dirname, '../migrations/20261001000050_hub_alarm_tables.sql');
  const text = fs.readFileSync(migrationPath, 'utf8');
  for (const table of ['hub_alarm_classifications', 'hub_alarms', 'alarm_roundtables']) {
    assert(text.includes(`agent.${table}`), `migration missing agent.${table}`);
  }
}

async function assertShadowRouteContract(): Promise<void> {
  const originals = {
    fetch: global.fetch,
  };

  const records: any[] = [];
  const dbRuns: string[] = [];
  let telegramSendCount = 0;
  let autoDevCalls = 0;
  let roundtableCalls = 0;

  _testOnly_setAlarmEventLakeMocks({
    findRecentDuplicateAlarm: async () => null,
    record: async (payload: any) => {
      records.push(payload);
      return 9000 + records.length;
    },
  });
  global.fetch = async (url: any) => {
    if (String(url).includes('api.telegram.org')) telegramSendCount += 1;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  _testOnly_setAlarmRouteDbMocks({
    query: async () => [],
    get: async () => null,
    run: async (_schema: string, sql: string) => {
      dbRuns.push(String(sql));
      return { rowCount: 1, rows: [] };
    },
  });
  _testOnly_setAlarmRouteHooks({
    classifyAlarmWithLLM: async () => ({ type: 'critical', confidence: 0.92, source: 'llm' }),
    interpretAlarm: async () => ({ summary: 'shadow interpretation ok', actionRecommendation: 'observe only' }),
    enrichAlarm: async () => ({ clusterCount: 2, recentTeamCount: 3, firstSeenAt: new Date().toISOString() }),
    ensureAlarmAutoDevDocument: async () => {
      autoDevCalls += 1;
      throw new Error('auto_dev must not run in shadow');
    },
    shouldTriggerRoundtable: async () => true,
    runRoundtable: async () => {
      roundtableCalls += 1;
      return null;
    },
  });

  try {
    await withEnv({
      HUB_ALARM_DISPATCH_MODE: 'shadow',
      HUB_ALARM_LLM_CLASSIFIER_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_ENABLED: 'true',
      HUB_ALARM_ENRICHMENT_ENABLED: 'true',
      HUB_ALARM_CRITICAL_TYPE_ENABLED: 'true',
      HUB_ALARM_INTERPRETER_FAIL_OPEN: 'true',
      HUB_ALARM_ROUNDTABLE_ENABLED: 'false',
      TELEGRAM_BOT_TOKEN: 'stage1-smoke-token',
      TELEGRAM_CHAT_ID: '123456',
      TELEGRAM_ALERTS_DISABLED: 'false',
    }, async () => {
      assert(getDispatchMode() === 'shadow', 'dispatch mode must be shadow');
      assert(isCriticalTypeEnabled() === true, 'critical type gate must be enabled');

      const criticalRes = makeRes();
      await alarmRoute({
        body: {
          team: 'luna',
          fromBot: 'stage1-smoke',
          severity: 'info',
          title: 'stage1 shadow critical classification',
          message: 'ambiguous incident needs classification',
          incidentKey: `stage1:critical:${Date.now()}`,
        },
      }, criticalRes);

      assert(criticalRes.statusCode === 200, 'critical shadow route must return 200');
      assert(criticalRes.body.dispatch_mode === 'shadow', 'response must expose shadow dispatch mode');
      assert(criticalRes.body.alarm_type === 'critical', 'LLM critical classification must be accepted');
      assert(criticalRes.body.delivered === false, 'shadow must not deliver Telegram');
      assert(criticalRes.body.delivery_team === null, 'shadow must hide delivery team');
      assert(criticalRes.body.shadow_observation?.interpreted === true, 'shadow must run interpreter observation');
      assert(criticalRes.body.shadow_observation?.enriched === true, 'shadow must run enrichment observation');
      assert(criticalRes.body.mirror_records?.classification?.ok === true, 'classification mirror write must be attempted');
      assert(criticalRes.body.mirror_records?.alarm?.ok === true, 'alarm mirror write must be attempted');

      const errorRes = makeRes();
      await alarmRoute({
        body: {
          team: 'luna',
          fromBot: 'stage1-smoke',
          severity: 'error',
          title: 'stage1 shadow auto repair skip',
          message: 'provider_cooldown error should not create auto_dev in shadow',
          alarmType: 'error',
          incidentKey: `stage1:error:${Date.now()}`,
        },
      }, errorRes);

      assert(errorRes.statusCode === 200, 'error shadow route must return 200');
      assert(errorRes.body.auto_repair_shadow_skipped === true, 'shadow must mark auto repair skipped');
      assert(errorRes.body.auto_repair?.skipped === true, 'shadow must not create auto_dev document');
      assert(autoDevCalls === 0, 'shadow must not call auto_dev hook');
      assert(roundtableCalls === 0, 'shadow must not call roundtable hook');
      assert(telegramSendCount === 0, 'shadow must not call Telegram');
      assert(records.every((row) => row.eventType !== 'hub_alarm_auto_repair_enqueued'), 'shadow must not enqueue auto repair event');
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
  assertRepoPlistStage1();
  assertMigrationCoversTables();
  await assertShadowRouteContract();
  console.log('alarm_activation_stage1_smoke_ok');
}

main().catch((error) => {
  console.error('[alarm-activation-stage1-smoke] failed:', error?.message || error);
  process.exit(1);
});
