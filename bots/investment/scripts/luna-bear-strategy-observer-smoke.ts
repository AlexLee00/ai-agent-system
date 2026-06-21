#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  DEFAULT_HISTORY_PATH,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_STATE_PATH,
  filterBearRows,
  runLunaBearStrategyObserver,
} from './luna-bear-strategy-observer.ts';
import { getOpsSchedulerJobs } from './runtime-luna-ops-scheduler.ts';

const since = '2026-06-20 20:30:00+09';
const afterSince = Date.parse('2026-06-20T21:00:00+09:00');

function row(overrides = {}) {
  return {
    id: overrides.id || Math.random().toString(36).slice(2),
    exchange: 'binance',
    is_paper: false,
    exclude_from_learning: false,
    market_regime: 'TRENDING_BEAR',
    strategy_family: 'mean_reversion',
    trade_mode: null,
    entry_time: afterSince,
    exit_time: afterSince + 60_000,
    ...overrides,
  };
}

function memoryFs(initialState = null) {
  const files = {};
  if (initialState) files[DEFAULT_STATE_PATH] = JSON.stringify(initialState);
  return {
    files,
    existsSync: (filePath) => Object.hasOwn(files, filePath),
    readFile: (filePath) => files[filePath],
    writeFile: (filePath, content) => {
      files[filePath] = String(content);
    },
    appendFile: (filePath, content) => {
      files[filePath] = `${files[filePath] || ''}${String(content)}`;
    },
  };
}

async function runFixture(rows, previousState, extra = {}) {
  const fsMock = memoryFs(previousState);
  const alerts = [];
  const result = await runLunaBearStrategyObserver({
    since,
    minSample: 3,
    now: new Date('2026-06-21T00:00:00.000Z'),
    noNotify: extra.noNotify || false,
  }, {
    query: async () => rows,
    notify: async (message) => {
      alerts.push(message);
      return { ok: true };
    },
    ...fsMock,
  });
  return { result, alerts, files: fsMock.files };
}

async function main() {
  const waiting = await runFixture([], { lastStatus: 'waiting', lastSample: 0 });
  assert.equal(waiting.result.status, 'waiting');
  assert.equal(waiting.result.changed, false);
  assert.equal(waiting.result.alerted, false);
  assert.equal(waiting.alerts.length, 0);

  const convertedRows = [
    ...Array.from({ length: 5 }, (_, i) => row({ id: `mr-${i}`, strategy_family: 'mean_reversion' })),
    row({ id: 'def-1', strategy_family: 'defensive_rotation' }),
  ];
  const converted = await runFixture(convertedRows, { lastStatus: 'observing', lastSample: 2 });
  assert.equal(converted.result.status, 'converted');
  assert.equal(converted.result.changed, true);
  assert.equal(converted.result.alerted, true);
  assert.equal(converted.alerts.length, 1);
  assert.equal(converted.result.meanReversionCount, 5);
  assert.equal(converted.result.defensiveCount, 1);

  const notConvertedRows = [
    ...Array.from({ length: 5 }, (_, i) => row({ id: `def-${i}`, strategy_family: 'defensive_rotation' })),
    row({ id: 'mr-1', strategy_family: 'mean_reversion' }),
  ];
  const notConverted = await runFixture(notConvertedRows, { lastStatus: 'observing', lastSample: 2 });
  assert.equal(notConverted.result.status, 'not_converted');
  assert.equal(notConverted.result.changed, true);
  assert.equal(notConverted.result.alerted, true);
  assert.equal(notConverted.alerts.length, 1);

  const noChange = await runFixture(convertedRows, { lastStatus: 'converted', lastSample: 6 });
  assert.equal(noChange.result.status, 'converted');
  assert.equal(noChange.result.changed, false);
  assert.equal(noChange.result.alerted, false);
  assert.equal(noChange.alerts.length, 0);

  const mixedRows = [
    row({ id: 'valid', strategy_family: 'mean_reversion' }),
    row({ id: 'paper', is_paper: true }),
    row({ id: 'excluded', exclude_from_learning: true }),
    row({ id: 'other-exchange', exchange: 'kis' }),
    row({ id: 'bull', market_regime: 'TRENDING_BULL' }),
    row({ id: 'before', entry_time: Date.parse('2026-06-20T19:00:00+09:00') }),
    row({ id: 'fallback-family', strategy_family: '', trade_mode: 'defensive_rotation' }),
  ];
  const filtered = filterBearRows(mixedRows, { sinceMs: Date.parse('2026-06-20T20:30:00+09:00') });
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((item) => item.id).sort(), ['fallback-family', 'valid']);

  const paths = Object.keys(converted.files).sort();
  assert.ok(paths.includes(DEFAULT_STATE_PATH));
  assert.ok(paths.includes(DEFAULT_HISTORY_PATH));
  assert.ok(paths.some((item) => item === `${DEFAULT_OUTPUT_DIR}/luna-bear-observer-20260621.json`));
  assert.ok(paths.some((item) => item === `${DEFAULT_OUTPUT_DIR}/luna-bear-observer-20260621.md`));
  for (const filePath of paths) {
    assert.ok(
      filePath.startsWith('/tmp/luna-bear-observer-'),
      `observer output must stay under /tmp/luna-bear-observer-*, got ${filePath}`,
    );
  }

  const observerJob = getOpsSchedulerJobs().find((job) => job.name === 'bear_strategy_observer');
  assert.ok(observerJob, 'bear_strategy_observer job should be registered');
  assert.equal(observerJob.category, 'observability');
  assert.equal(observerJob.market, 'crypto');
  assert.deepEqual(observerJob.cadence, { type: 'interval', seconds: 21600 });
  assert.ok(observerJob.args.includes('--json'));
  assert.match(observerJob.args.join(' '), /luna-bear-strategy-observer\.ts/);

  const result = {
    ok: true,
    smoke: 'luna-bear-strategy-observer',
    scenarios: {
      waitingNoAlert: true,
      convertedAlert: true,
      notConvertedAlert: true,
      noChangeNoAlert: true,
      sourceFiltering: true,
      tmpOutputOnly: true,
      schedulerJob: true,
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna bear strategy observer smoke ok');
}

main().catch((error) => {
  console.error('❌ luna-bear-strategy-observer-smoke 실패:', error);
  process.exitCode = 1;
});

