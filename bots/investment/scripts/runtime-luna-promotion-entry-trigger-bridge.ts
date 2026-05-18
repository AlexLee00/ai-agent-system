#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildPromotionEntryTriggerBridgePlan,
  LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM,
  writePromotionEntryTriggerBridgeShadow,
} from '../shared/luna-promotion-entry-trigger-bridge.ts';
import { runLunaPromotionEntryTriggerCoverage } from './runtime-luna-promotion-entry-trigger-coverage.ts';

function argValue(name, fallback = null, argv = process.argv.slice(2)) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name, argv = process.argv.slice(2)) {
  return argv.includes(`--${name}`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const apply = hasFlag('apply', argv);
  return {
    json: hasFlag('json', argv),
    strict: hasFlag('strict', argv),
    apply,
    dryRun: hasFlag('dry-run', argv) || !apply,
    confirm: String(argValue('confirm', '', argv) || ''),
    market: String(argValue('market', 'all', argv) || 'all').trim().toLowerCase(),
    exchange: String(argValue('exchange', 'all', argv) || 'all').trim().toLowerCase(),
    symbols: String(argValue('symbols', '', argv) || ''),
    hours: Math.max(1, Number(argValue('hours', 168, argv)) || 168),
    limit: Math.max(1, Number(argValue('limit', 100, argv)) || 100),
    ttlMinutes: Math.max(30, Number(argValue('ttl-minutes', process.env.LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_TTL_MINUTES || 180)) || 180),
  };
}

export async function runLunaPromotionEntryTriggerBridge(options = parseArgs(), deps = {}) {
  if (options.apply && options.dryRun) {
    return {
      ok: false,
      status: 'luna_promotion_entry_trigger_bridge_apply_conflict',
      phase: 'luna_promotion_entry_trigger_shadow_bridge',
      shadowMode: true,
      liveMutation: false,
      entryTriggerDbMutation: false,
      blockers: [{
        type: 'safety',
        name: 'apply_dry_run_conflict',
        detail: 'Do not combine --apply and --dry-run.',
      }],
    };
  }
  if (options.apply && options.confirm !== LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM) {
    return {
      ok: false,
      status: 'luna_promotion_entry_trigger_bridge_apply_blocked',
      phase: 'luna_promotion_entry_trigger_shadow_bridge',
      shadowMode: true,
      liveMutation: false,
      entryTriggerDbMutation: false,
      requiredConfirm: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM,
      blockers: [{
        type: 'safety',
        name: 'confirm_required',
        detail: `Shadow bridge write requires --confirm=${LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM}.`,
      }],
    };
  }

  const coverageReport = deps.coverageReport || await runLunaPromotionEntryTriggerCoverage({
    json: true,
    dryRun: true,
    apply: false,
    market: options.market,
    exchange: options.exchange,
    symbols: options.symbols || '',
    hours: options.hours,
    limit: options.limit,
  });
  const plan = buildPromotionEntryTriggerBridgePlan(coverageReport, {
    ttlMinutes: options.ttlMinutes,
  });

  const writeResult = options.apply
    ? deps.writePlan
      ? await deps.writePlan(plan)
      : await writePromotionEntryTriggerBridgeShadow(plan)
    : {
      ok: true,
      written: 0,
      shadowDbMutation: false,
      liveMutation: false,
      entryTriggerDbMutation: false,
    };

  return {
    ...plan,
    status: options.apply
      ? 'luna_promotion_entry_trigger_bridge_shadow_written'
      : plan.status,
    dryRun: options.dryRun,
    apply: options.apply,
    writeMode: options.apply ? 'shadow-bridge-upsert-only' : 'plan-only',
    confirmToken: LUNA_PROMOTION_ENTRY_TRIGGER_BRIDGE_CONFIRM,
    shadowDbMutation: writeResult.shadowDbMutation === true,
    written: Number(writeResult.written || 0),
    liveMutation: false,
    entryTriggerDbMutation: false,
  };
}

async function main() {
  const options = parseArgs();
  const report = await runLunaPromotionEntryTriggerBridge(options);
  if (options.strict && !report.ok) process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`${report.status} bridgeItems=${report.summary?.bridgePlanItems || 0} written=${report.written || 0}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'runtime-luna-promotion-entry-trigger-bridge error:',
  });
}

export default { runLunaPromotionEntryTriggerBridge };
