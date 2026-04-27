const {
  alarmRoute,
  alarmNoisyProducersRoute,
  alarmSuppressDryRunRoute,
  alarmDigestFlushRoute,
} = require('../lib/routes/alarm.ts');
const eventLake = require('../../../packages/core/lib/event-lake');
const pgPool = require('../../../packages/core/lib/pg-pool');
const fs = require('fs');
const os = require('os');
const path = require('path');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeRes() {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return payload;
    },
  };
  return response;
}

async function main() {
  const originals = {
    findRecentDuplicateAlarm: eventLake.findRecentDuplicateAlarm,
    record: eventLake.record,
    pgQuery: pgPool.query,
    pgGet: pgPool.get,
    pgRun: pgPool.run,
    fetch: global.fetch,
    tgToken: process.env.TELEGRAM_BOT_TOKEN,
    tgChatId: process.env.TELEGRAM_CHAT_ID,
    tgAlertsDisabled: process.env.TELEGRAM_ALERTS_DISABLED,
    autoDevDir: process.env.HUB_ALARM_AUTO_DEV_DIR,
  };

  let sendCount = 0;
  let eventId = 100;
  let pgRunCount = 0;
  const autoDevDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-alarm-auto-dev-'));

  eventLake.findRecentDuplicateAlarm = async () => null;
  eventLake.record = async () => {
    eventId += 1;
    return eventId;
  };
  process.env['TELEGRAM_' + 'BOT_TOKEN'] = 'alarm-governor-smoke-fixture';
  process.env.TELEGRAM_CHAT_ID = '123456';
  process.env.TELEGRAM_ALERTS_DISABLED = 'false';
  process.env.HUB_ALARM_AUTO_DEV_DIR = autoDevDir;
  global.fetch = async (url) => {
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
  pgPool.query = async (_schema, sql) => {
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
  };
  pgPool.get = async (_schema, sql) => {
    if (String(sql).includes('COUNT(*)::int AS total')) return { total: 3 };
    return null;
  };
  pgPool.run = async () => {
    pgRunCount += 1;
    return { rowCount: 1, rows: [] };
  };

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
    assert(workRes.body.delivered === true, 'expected work alarm immediate delivery');
    assert(sendCount === 1, `expected one work telegram send, got ${sendCount}`);

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
    assert(reportRes.body.delivered === true, 'expected report alarm immediate delivery');
    assert(sendCount === 2, `expected two telegram sends after report, got ${sendCount}`);

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
    assert(sendCount === 2, `expected no direct telegram send for auto-repair error, got ${sendCount}`);
    const autoDevFiles = fs.readdirSync(autoDevDir).filter((file) => file.endsWith('.md'));
    assert(autoDevFiles.length === 1, `expected one auto_dev incident doc, got ${autoDevFiles.length}`);
    const autoDevDoc = fs.readFileSync(path.join(autoDevDir, autoDevFiles[0]), 'utf8');
    assert(autoDevDoc.includes('target_team: claude'), 'expected auto_dev doc to target claude');
    assert(autoDevDoc.includes('## Council'), 'expected auto_dev doc to include agent council section');
    assert(!autoDevDoc.includes(`super-secret-token-${stamp}`), 'expected message token to be redacted');
    assert(!autoDevDoc.includes(`access-token-${stamp}`), 'expected payload token to be redacted');

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
    assert(sendCount === 2, `expected no additional telegram send for digest, got ${sendCount}`);

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
    assert(sendCount === 3, `expected exactly three immediate telegram sends, got ${sendCount}`);

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
    assert(sendCount === sendBeforeDryRun, 'expected digest dry-run to avoid telegram send');
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
    const digestFlushRes = makeRes();
    await alarmDigestFlushRoute(digestFlushReq, digestFlushRes);
    assert(digestFlushRes.statusCode === 200, `expected digest flush 200, got ${digestFlushRes.statusCode}`);
    assert(digestFlushRes.body.ok === true, 'expected digest flush ok');
    assert(Array.isArray(digestFlushRes.body.teams), 'expected digest flush team list');
    assert(digestFlushRes.body.teams[0]?.sent === true, 'expected digest flush delivered');
    assert(sendCount >= 4, `expected digest flush to send telegram summary, got ${sendCount}`);

    console.log('alarm_governor_smoke_ok');
  } finally {
    eventLake.findRecentDuplicateAlarm = originals.findRecentDuplicateAlarm;
    eventLake.record = originals.record;
    pgPool.query = originals.pgQuery;
    pgPool.get = originals.pgGet;
    pgPool.run = originals.pgRun;
    global.fetch = originals.fetch;
    if (originals.tgToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originals.tgToken;
    if (originals.tgChatId == null) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originals.tgChatId;
    if (originals.tgAlertsDisabled == null) delete process.env.TELEGRAM_ALERTS_DISABLED;
    else process.env.TELEGRAM_ALERTS_DISABLED = originals.tgAlertsDisabled;
    if (originals.autoDevDir == null) delete process.env.HUB_ALARM_AUTO_DEV_DIR;
    else process.env.HUB_ALARM_AUTO_DEV_DIR = originals.autoDevDir;
    fs.rmSync(autoDevDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[alarm-governor-smoke] failed:', error?.message || error);
  process.exit(1);
});
