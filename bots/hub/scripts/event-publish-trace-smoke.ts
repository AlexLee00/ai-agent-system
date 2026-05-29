#!/usr/bin/env tsx
'use strict';

const {
  eventsPublishRoute,
  resolvePublishedEventTraceId,
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
  } finally {
    _testOnly_resetEventsRouteEventLakeMocks();
  }

  console.log('event_publish_trace_smoke_ok');
}

main().catch((error) => {
  console.error('[event-publish-trace-smoke] failed:', error?.message || error);
  process.exit(1);
});
