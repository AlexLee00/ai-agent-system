#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM,
  runExpectedFireWatchdog,
  _testOnly as watchdogTestOnly,
} from '../shared/luna-expected-fire-watchdog.ts';
import { buildMeetingPlanNote } from '../services/meeting-room/server/adapters/stack-adapter.ts';
import {
  LUNA_MEETING_ROOM_L_CONFIRM,
  runMeetingRoomLOps,
} from '../services/meeting-room/server/meeting-room-l-ops.ts';
import { parseMeetingRoomLOpsCliArgs } from './runtime-luna-meeting-room-l.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixedNow() {
  return '2026-06-19T09:00:00.000Z';
}

function triggerRow(overrides: any = {}) {
  return {
    id: overrides.id || 'trigger-silent-1',
    symbol: overrides.symbol || '005930',
    exchange: overrides.exchange || 'kis',
    setup_type: overrides.setup_type || 'promotion_ready_shadow',
    trigger_state: overrides.trigger_state || 'expired',
    confidence: overrides.confidence ?? 0.71,
    predictive_score: overrides.predictive_score ?? 0.68,
    expires_at: overrides.expires_at || '2026-06-19T08:20:00.000Z',
    fired_at: overrides.fired_at || null,
    trigger_meta: {
      lastReadyAt: overrides.lastReadyAt || '2026-06-19T08:00:00.000Z',
      reason: overrides.reason || 'ready_but_not_fired_watchdog_fixture',
      terminalBlock: overrides.terminalBlock === true,
      ...(overrides.trigger_meta || {}),
    },
    trigger_context: {},
  };
}

function watchdogQueryFixture({ triggers = [], matchBySymbol = {}, pruneCount = 0 } = {}) {
  return async (sql: string, params: any[] = []) => {
    if (/FROM entry_triggers/i.test(sql)) return triggers;
    if (/FROM trades/i.test(sql) && /FROM trade_journal/i.test(sql) && /FROM positions/i.test(sql)) {
      const symbol = params[0];
      const match = matchBySymbol[symbol] || {};
      return [{
        trade_match: match.source === 'trades',
        journal_match: match.source === 'trade_journal',
        position_match: match.source === 'positions',
      }];
    }
    if (/COUNT\(\*\)::int AS count/i.test(sql) && /FROM luna_silent_miss_log/i.test(sql)) {
      return [{ count: pruneCount }];
    }
    return [];
  };
}

function lOpsQueryFixture({ silentMisses = [], existingAgendaKeys = [] } = {}) {
  return async (sql: string) => {
    if (/FROM luna_silent_miss_log/i.test(sql)) return silentMisses;
    if (/FROM luna_meeting_decisions/i.test(sql) && /agenda_key = ANY/i.test(sql)) {
      return existingAgendaKeys.map((agenda_key: string) => ({ agenda_key }));
    }
    if (/FROM luna_meeting_sessions/i.test(sql)) return [];
    if (/FROM luna_meeting_decisions/i.test(sql)) return [];
    if (/FROM luna_circuit_locks/i.test(sql)) return [];
    if (/FROM circuit_breaker_events/i.test(sql)) return [];
    if (/FROM hmm_regime_log/i.test(sql)) return [];
    if (/FROM corp_disclosures/i.test(sql)) return [];
    if (/FROM performance_daily/i.test(sql)) return [];
    if (/FROM risk_log/i.test(sql)) return [];
    if (/FROM luna_risk_simulation_shadow/i.test(sql)) return [];
    return [];
  };
}

