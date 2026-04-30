#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { evaluateActiveEntryTriggersAgainstMarketEvents } from '../shared/entry-trigger-engine.ts';
import { insertEntryTrigger } from '../shared/luna-discovery-entry-store.ts';
import { writeEntryTriggerWorkerHeartbeat } from './luna-entry-trigger-worker.ts';

const DEFAULT_MAX_USDT = 50;
const DEFAULT_VALIDATION_SYMBOL = 'LUNA_ENTRY_TRIGGER_VALIDATION/USDT';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function withEnv(patch = {}, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (previous[key] == null) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function parseArgs() {
  const dryRun = boolEnv('LUNA_FIRST_CYCLE_DRY_RUN', true);
  const paperOnly = boolEnv('LUNA_FIRST_CYCLE_PAPER_ONLY', true);
  const maxUsdt = Math.min(
    DEFAULT_MAX_USDT,
    Math.max(1, Number(argValue('--max-usdt', process.env.LUNA_FIRST_CYCLE_MAX_USDT || DEFAULT_MAX_USDT))),
  );
  return {
    json: process.argv.includes('--json'),
    cleanup: process.argv.includes('--cleanup'),
    cleanupOnly: process.argv.includes('--cleanup-only'),
    exchange: argValue('--exchange', 'binance'),
    symbol: argValue('--symbol', DEFAULT_VALIDATION_SYMBOL),
    maxUsdt,
    dryRun,
    paperOnly,
  };
}

function buildCapitalSnapshot(maxUsdt = DEFAULT_MAX_USDT) {
  return {
    mode: 'ACTIVE_DISCOVERY',
    reasonCode: 'first_close_cycle_validation',
    balanceStatus: 'ok',
    buyableAmount: Math.max(100, Number(maxUsdt || DEFAULT_MAX_USDT) * 2),
    minOrderAmount: 1,
    remainingSlots: 1,
  };
}

async function cleanupTrigger(id = null, { allValidation = false } = {}) {
  if (id) {
    const result = await db.run(`DELETE FROM entry_triggers WHERE id = $1`, [id]).catch(() => null);
    return { deleted: Number(result?.rowCount || 0), scope: 'single' };
  }
  if (allValidation) {
    const result = await db.run(
      `DELETE FROM entry_triggers
        WHERE trigger_context->>'source' = 'runtime-luna-entry-trigger-simulate-fire'
           OR trigger_meta->>'phase' = 'Z1'
           OR trigger_type LIKE 'first_cycle_validation_%'`,
      [],
    ).catch(() => null);
    return { deleted: Number(result?.rowCount || 0), scope: 'all_validation' };
  }
  return { deleted: 0, scope: 'none' };
}

export async function runLunaEntryTriggerSimulateFire(args = {}) {
  const exchange = args.exchange || 'binance';
  const symbol = args.symbol || DEFAULT_VALIDATION_SYMBOL;
  const maxUsdt = Math.min(DEFAULT_MAX_USDT, Math.max(1, Number(args.maxUsdt || DEFAULT_MAX_USDT)));
  const triggerType = `first_cycle_validation_${Date.now().toString(36)}`;
  const envPatch = {
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_REQUIRE_LIVE_RISK_CONTEXT: 'true',
    LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE: '0.4',
    LUNA_PREDICTIVE_VALIDATION_ENABLED: 'true',
    LUNA_PREDICTIVE_VALIDATION_MODE: 'hard_gate',
    LUNA_PREDICTIVE_VALIDATION_THRESHOLD: '0.55',
    LUNA_PREDICTIVE_REQUIRE_COMPONENTS: 'false',
  };

  return withEnv(envPatch, async () => {
    await db.initSchema();
    if (args.cleanupOnly) {
      const cleanup = await cleanupTrigger(null, { allValidation: true });
      const heartbeat = writeEntryTriggerWorkerHeartbeat({
        ok: true,
        exchange,
        eventSource: 'first_cycle_validation_cleanup',
        eventCount: 0,
        result: { enabled: true, checked: 0, fired: 0, readyBlocked: 0 },
        clearLastFire: true,
      });
      return {
        ok: true,
        status: 'first_cycle_entry_trigger_validation_cleanup_only',
        phase: 'Z1',
        exchange,
        symbol,
        cleanup,
        heartbeatPath: heartbeat?.path || null,
      };
    }
    const trigger = await insertEntryTrigger({
      symbol,
      exchange,
      setupType: 'first_close_cycle_validation',
      triggerType,
      triggerState: 'armed',
      confidence: 0.82,
      targetPrice: 1,
      stopLoss: 0.95,
      takeProfit: 1.05,
      waitingFor: triggerType,
      predictiveScore: 0.78,
      triggerContext: {
        source: 'runtime-luna-entry-trigger-simulate-fire',
        phase: 'Z1',
        dryRun: args.dryRun !== false,
        paperOnly: args.paperOnly !== false,
        maxUsdt,
        hints: {
          mtfAgreement: 0.9,
          discoveryScore: 0.84,
          breakoutRetest: true,
          volumeBurst: 2.1,
          newsMomentum: 0.7,
        },
      },
      triggerMeta: {
        phase: 'Z1',
        validationOnly: true,
        noOrderExecution: true,
      },
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    if (!trigger?.id) {
      return {
        ok: false,
        status: 'entry_trigger_insert_failed',
        exchange,
        symbol,
      };
    }

    const event = {
      symbol,
      price: 1.01,
      targetPrice: 1,
      mtfAgreement: 0.9,
      discoveryScore: 0.84,
      volumeBurst: 2.1,
      breakoutRetest: true,
      newsMomentum: 0.7,
      triggerHints: {
        mtfAgreement: 0.9,
        discoveryScore: 0.84,
        volumeBurst: 2.1,
        breakoutRetest: true,
        newsMomentum: 0.7,
      },
    };
    const result = await evaluateActiveEntryTriggersAgainstMarketEvents([event], {
      exchange,
      defaultAmountUsdt: maxUsdt,
      capitalSnapshot: buildCapitalSnapshot(maxUsdt),
      regime: 'trending_bull',
      market: 'crypto',
    });
    const heartbeat = writeEntryTriggerWorkerHeartbeat({
      ok: true,
      exchange,
      eventSource: 'first_cycle_validation',
      eventCount: 1,
      result,
    });
    const fired = Number(result?.fired || 0);
    const output = {
      ok: fired >= 1,
      status: fired >= 1 ? 'first_cycle_entry_trigger_fired' : 'first_cycle_entry_trigger_not_fired',
      phase: 'Z1',
      exchange,
      symbol,
      dryRun: args.dryRun !== false,
      paperOnly: args.paperOnly !== false,
      maxUsdt,
      triggerId: trigger.id,
      triggerType,
      result,
      heartbeatPath: heartbeat?.path || null,
      safety: {
        orderExecution: false,
        buySellPathTouched: false,
        validationOnly: true,
      },
    };
    if (args.cleanup) {
      output.cleanup = await cleanupTrigger(trigger.id);
      output.cleanedUp = true;
    }
    return output;
  });
}

async function main() {
  const args = parseArgs();
  const result = await runLunaEntryTriggerSimulateFire(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.status} — fired=${result.result?.fired ?? 0} checked=${result.result?.checked ?? 0} readyBlocked=${result.result?.readyBlocked ?? 0}`);
    if (result.heartbeatPath) console.log(`heartbeat: ${result.heartbeatPath}`);
  }
  if (!result.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-entry-trigger-simulate-fire 실패:',
  });
}
