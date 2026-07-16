#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  BRIDGE_UNIVERSE_WEEKLY_REPORT_SQL,
  buildLunaPhase5BridgeUniverseReport,
  parseLunaReportTimestamp,
  runLunaPhase5BridgeUniverseReport,
} from './luna-phase5-bridge-universe-report.ts';

const AS_OF = new Date('2026-07-15T15:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function bridgeRow(id, observedAt, overrides = {}) {
  return {
    id: String(id),
    skill_id: `skill-${id}`,
    mcp_tool_name: `tool-${id}`,
    status: 'shadow_read_only_ready',
    direct_trade_allowed: false,
    protected_policy: 'no_live_trade_no_protected_restart_no_secret_change',
    capability: { writeMode: 'read_only_or_shadow_only' },
    evidence: { liveMutation: false },
    observed_at: observedAt,
    ...overrides,
  };
}

function universeRow(id, selectedAt, symbols, overrides = {}) {
  return {
    id: String(id),
    selected_at: selectedAt,
    regime: 'RANGING',
    exchange: 'binance',
    axis_weights: { volume: 0.5, cap: 0.3, sector: 0.2 },
    selected_symbols: symbols.map((symbol, index) => ({ symbol, score: 1 - index / 10 })),
    universe_size: symbols.length,
    shadow_only: true,
    ...overrides,
  };
}

function fixtureRows() {
  const bridgeRows = [];
  let id = 1;
  for (let day = 0; day < 7; day += 1) {
    bridgeRows.push(bridgeRow(id++, new Date(AS_OF.getTime() - (14 - day) * DAY_MS + 60_000)));
  }
  for (let day = 0; day < 7; day += 1) {
    const rowsForDay = day === 6 ? 20 : 1;
    for (let row = 0; row < rowsForDay; row += 1) {
      bridgeRows.push(bridgeRow(id++, new Date(AS_OF.getTime() - (7 - day) * DAY_MS + 60_000 + row * 1_000)));
    }
  }

  const duplicateTime = new Date(AS_OF.getTime() - 2 * DAY_MS);
  bridgeRows.push(bridgeRow('900', duplicateTime, {
    skill_id: 'duplicate-skill',
    mcp_tool_name: 'duplicate-tool',
  }));
  bridgeRows.push(bridgeRow('901', duplicateTime, {
    skill_id: 'duplicate-skill',
    mcp_tool_name: 'duplicate-tool',
    status: 'unexpected_live_ready',
    direct_trade_allowed: true,
  }));
  bridgeRows.push(bridgeRow('invalid-missing-date', null));
  bridgeRows.push(bridgeRow('invalid-calendar', '2026-02-30T00:00:00.000Z'));

  const universeRows = [
    universeRow('1', new Date('2026-07-02T23:30:00.000Z'), ['BTC/USDT', 'ETH/USDT']),
    universeRow('2', new Date('2026-07-03T23:30:00.000Z'), ['BTC/USDT', 'ETH/USDT']),
    universeRow('3', new Date('2026-07-08T23:30:00.000Z'), ['BTC/USDT', 'ETH/USDT']),
    universeRow('4', new Date('2026-07-09T23:30:00.000Z'), ['BTC/USDT', 'XRP/USDT']),
    universeRow('5', new Date('2026-07-09T23:30:00.000Z'), ['BTC/USDT', 'SOL/USDT']),
    universeRow('6', new Date('2026-07-14T23:30:00.000Z'), ['BTC/USDT', 'SOL/USDT', 'SOL/USDT'], {
      selected_symbols: [
        { symbol: 'BTC/USDT', score: 1.2 },
        { symbol: 'SOL/USDT', score: 0.8 },
        { symbol: 'SOL/USDT', score: 0.7 },
      ],
    }),
    universeRow('invalid-date', undefined, ['BTC/USDT']),
  ];
  return { bridgeRows, universeRows };
}