async function main() {
  assert.equal(watchdogTestOnly.isNormalBlockReason('conditions_not_met'), true);
  assert.equal(watchdogTestOnly.isNormalBlockReason('outside_binance_top_volume_universe'), true);
  assert.equal(watchdogTestOnly.isNormalBlockReason('outside_binance_top30_volume_universe'), true);
  assert.equal(watchdogTestOnly.isNormalBlockReason('ready_but_not_fired_watchdog_fixture'), false);

  const silentTrigger = triggerRow();
  assert.equal(
    watchdogTestOnly.normalizeExpectedFireTriggerRow(silentTrigger).expiredAt,
    '2026-06-19T08:20:00.000Z',
  );
  const terminalTrigger = triggerRow({ id: 'terminal', terminalBlock: true, reason: 'non_whitelist_terminal' });
  const whitelistTrigger = triggerRow({ id: 'whitelist', reason: 'conditions_not_met' });
  const firedTrigger = triggerRow({ id: 'fired', fired_at: '2026-06-19T08:10:00.000Z', reason: 'entry_trigger_fired' });
  const dry = await runExpectedFireWatchdog({
    dryRun: true,
    now: fixedNow(),
    limit: 10,
  }, {
    queryFn: watchdogQueryFixture({ triggers: [silentTrigger, terminalTrigger, whitelistTrigger, firedTrigger] }),
  });
  assert.equal(dry.ok, true);
  assert.equal(dry.candidates, 1);
  assert.equal(dry.silentMisses, 1);
  assert.equal(dry.matched, 0);
  assert.equal(dry.written, 0);
  assert.equal(dry.rows[0].triggerId, silentTrigger.id);
  assert.equal(dry.rows[0].matched, false);
  assert.equal(dry.placed, 0);
  assert.equal(dry.liveMutation, false);

  let expiryWindowEndAt: string | null = null;
  const expiryWindow = await runExpectedFireWatchdog({
    dryRun: true,
    now: fixedNow(),
    limit: 10,
    matchWindowMinutes: 30,
  }, {
    queryFn: async (sql: string, params: any[] = []) => {
      if (/FROM entry_triggers/i.test(sql)) {
        return [triggerRow({
          id: 'expiry-window',
          symbol: 'WINDOW',
          lastReadyAt: '2026-06-19T08:00:00.000Z',
          expires_at: '2026-06-19T08:50:00.000Z',
        })];
      }
      if (/FROM trades/i.test(sql) && /FROM trade_journal/i.test(sql) && /FROM positions/i.test(sql)) {
        expiryWindowEndAt = params[3];
        return [{ trade_match: true, journal_match: false, position_match: false }];
      }
      if (/COUNT\(\*\)::int AS count/i.test(sql) && /FROM luna_silent_miss_log/i.test(sql)) return [{ count: 0 }];
      return [];
    },
  });
  assert.equal(expiryWindowEndAt, '2026-06-19T09:20:00.000Z');
  assert.equal(expiryWindow.matched, 1);
  assert.equal(expiryWindow.silentMisses, 0);

  const matched = await runExpectedFireWatchdog({
    dryRun: true,
    now: fixedNow(),
    limit: 10,
  }, {
    queryFn: watchdogQueryFixture({
      triggers: [triggerRow({ id: 'matched', symbol: 'AAPL', exchange: 'kis_overseas' })],
      matchBySymbol: { AAPL: { source: 'trades' } },
    }),
  });
  assert.equal(matched.candidates, 1);
  assert.equal(matched.matched, 1);
  assert.equal(matched.silentMisses, 0);
  assert.equal(matched.rows[0].matchedSource, 'trades');

  const blocked = await runExpectedFireWatchdog({
    apply: true,
    dryRun: false,
    now: fixedNow(),
  }, {
    queryFn: watchdogQueryFixture({ triggers: [silentTrigger] }),
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'confirm_required');

  const upserted = new Map();
  let deleted = 0;
  const apply = await runExpectedFireWatchdog({
    apply: true,
    dryRun: false,
    confirm: LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM,
    now: fixedNow(),
    retentionDays: 30,
  }, {
    queryFn: watchdogQueryFixture({ triggers: [silentTrigger], pruneCount: 3 }),
    runFn: async (sql: string, params: any[] = []) => {
      if (/INSERT INTO luna_silent_miss_log/i.test(sql)) {
        upserted.set(params[0], params);
        return { rowCount: 1, rows: [] };
      }
      if (/DELETE FROM luna_silent_miss_log/i.test(sql)) {
        deleted += 1;
        return { rowCount: 3, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  });
  assert.equal(apply.ok, true);
  assert.equal(apply.written, 1);
  assert.equal(apply.pruned, 3);
  assert.equal(deleted, 1);
  assert.equal(upserted.has(silentTrigger.id), true);

  const silentMissRows = [{
    trigger_id: 'trigger-silent-1',
    symbol: '005930',
    exchange: 'kis',
    setup_type: 'promotion_ready_shadow',
    ready_at: '2026-06-19T08:00:00.000Z',
    expired_at: '2026-06-19T08:20:00.000Z',
    predictive_score: 0.68,
    confidence: 0.71,
    reason: 'ready_but_not_fired_watchdog_fixture',
    detected_at: fixedNow(),
  }];

  const planNote = await buildMeetingPlanNote({
    type: 'domestic_debrief',
    now: fixedNow(),
  }, {
    queryFn: async (sql: string) => {
      if (/FROM luna_silent_miss_log/i.test(sql)) return silentMissRows;
      if (/FROM luna_meeting_sessions/i.test(sql)) return [{ id: 1, type: 'morning', started_at: fixedNow(), summary: 'morning', segments: [] }];
      if (/FROM luna_strategy_signals/i.test(sql)) return [];
      if (/FROM luna_entry_preflight_log/i.test(sql)) return [];
      if (/FROM luna_circuit_locks/i.test(sql)) return [];
      if (/FROM luna_market_gate_history/i.test(sql)) return [];
      if (/FROM hmm_regime_log/i.test(sql)) return [];
      if (/FROM trade_journal/i.test(sql)) return [];
      if (/FROM luna_meeting_decisions/i.test(sql)) return [];
      if (/FROM positions/i.test(sql)) return [];
      if (/FROM luna_regime_calibration/i.test(sql)) return [];
      if (/FROM luna_component_registry/i.test(sql)) return [];
      return [];
    },
  });
  assert.equal(planNote.debrief.unspokenEntries.length, 1);
  assert.equal(planNote.debrief.unspokenEntries[0].source, 'expected_fire_watchdog');

  const cli = parseMeetingRoomLOpsCliArgs(['--skip-silent-miss', '--silent-miss-lookback-hours', '12']);
  assert.equal(cli.skipSilentMiss, true);
  assert.equal(cli.silentMissLookbackHours, 12);

  const lDry = await runMeetingRoomLOps({
    dryRun: true,
    skipDebrief: true,
    skipAdr: true,
    skipCircuit: true,
    skipRegime: true,
    skipDisclosure: true,
    skipDailyLoss: true,
    skipRisk: true,
    now: fixedNow(),
  }, {
    queryFn: lOpsQueryFixture({ silentMisses: silentMissRows }),
  });
  assert.equal(lDry.silentMiss.candidates.length, 1);
  assert.equal(lDry.eventMeeting.candidates, 1);

  const lDedup = await runMeetingRoomLOps({
    dryRun: true,
    skipDebrief: true,
    skipAdr: true,
    skipCircuit: true,
    skipRegime: true,
    skipDisclosure: true,
    skipDailyLoss: true,
    skipRisk: true,
    now: fixedNow(),
  }, {
    queryFn: lOpsQueryFixture({
      silentMisses: silentMissRows,
      existingAgendaKeys: ['silent-miss:trigger-silent-1'],
    }),
  });
  assert.equal(lDedup.silentMiss.candidates.length, 0);
  assert.equal(lDedup.eventMeeting.candidates, 0);

  let meetingCalls = 0;
  const lApply = await runMeetingRoomLOps({
    apply: true,
    dryRun: false,
    confirm: LUNA_MEETING_ROOM_L_CONFIRM,
    skipDebrief: true,
    skipAdr: true,
    skipCircuit: true,
    skipRegime: true,
    skipDisclosure: true,
    skipDailyLoss: true,
    skipRisk: true,
    now: fixedNow(),
  }, {
    queryFn: lOpsQueryFixture({ silentMisses: silentMissRows }),
    runMeetingSession: async (options: any) => {
      meetingCalls += 1;
      assert.equal(options.type, 'adhoc');
      assert.equal(options.agendas.length, 1);
      assert.equal(options.agendas[0].kind, 'event_meeting');
      assert.equal(options.agendas[0].evidence.type, 'silent_miss');
      return { session: { id: 9904 }, decisions: [{ id: 1 }], markdownPath: '/tmp/silent-miss.md' };
    },
  });
  assert.equal(meetingCalls, 1);
  assert.equal(lApply.silentMiss.triggered, 1);
  assert.equal(lApply.eventMeeting.triggered, 1);

  const sourceText = [
    fs.readFileSync(path.join(ROOT, 'shared/luna-expected-fire-watchdog.ts'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'scripts/runtime-luna-expected-fire-watchdog.ts'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'services/meeting-room/server/meeting-room-l-ops.ts'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'services/meeting-room/server/adapters/stack-adapter.ts'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'services/meeting-room/server/orchestrator/meeting-session.ts'), 'utf8'),
  ].join('\n');
  assert.equal(/placeOrder|createOrder|modifyOrder|cancelOrder|\/api\/v1\/orders/.test(sourceText), false);
  const entryTriggerEngine = fs.readFileSync(path.join(ROOT, 'shared/entry-trigger-engine.ts'), 'utf8');
  assert.equal(entryTriggerEngine.includes('luna-expected-fire-watchdog'), false);

  const result = {
    smoke: 'luna-expected-fire-watchdog',
    ok: true,
    scenarios: {
      silentMissDetected: true,
      normalBlocksExcluded: true,
      matchedExecutionExcludedFromSilentMiss: true,
      expiryWindowUsesTriggerExpiry: true,
      applyConfirmAndRetention: true,
      debriefUnspokenEntries: true,
      lOpsAdhocMeeting: true,
      liveMutationSafety: true,
    },
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna expected-fire watchdog smoke ok');
}

main().catch((error) => {
  console.error('❌ luna-expected-fire-watchdog-smoke 실패:', error);
  process.exitCode = 1;
});
