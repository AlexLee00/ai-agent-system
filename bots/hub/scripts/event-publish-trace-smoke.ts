#!/usr/bin/env tsx
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  eventsPublishRoute,
  resolvePublishedEventTraceId,
  drainEventsPublishSpool,
  _testOnly_setEventsRouteEventLakeMocks,
  _testOnly_resetEventsRouteEventLakeMocks,
} = require('../lib/routes/events.ts');

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`[event-publish-trace-smoke] ${message}`);
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

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-event-publish-spool-'));
  const previousSpoolFile = process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE;
  process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE = path.join(tempDir, 'events-spool.jsonl');

  const records: any[] = [];
  _testOnly_setEventsRouteEventLakeMocks({
    record: async (payload: any) => {
      records.push(payload);
      return 101;
    },
  });

  try {
    assert(
      resolvePublishedEventTraceId({ payload: { traceId: 'payload-trace-1' } }) === 'payload-trace-1',
      'payload.traceId should be promoted',
    );
    assert(
      resolvePublishedEventTraceId({}, { headers: { 'x-trace-id': 'header-trace-1' } }) === 'header-trace-1',
      'explicit x-trace-id should be promoted',
    );
    assert(
      resolvePublishedEventTraceId({ source: 'luna.tradingview', topic: 'luna.tv.bar.BTCUSDT.60' }) === '',
      'untraced market-data bars must not receive synthetic trace ids',
    );

    const res = makeRes();
    await eventsPublishRoute({
      headers: {},
      body: {
        source: 'luna.agent',
        topic: 'luna.decision.review',
        payload: { traceId: 'payload-trace-2', decision: 'hold' },
      },
    }, res);

    assert(res.statusCode === 200, 'publish route should return 200');
    assert(records.length === 1, 'expected one eventLake record');
    assert(records[0].traceId === 'payload-trace-2', 'route must persist promoted traceId');

    _testOnly_setEventsRouteEventLakeMocks({
      record: async () => {
        throw new Error('simulated_event_lake_timeout');
      },
    });

    const spooledRes = makeRes();
    await eventsPublishRoute({
      headers: {},
      body: {
        source: 'luna.agent',
        topic: 'luna.decision.spool',
        payload: { traceId: 'payload-trace-3', decision: 'hold' },
      },
    }, spooledRes);

    assert(spooledRes.statusCode === 202, 'publish route should accept and spool transient eventLake failures');
    assert(spooledRes.body?.queued === true, 'spooled response should be marked queued');
    assert(fs.existsSync(process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE), 'spooled event should be persisted to local JSONL');

    const replayed: any[] = [];
    _testOnly_setEventsRouteEventLakeMocks({
      record: async (payload: any) => {
        replayed.push(payload);
        return 202;
      },
    });

    const drain = await drainEventsPublishSpool({ spoolFile: process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE, limit: 10 });
    assert(drain.drained === 1, `expected one spooled event to drain, got ${JSON.stringify(drain)}`);
    assert(replayed.length === 1, 'expected one replayed eventLake record');
    assert(replayed[0].traceId === 'payload-trace-3', 'drained event must preserve traceId');
    assert(!fs.existsSync(process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE), 'empty spool file should be removed after drain');
  } finally {
    _testOnly_resetEventsRouteEventLakeMocks();
    if (previousSpoolFile == null) delete process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE;
    else process.env.HUB_EVENTS_PUBLISH_SPOOL_FILE = previousSpoolFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('event_publish_trace_smoke_ok');
}

main().catch((error) => {
  console.error('[event-publish-trace-smoke] failed:', error?.message || error);
  process.exit(1);
});
