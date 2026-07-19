const {
  alarmRoute,
  alarmNoisyProducersRoute,
  alarmSuppressDryRunRoute,
  alarmDigestFlushRoute,
  alarmAutoRepairCallbackRoute,
  _testOnly_setAlarmEventLakeMocks,
  _testOnly_resetAlarmEventLakeMocks,
  _testOnly_setAlarmRouteDbMocks,
  _testOnly_resetAlarmRouteDbMocks,
} = require('../lib/routes/alarm.ts');
const fs = require('fs');
const os = require('os');
const path = require('path');

type AnyRecord = Record<string, any>;
type MockResponse = {
  statusCode: number;
  body: AnyRecord;
  status: (code: number) => MockResponse;
  json: (payload: AnyRecord) => AnyRecord;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeRes() {
  const response: MockResponse = {
    statusCode: 200,
    body: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: AnyRecord) {
      this.body = payload;
      return payload;
    },
  };
  return response;
}

async function main() {
  const originals = {
    fetch: global.fetch,
    tgToken: process.env.TELEGRAM_BOT_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID,
    tgAlertsDisabled: process.env.TELEGRAM_ALERTS_DISABLED,
    autoDevDir: process.env.HUB_ALARM_AUTO_DEV_DIR,
    classTopics: process.env.HUB_ALARM_USE_CLASS_TOPICS,
  };

  let sendCount = 0;
  let eventId = 100;
  let pgRunCount = 0;
  let mirrorUpdateRowCount = 1;
  let mirrorExistingRows: Array<{
    id?: number;
    status: string;
    team?: string;
    actionability?: string;
    fingerprint?: string;
    metadata?: AnyRecord;
  }> = [];
  const recordedEvents: Array<AnyRecord & { id: number }> = [];
  const pgRuns: Array<{ sql: string; params: unknown[] }> = [];
  let useClusterDuplicate = false;
  const autoDevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-alarm-auto-dev-'));

  const recordEvent = async (record: AnyRecord) => {
    eventId += 1;
    recordedEvents.push({ ...record, id: eventId });
    return eventId;
  };
  _testOnly_setAlarmEventLakeMocks({
    findRecentDuplicateAlarm: async () => null,
    record: recordEvent,
  });
  process.env['TELEGRAM_' + 'BOT_TOKEN'] = 'alarm-governor-smoke-fixture';
  process.env.TELEGRAM_CHAT_ID = '123456';
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';
  process.env.HUB_ALARM_AUTO_DEV_DIR = autoDevDir;
  process.env.HUB_ALARM_USE_CLASS_TOPICS = '1';
  global.fetch = async (url: RequestInfo | URL) => {
    if (String(url).includes('api.telegram.org')) {
      sendCount += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const transactionQuery = async (sql: string, params: unknown[] = []) => {
    const normalizedSql = String(sql);
    pgRuns.push({ sql: normalizedSql, params });
    if (normalizedSql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
    if (normalizedSql.includes('SELECT id, status, team, actionability, metadata') && normalizedSql.includes('FOR UPDATE')) {
      const incidentKey = String(params[0] || '');
      const alarmEventId = String(params[1] || '');
      const rows = mirrorExistingRows.filter((row) => (
        (String(row.metadata?.incident_key || '') === incidentKey || String(row.fingerprint || '') === incidentKey)
        && String(row.metadata?.event_id || '') === alarmEventId
      ));
      return { rowCount: rows.length, rows };
    }
    if (normalizedSql.includes('INSERT INTO agent.event_lake')) {
      eventId += 1;
      const metadata = JSON.parse(String(params[8] || '{}'));
      recordedEvents.push({
        id: eventId,
        eventType: String(params[0] || ''),
        team: String(params[1] || ''),
        botName: String(params[2] || ''),
        severity: String(params[3] || ''),
        traceId: String(params[4] || ''),
        title: String(params[5] || ''),
        message: String(params[6] || ''),
        tags: params[7],
        metadata,
      });
      return { rowCount: 1, rows: [{ id: eventId }] };
    }
    if (normalizedSql.includes('UPDATE agent.event_lake') && normalizedSql.includes('callback_committed')) {
      const event = recordedEvents.find((row) => (
        String(row.id) === String(params[0] || '')
        && row.eventType === 'hub_alarm_auto_repair_result'
        && String(row.metadata?.incident_key || '') === String(params[1] || '')
        && String(row.metadata?.alarm_event_id || '') === String(params[2] || '')
      ));
      if (!event) return { rowCount: 0, rows: [] };
      event.metadata = { ...(event.metadata || {}), callback_committed: 'true' };
      return { rowCount: 1, rows: [{ id: event.id }] };
    }
    if (normalizedSql.includes('UPDATE agent.hub_alarms') && normalizedSql.includes('auto_repair_callback_status')) {
      const row = mirrorExistingRows.find((candidate) => (
        String(candidate.id || '') === String(params[4] || '')
        && String(candidate.metadata?.event_id || '') === String(params[3] || '')
        && ['repairing', 'correlating'].includes(candidate.status)
        && candidate.actionability === 'auto_repair'
      ));
      if (!row || mirrorUpdateRowCount !== 1) return { rowCount: 0, rows: [] };
      row.status = String(params[0] || '');
      row.metadata = {
        ...(row.metadata || {}),
        auto_repair_callback_status: String(params[1] || ''),
        auto_repair_callback_event_id: String(params[2] || ''),
        auto_repair_callback_alarm_event_id: String(params[3] || ''),
        auto_repair_callback_delivery_state: 'sending',
      };
      return { rowCount: 1, rows: [{ id: row.id, status: row.status }] };
    }
    if (normalizedSql.includes('UPDATE agent.hub_alarms') && normalizedSql.includes("'auto_repair_callback_delivery_state', 'sending'")) {
      const row = mirrorExistingRows.find((candidate) => (
        String(candidate.id || '') === String(params[0] || '')
        && String(candidate.metadata?.event_id || '') === String(params[1] || '')
        && String(candidate.metadata?.auto_repair_callback_event_id || '') === String(params[2] || '')
      ));
      if (!row) return { rowCount: 0, rows: [] };
      row.metadata = {
        ...(row.metadata || {}),
        auto_repair_callback_delivery_state: 'sending',
        auto_repair_callback_delivery_error: null,
        auto_repair_callback_delivery_started_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
      return { rowCount: 1, rows: [{ id: row.id }] };
    }
    return { rowCount: 0, rows: [] };
  };
  _testOnly_setAlarmRouteDbMocks({
    query: async (_schema: string, sql: string, params: unknown[] = []) => {
      if (String(sql).includes('SELECT id, status, metadata') && String(sql).includes('FROM agent.hub_alarms')) {
        const incidentKey = String(params[0] || '');
        const alarmEventId = String(params[1] || '');
        return mirrorExistingRows.filter((row) => (
          (String(row.metadata?.incident_key || '') === incidentKey || String(row.fingerprint || '') === incidentKey)
          && String(row.metadata?.event_id || '') === alarmEventId
        )).slice(0, 1);
      }
      if (String(sql).includes(`metadata->>'visibility' = 'digest'`)) {
        return [
          {
            id: 101,
            team: 'luna',
            bot_name: 'luna',
            severity: 'warn',
            message: 'digest candidate',
            metadata: { incident_key: 'luna|digest|1' },
            created_at: new Date().toISOString(),
          },
        ];
      }
      if (String(sql).includes('GROUP BY producer, team')) {
        return [
          { producer: 'luna', team: 'luna', total: 42, escalated: 1, latest_at: new Date().toISOString() },
        ];
      }
      return [
        {
          id: 1,
          team: 'luna',
          bot_name: 'luna',
          severity: 'warn',
          message: 'sample',
          metadata: { incident_key: 'luna|sample' },
          created_at: new Date().toISOString(),
        },
      ];
    },
    get: async (_schema: string, sql: string) => {
      if (useClusterDuplicate && String(sql).includes(`metadata->>'cluster_key'`)) {
        return { id: 999, metadata: { cluster_key: 'luna|llm_provider_cooldown|smoke' } };
      }
      if (String(sql).includes('COUNT(*)::int AS total')) return { total: 3 };
      return null;
    },
    run: async (_schema: string, sql: string, params: unknown[] = []) => {
      pgRunCount += 1;
      pgRuns.push({ sql: String(sql), params });
      if (String(sql).includes('UPDATE agent.event_lake') && String(sql).includes('callback_committed')) {
        const event = recordedEvents.find((row) => String(row.id) === String(params[0] || ''));
        if (event) {
          event.metadata = {
            ...(event.metadata || {}),
            callback_committed: 'true',
          };
        }
        return { rowCount: mirrorUpdateRowCount, rows: [] };
      }
      if (String(sql).includes('UPDATE agent.hub_alarms') && String(sql).includes('auto_repair_callback_status')) {
        const row = mirrorExistingRows.find((candidate) => (
          (String(candidate.metadata?.incident_key || '') === String(params[3] || '')
            || String(candidate.fingerprint || '') === String(params[3] || ''))
          && String(candidate.metadata?.event_id || '') === String(params[4] || '')
          && ['repairing', 'correlating'].includes(candidate.status)
          && candidate.actionability === 'auto_repair'
        ));
        if (!row) return { rowCount: 0, rows: [] };
        row.status = String(params[0] || '');
        row.metadata = {
          ...(row.metadata || {}),
          auto_repair_callback_status: String(params[1] || ''),
          auto_repair_callback_event_id: String(params[2] || ''),
          auto_repair_callback_alarm_event_id: String(params[4] || ''),
        };
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes('UPDATE agent.hub_alarms') && String(sql).includes('auto_repair_callback_delivery_state')) {
        const row = mirrorExistingRows.find((candidate) => (
          (String(candidate.metadata?.incident_key || '') === String(params[2] || '')
            || String(candidate.fingerprint || '') === String(params[2] || ''))
          && String(candidate.metadata?.event_id || '') === String(params[3] || '')
          && String(candidate.metadata?.auto_repair_callback_event_id || '') === String(params[4] || '')
        ));
        if (!row) return { rowCount: 0, rows: [] };
        row.metadata = {
          ...(row.metadata || {}),
          auto_repair_callback_delivery_state: String(params[0] || ''),
          auto_repair_callback_delivery_error: String(params[1] || ''),
        };
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: mirrorUpdateRowCount, rows: [] };
    },
    transaction: async (_schema: string, fn: (client: { query: typeof transactionQuery }) => Promise<any>) => {
      const eventSnapshot = recordedEvents.map((row) => structuredClone(row));
      const mirrorSnapshot = mirrorExistingRows.map((row) => structuredClone(row));
      const eventIdSnapshot = eventId;
      try {
        return await fn({ query: transactionQuery });
      } catch (error) {
        recordedEvents.splice(0, recordedEvents.length, ...eventSnapshot);
        mirrorExistingRows = mirrorSnapshot;
        eventId = eventIdSnapshot;
        throw error;
      }
    },
  });

  try {
    const stamp = Date.now();
    const workReq = {
      body: {
        message: `ska reservation completed ${stamp}`,
        team: 'ska',
        fromBot: 'ska-smoke',
        severity: 'info',
        alarmType: 'work',
        incidentKey: `smoke:work:${Date.now()}`,
      },
    };
    const workRes = makeRes();
    await alarmRoute(workReq, workRes);
    assert(workRes.statusCode === 200, `expected work alarm 200, got ${workRes.statusCode}`);
    assert(workRes.body.alarm_type === 'work', `expected work alarm type, got ${workRes.body.alarm_type}`);
    assert(workRes.body.visibility === 'notify', `expected notify visibility, got ${workRes.body.visibility}`);
    assert(workRes.body.delivery_team === 'ops-work', `expected ops-work delivery team, got ${workRes.body.delivery_team}`);
    assert(workRes.body.delivered === true, 'expected work alarm immediate delivery');
    assert(Number(sendCount) === 1, `expected one work telegram send, got ${sendCount}`);

    const reportReq = {
      body: {
        message: `daily readiness report ${stamp}`,
        team: 'blog',
        fromBot: 'blog-smoke',
        severity: 'info',
        alarmType: 'report',
        incidentKey: `smoke:report:${Date.now()}`,
      },
    };
    const reportRes = makeRes();
    await alarmRoute(reportReq, reportRes);
    assert(reportRes.statusCode === 200, `expected report alarm 200, got ${reportRes.statusCode}`);
    assert(reportRes.body.alarm_type === 'report', `expected report alarm type, got ${reportRes.body.alarm_type}`);
    assert(reportRes.body.visibility === 'notify', `expected report notify visibility, got ${reportRes.body.visibility}`);
    assert(reportRes.body.delivery_team === 'ops-reports', `expected ops-reports delivery team, got ${reportRes.body.delivery_team}`);
    assert(reportRes.body.delivered === true, 'expected report alarm immediate delivery');
    assert(Number(sendCount) === 2, `expected two telegram sends after report, got ${sendCount}`);

    const speedSkipReq = {
      body: {
        message: [
          '⚡ LLM 속도 테스트 결과',
          '',
          '⚠️ 실행 가능한 모델/인증이 없어 측정을 건너뜀',
          '',
          '❌ 실패: 0개',
        ].join('\n'),
        team: 'claude-lead',
        fromBot: 'speed-test',
        severity: 'info',
        eventType: 'speed-test_error',
        incidentKey: `smoke:speed-test-skip:${Date.now()}`,
        payload: { event_type: 'speed-test_error' },
      },
    };
    const speedSkipRes = makeRes();
    await alarmRoute(speedSkipReq, speedSkipRes);
    assert(speedSkipRes.statusCode === 200, `expected speed skip alarm 200, got ${speedSkipRes.statusCode}`);
    assert(speedSkipRes.body.alarm_type === 'report', `expected speed skip to route as report, got ${speedSkipRes.body.alarm_type}`);
    assert(speedSkipRes.body.actionability === 'none', `expected speed skip actionability none, got ${speedSkipRes.body.actionability}`);
    assert(speedSkipRes.body.auto_repair == null, 'speed skip report must not create auto_dev repair document');
    assert(Number(sendCount) === 2, `expected speed skip to avoid immediate delivery, got ${sendCount}`);

    const errorReq = {
      body: {
        message: `provider_cooldown error token=super-secret-token-${stamp}`,
        team: 'luna',
        fromBot: 'luna-smoke',
        severity: 'error',
        alarmType: 'error',
        incidentKey: `smoke:error:${Date.now()}`,
        payload: {
          access_token: `access-token-${stamp}`,
          write_scope: ['bots/investment', 'packages/core'],
        },
      },
    };
    const errorRes = makeRes();
    await alarmRoute(errorReq, errorRes);
    assert(errorRes.statusCode === 200, `expected error alarm 200, got ${errorRes.statusCode}`);
    assert(errorRes.body.alarm_type === 'error', `expected error alarm type, got ${errorRes.body.alarm_type}`);
    assert(errorRes.body.visibility === 'internal', `expected internal visibility for auto repair, got ${errorRes.body.visibility}`);
    assert(errorRes.body.actionability === 'auto_repair', `expected auto_repair, got ${errorRes.body.actionability}`);
    assert(errorRes.body.delivered === false, 'expected error auto-repair not to notify user directly');
    assert(errorRes.body.auto_repair?.ok === true, 'expected auto_dev repair document to be queued');
    assert(typeof errorRes.body.cluster_key === 'string' && errorRes.body.cluster_key.includes('llm_provider_cooldown'), 'expected provider cooldown cluster key');
    assert(Number(sendCount) === 2, `expected no direct telegram send for auto-repair error, got ${sendCount}`);
    const autoDevFiles = fs.readdirSync(autoDevDir).filter((file: string) => file.endsWith('.md'));
    assert(autoDevFiles.length === 1, `expected one auto_dev incident doc, got ${autoDevFiles.length}`);
    const autoDevDoc = fs.readFileSync(path.join(autoDevDir, autoDevFiles[0]), 'utf8');
    assert(autoDevDoc.includes('target_team: claude'), 'expected auto_dev doc to target claude');
    assert(autoDevDoc.includes('source_team: luna'), 'expected auto_dev doc to preserve source team');
    assert(autoDevDoc.includes(`incident_key: ${errorRes.body.incident_key}`), 'expected auto_dev doc to preserve incident key');
    assert(autoDevDoc.includes('## Council'), 'expected auto_dev doc to include agent council section');
    assert(!autoDevDoc.includes(`super-secret-token-${stamp}`), 'expected message token to be redacted');
    assert(!autoDevDoc.includes(`access-token-${stamp}`), 'expected payload token to be redacted');

    const similarErrorReq = {
      body: {
        message: `provider_cooldown error token=another-secret-${stamp}`,
        team: 'luna',
        fromBot: 'luna-smoke',
        severity: 'error',
        alarmType: 'error',
        incidentKey: `smoke:error-similar:${Date.now()}`,
        payload: {
          provider: 'openai-oauth',
          write_scope: ['bots/investment'],
        },
      },
    };
    useClusterDuplicate = true;
    const similarErrorRes = makeRes();
    await alarmRoute(similarErrorReq, similarErrorRes);
    useClusterDuplicate = false;
    assert(similarErrorRes.body.deduped === true, 'expected similar error to be deduped by cluster');
    assert(similarErrorRes.body.event_id === 999, 'expected cluster duplicate event id');

    mirrorExistingRows = [{
      id: 501,
      status: 'repairing',
      team: 'luna',
      actionability: 'auto_repair',
      metadata: {
        incident_key: errorRes.body.incident_key,
        event_id: String(errorRes.body.event_id),
      },
    }];
    const callbackReq = {
      body: {
        incidentKey: errorRes.body.incident_key,
        alarmEventId: errorRes.body.event_id,
        team: 'luna',
        status: 'resolved',
        summary: 'provider cooldown reset and verified',
        docPath: errorRes.body.auto_repair.path,
        changedFiles: ['bots/hub/lib/routes/alarm.ts'],
      },
    };
    const callbackRes = makeRes();
    await alarmAutoRepairCallbackRoute(callbackReq, callbackRes);
    assert(callbackRes.statusCode === 200, `expected callback 200, got ${callbackRes.statusCode}`);
    assert(callbackRes.body.status === 'resolved', `expected resolved callback, got ${callbackRes.body.status}`);
    assert(callbackRes.body.delivery_team === 'ops-error-resolution', `expected ops-error-resolution, got ${callbackRes.body.delivery_team}`);
    assert(callbackRes.body.delivered === true, 'expected callback result delivery');
    assert(callbackRes.body.mirror_update?.ok === true, 'expected callback to update hub alarm mirror');
    assert(callbackRes.body.mirror_update?.status === 'resolved', `expected mirror status resolved, got ${callbackRes.body.mirror_update?.status}`);
    assert(callbackRes.body.mirror_update?.updated === 1, `expected one mirror update, got ${callbackRes.body.mirror_update?.updated}`);
    assert(
      pgRuns.some((entry) => entry.sql.includes('FOR UPDATE')
        && entry.params.includes(errorRes.body.incident_key)
        && entry.params.includes(String(errorRes.body.event_id))),
      'expected auto-repair callback to lock the exact hub_alarms generation',
    );
    const callbackEvents = recordedEvents.filter((event) => event.eventType === 'hub_alarm_auto_repair_result');
    assert(callbackEvents.length === 1, `expected one callback result event, got ${callbackEvents.length}`);
    assert(
      String(callbackEvents[0].metadata?.alarm_event_id || '') === String(errorRes.body.event_id),
      'callback result event must retain the source alarm event id',
    );
    assert(callbackEvents[0].metadata?.callback_committed === 'true', 'callback result must be committed after mirror transition');
    assert(Number(sendCount) === 3, `expected callback to send one result notification, got ${sendCount}`);

    const duplicateCallbackRes = makeRes();
    await alarmAutoRepairCallbackRoute(callbackReq, duplicateCallbackRes);
    assert(duplicateCallbackRes.statusCode === 200, `expected duplicate callback 200, got ${duplicateCallbackRes.statusCode}`);
    assert(duplicateCallbackRes.body.delivery_deduped === true, 'duplicate callback must be delivery-idempotent');
    assert(
      recordedEvents.filter((event) => event.eventType === 'hub_alarm_auto_repair_result').length === 1,
      'duplicate callback must not create a second result event',
    );
    assert(Number(sendCount) === 3, 'duplicate callback must not resend Telegram');

    mirrorExistingRows = [];
    const failedCallbackRes = makeRes();
    await alarmAutoRepairCallbackRoute({
      body: {
        incidentKey: 'smoke:missing-mirror',
        alarmEventId: 'missing-generation',
        team: 'luna',
        status: 'resolved',
        summary: 'must not acknowledge a missing mirror transition',
      },
    }, failedCallbackRes);
    assert(failedCallbackRes.statusCode === 409, `expected missing mirror callback 409, got ${failedCallbackRes.statusCode}`);
    assert(failedCallbackRes.body.ok === false, 'missing mirror transition must not be acknowledged');
    assert(Number(sendCount) === 3, 'failed mirror transition must not send a resolved notification');

    const missingStatusRes = makeRes();
    await alarmAutoRepairCallbackRoute({
      body: {
        incidentKey: 'smoke:missing-status',
        alarmEventId: 'missing-status-generation',
      },
    }, missingStatusRes);
    assert(missingStatusRes.statusCode === 400, `expected missing callback status 400, got ${missingStatusRes.statusCode}`);
    assert(missingStatusRes.body.error === 'auto_repair_status_invalid', 'missing callback status must not default to resolved');

    mirrorExistingRows = [{
      id: 550,
      status: 'repairing',
      team: 'reservation',
      actionability: 'auto_repair',
      metadata: {
        incident_key: 'smoke:transaction-rollback',
        event_id: 'rollback-generation',
      },
    }];
    mirrorUpdateRowCount = 0;
    const callbackEventCountBeforeRollback = recordedEvents.filter((event) => event.eventType === 'hub_alarm_auto_repair_result').length;
    const rollbackRes = makeRes();
    await alarmAutoRepairCallbackRoute({
      body: {
        incidentKey: 'smoke:transaction-rollback',
        alarmEventId: 'rollback-generation',
        status: 'resolved',
        summary: 'mirror transition failure must roll back the result event',
      },
    }, rollbackRes);
    assert(rollbackRes.statusCode === 409, `expected mirror rollback callback 409, got ${rollbackRes.statusCode}`);
    assert(mirrorExistingRows[0].status === 'repairing', 'failed callback transaction must preserve active mirror status');
    assert(
      recordedEvents.filter((event) => event.eventType === 'hub_alarm_auto_repair_result').length === callbackEventCountBeforeRollback,
      'failed callback transaction must roll back its result event',
    );
    mirrorUpdateRowCount = 1;

    const reusedIncidentKey = 'smoke:reused-incident-key';
    mirrorExistingRows = [
      {
        id: 601,
        status: 'resolved',
        team: 'luna',
        actionability: 'auto_repair',
        metadata: {
          incident_key: reusedIncidentKey,
          event_id: 'old-generation',
          auto_repair_callback_status: 'resolved',
          auto_repair_callback_event_id: '777',
          auto_repair_callback_delivery_state: 'sent',
        },
      },
      {
        id: 602,
        status: 'repairing',
        team: 'luna',
        actionability: 'auto_repair',
        metadata: {
          incident_key: reusedIncidentKey,
          event_id: 'new-generation',
        },
      },
    ];
    recordedEvents.push({
      id: 777,
      eventType: 'hub_alarm_auto_repair_result',
      team: 'luna',
      metadata: {
        incident_key: reusedIncidentKey,
        alarm_event_id: 'old-generation',
        callback_committed: 'true',
      },
    });
    const staleGenerationCallbackRes = makeRes();
    await alarmAutoRepairCallbackRoute({
      body: {
        incidentKey: reusedIncidentKey,
        alarmEventId: 'old-generation',
        team: 'luna',
        status: 'resolved',
        summary: 'old terminal generation must not hide a newer active generation',
      },
    }, staleGenerationCallbackRes);
    assert(staleGenerationCallbackRes.statusCode === 200, 'completed old generation callback should remain idempotent');
    assert(staleGenerationCallbackRes.body.delivery_deduped === true, 'old generation result must remain delivery-idempotent');
    assert(mirrorExistingRows[1].status === 'repairing', 'old generation callback must not close the newer generation');
    assert(Number(sendCount) === 3, 'old generation callback must not resend a resolved notification');
    mirrorExistingRows = [];
    mirrorUpdateRowCount = 1;

    const digestReq = {
      body: {
        message: `warning alarm smoke ${stamp}`,
        team: 'luna',
        fromBot: 'luna-smoke',
        severity: 'warn',
        visibility: 'digest',
        incidentKey: `smoke:digest:${Date.now()}`,
      },
    };
    const digestRes = makeRes();
    await alarmRoute(digestReq, digestRes);
    assert(digestRes.statusCode === 200, `expected 200, got ${digestRes.statusCode}`);
    assert(digestRes.body.ok === true, 'expected ok=true');
    assert(digestRes.body.visibility === 'digest', `expected digest visibility, got ${digestRes.body.visibility}`);
    assert(digestRes.body.delivered === false, 'expected digest alarm not delivered immediately');
    assert(Number(sendCount) === 3, `expected no additional telegram send for digest, got ${sendCount}`);

    const humanReq = {
      body: {
        message: `approval needed ${stamp}`,
        team: 'luna',
        fromBot: 'luna-smoke',
        severity: 'warn',
        visibility: 'human_action',
        incidentKey: `smoke:human:${Date.now()}`,
      },
    };
    const humanRes = makeRes();
    await alarmRoute(humanReq, humanRes);
    assert(humanRes.statusCode === 200, `expected 200, got ${humanRes.statusCode}`);
    assert(humanRes.body.delivered === true, 'expected human_action immediate delivery');
    assert(Number(sendCount) === 4, `expected exactly four immediate telegram sends, got ${sendCount}`);

    const noisyReq = { query: { minutes: '60', limit: '5' } };
    const noisyRes = makeRes();
    await alarmNoisyProducersRoute(noisyReq, noisyRes);
    assert(noisyRes.statusCode === 200, `expected noisy route 200, got ${noisyRes.statusCode}`);
    assert(noisyRes.body.ok === true, 'expected noisy route ok');
    assert(Array.isArray(noisyRes.body.producers), 'expected noisy producers array');

    const suppressReq = {
      body: {
        minutes: 120,
        team: 'luna',
        fromBot: 'luna',
        visibility: 'digest',
        incidentKeyPrefix: 'luna|',
      },
    };
    const suppressRes = makeRes();
    await alarmSuppressDryRunRoute(suppressReq, suppressRes);
    assert(suppressRes.statusCode === 200, `expected suppress dry-run 200, got ${suppressRes.statusCode}`);
    assert(suppressRes.body.ok === true, 'expected suppress route ok');
    assert(suppressRes.body.dry_run === true, 'expected dry_run=true');

    const sendBeforeDryRun = sendCount;
    const runBeforeDryRun = pgRunCount;
    const digestDryRunReq = {
      body: {
        minutes: 60,
        limit: 20,
        dryRun: true,
      },
      query: {},
    };
    const digestDryRunRes = makeRes();
    await alarmDigestFlushRoute(digestDryRunReq, digestDryRunRes);
    assert(digestDryRunRes.statusCode === 200, `expected digest dry-run 200, got ${digestDryRunRes.statusCode}`);
    assert(digestDryRunRes.body.ok === true, 'expected digest dry-run ok');
    assert(digestDryRunRes.body.teams?.[0]?.dry_run === true, 'expected digest dry-run preview mode');
    assert(Number(sendCount) === sendBeforeDryRun, 'expected digest dry-run to avoid telegram send');
    assert(
      pgRunCount === runBeforeDryRun,
      'expected digest dry-run to avoid delivery state writes',
    );

    const digestFlushReq = {
      body: {
        minutes: 60,
        limit: 20,
      },
      query: {},
    };
    const sendBeforeFlush = sendCount;
    const digestFlushRes = makeRes();
    await alarmDigestFlushRoute(digestFlushReq, digestFlushRes);
    assert(digestFlushRes.statusCode === 200, `expected digest flush 200, got ${digestFlushRes.statusCode}`);
    assert(digestFlushRes.body.ok === true, 'expected digest flush ok');
    assert(Array.isArray(digestFlushRes.body.teams), 'expected digest flush team list');
    assert(digestFlushRes.body.teams[0]?.sent === true, 'expected digest flush delivered');
    assert(Number(sendCount) === sendBeforeFlush + 1, `expected digest flush to send exactly one telegram summary, got ${Number(sendCount) - sendBeforeFlush}`);

    const leaseIncidentKey = 'smoke:callback-delivery-lease';
    const leaseAlarmEventId = 'lease-generation';
    const leaseCallbackEventId = ++eventId;
    recordedEvents.push({
      id: leaseCallbackEventId,
      eventType: 'hub_alarm_auto_repair_result',
      team: 'reservation',
      metadata: {
        incident_key: leaseIncidentKey,
        alarm_event_id: leaseAlarmEventId,
        callback_committed: 'true',
      },
    });
    mirrorExistingRows = [{
      id: 701,
      status: 'resolved',
      team: 'reservation',
      actionability: 'auto_repair',
      metadata: {
        incident_key: leaseIncidentKey,
        event_id: leaseAlarmEventId,
        auto_repair_callback_status: 'resolved',
        auto_repair_callback_event_id: String(leaseCallbackEventId),
        auto_repair_callback_delivery_state: 'sending',
        auto_repair_callback_delivery_started_at: new Date().toISOString(),
      },
    }];
    const sendBeforeLease = sendCount;
    const activeLeaseRes = makeRes();
    await alarmAutoRepairCallbackRoute({
      body: {
        incidentKey: leaseIncidentKey,
        alarmEventId: leaseAlarmEventId,
        status: 'resolved',
        summary: 'active delivery lease must not be acknowledged as delivered',
      },
    }, activeLeaseRes);
    assert(activeLeaseRes.statusCode === 503, 'active delivery lease must remain retryable');
    assert(activeLeaseRes.body.delivery_ambiguous === true, 'active delivery lease must be reported as ambiguous');
    assert(Number(activeLeaseRes.body.retry_after_ms) > 0, 'active delivery lease must expose retry_after_ms');
    assert(Number(activeLeaseRes.body.retry_after_ms) <= 60 * 60 * 1000, 'clock skew must not exceed the configured lease ceiling');
    assert(Number(sendCount) === sendBeforeLease, 'active delivery lease must not send concurrently');

    mirrorExistingRows[0].metadata.auto_repair_callback_delivery_started_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const expiredLeaseRes = makeRes();
    await alarmAutoRepairCallbackRoute({
      body: {
        incidentKey: leaseIncidentKey,
        alarmEventId: leaseAlarmEventId,
        status: 'resolved',
        summary: 'expired delivery lease must be reclaimed',
      },
    }, expiredLeaseRes);
    assert(expiredLeaseRes.statusCode === 200, 'expired delivery lease must be reclaimed');
    assert(expiredLeaseRes.body.delivered === true, 'reclaimed delivery lease must complete delivery');
    assert(Number(sendCount) === sendBeforeLease + 1, 'expired delivery lease must send exactly once');

    console.log('alarm_governor_smoke_ok');
  } finally {
    _testOnly_resetAlarmEventLakeMocks();
    _testOnly_resetAlarmRouteDbMocks();
    global.fetch = originals.fetch;
    if (originals.tgToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originals.tgToken;
    if (originals.tgChatId == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originals.tgChatId;
    if (originals.tgAlertsDisabled == null) delete process.env.TELEGRAM_ALERTS_DISABLED;
    else process.env.TELEGRAM_ALERTS_DISABLED = originals.tgAlertsDisabled;
    if (originals.autoDevDir == null) delete process.env.HUB_ALARM_AUTO_DEV_DIR;
    else process.env.HUB_ALARM_AUTO_DEV_DIR = originals.autoDevDir;
    if (originals.classTopics == null) delete process.env.HUB_ALARM_USE_CLASS_TOPICS;
    else process.env.HUB_ALARM_USE_CLASS_TOPICS = originals.classTopics;
    fs.rmSync(autoDevDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[alarm-governor-smoke] failed:', error?.message || error);
  process.exit(1);
});