async function main() {
  assert.match(BRIDGE_UNIVERSE_WEEKLY_REPORT_SQL, /^\s*SELECT\b/i);
  assert.doesNotMatch(BRIDGE_UNIVERSE_WEEKLY_REPORT_SQL, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);

  assert.equal(parseLunaReportTimestamp(null), null);
  assert.equal(parseLunaReportTimestamp(''), null);
  assert.equal(parseLunaReportTimestamp('2026-02-30T00:00:00.000Z'), null);
  assert.equal(parseLunaReportTimestamp('2026-99-99T00:00:00.000Z'), null);
  assert.equal(parseLunaReportTimestamp(new Date('2026-07-15T00:00:00.000Z'))?.toISOString(), '2026-07-15T00:00:00.000Z');

  const { bridgeRows, universeRows } = fixtureRows();
  const report = buildLunaPhase5BridgeUniverseReport(bridgeRows, universeRows, {
    asOf: AS_OF,
    minPeriodRows: 2,
  });

  assert.equal(report.contract.readOnly, true);
  assert.equal(report.contract.timeZone, 'Asia/Seoul');
  assert.equal(report.bridge.comparison.status, 'sufficient');
  assert.equal(report.bridge.comparison.eventCountDirection, 'up');
  assert.equal(report.bridge.audit.duplicateRows, 1);
  assert.equal(report.bridge.audit.conflictingDuplicateKeys, 1);
  assert.equal(report.bridge.audit.invalidByReason.invalidObservedAt, 2);
  assert.equal(report.bridge.anomalies.patterns.directTradeAllowed, 1);
  assert.equal(report.bridge.dailyVolume.outlierDays.includes('2026-07-15'), true);
  assert.equal(report.bridge.dailyVolume.partialBoundaryDaysExcluded, 0);

  assert.equal(report.universe.comparison.status, 'sufficient');
  assert.equal(report.universe.audit.duplicateRows, 1);
  assert.equal(report.universe.audit.conflictingDuplicateKeys, 1);
  assert.equal(report.universe.audit.invalidByReason.invalidSelectedAt, 1);
  assert.equal(report.universe.audit.duplicateSymbols, 1);
  assert.equal(report.universe.audit.universeSizeMismatches, 1);
  assert.equal(report.universe.audit.invalidSelectionScores, 1);
  assert.deepEqual(report.universe.gaps.expectedDates, [
    '2026-07-09',
    '2026-07-10',
    '2026-07-11',
    '2026-07-12',
    '2026-07-13',
    '2026-07-14',
    '2026-07-15',
  ]);
  assert.deepEqual(report.universe.gaps.missingDates, [
    '2026-07-11',
    '2026-07-12',
    '2026-07-13',
    '2026-07-14',
  ]);
  assert.equal(report.universe.selectionChanges.changedTransitions > 0, true);
  assert.equal(report.boundaryChecklist.length, 9);
  assert.deepEqual(report.boundaryChecklist.map((item) => item.check), [
    'unit_contract',
    'duplicate_key',
    'outlier_isolation',
    'direction',
    'partial_event',
    'concurrency',
    'initial_state',
    'raw_sample',
    'date_time_contract',
  ]);
  assert.equal(report.boundaryChecklist.find((item) => item.check === 'unit_contract').status, 'attention');

  const reversed = buildLunaPhase5BridgeUniverseReport(
    [...bridgeRows].reverse(),
    [...universeRows].reverse(),
    { asOf: AS_OF, minPeriodRows: 2 },
  );
  assert.deepEqual(reversed.bridge.audit, report.bridge.audit);
  assert.deepEqual(reversed.bridge.recent, report.bridge.recent);
  assert.deepEqual(reversed.universe.latestByExchange, report.universe.latestByExchange);
  assert.deepEqual(reversed.universe.selectionChanges, report.universe.selectionChanges);

  const empty = buildLunaPhase5BridgeUniverseReport([], [], { asOf: AS_OF });
  assert.equal(empty.bridge.comparison.status, 'insufficient');
  assert.equal(empty.universe.comparison.status, 'insufficient');
  assert.deepEqual(empty.universe.gaps.missingDates, empty.universe.gaps.expectedDates);

  const queries = [];
  const viaRunner = await runLunaPhase5BridgeUniverseReport({
    asOf: AS_OF,
    minPeriodRows: 2,
  }, {
    query: async (sql, params) => {
      queries.push({ sql, params });
      assert.equal(sql, BRIDGE_UNIVERSE_WEEKLY_REPORT_SQL);
      return [
        ...bridgeRows.map((row) => ({
          source_kind: 'bridge',
          source_id: row.id,
          event_at: row.observed_at,
          skill_id: row.skill_id,
          mcp_tool_name: row.mcp_tool_name,
          bridge_status: row.status,
          direct_trade_allowed: row.direct_trade_allowed,
          protected_policy: row.protected_policy,
          capability: row.capability,
          evidence: row.evidence,
        })),
        ...universeRows.map((row) => ({
          source_kind: 'universe',
          source_id: row.id,
          event_at: row.selected_at,
          regime: row.regime,
          exchange: row.exchange,
          axis_weights: row.axis_weights,
          selected_symbols: row.selected_symbols,
          universe_size: row.universe_size,
          shadow_only: row.shadow_only,
        })),
      ];
    },
  });
  assert.equal(queries.length, 1);
  assert.equal(queries.every(({ params }) => params.length === 2 && params.every((value) => value instanceof Date)), true);
  assert.equal(viaRunner.bridge.audit.rawRows, report.bridge.audit.rawRows);

  console.log(JSON.stringify({
    smoke: 'luna-phase5-bridge-universe-report',
    boundaryGroups: report.boundaryChecklist.length,
    bridgeRows: report.bridge.audit.rawRows,
    universeRows: report.universe.audit.rawRows,
    status: 'pass',
  }, null, 2));
}

await main();
