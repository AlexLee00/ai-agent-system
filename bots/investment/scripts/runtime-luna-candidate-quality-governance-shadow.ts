#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaCandidateQualityGovernanceRows,
  ensureLunaCandidateQualityGovernanceSchema,
  fixtureCandidateQualityGovernanceInputs,
  insertLunaCandidateQualityGovernanceShadow,
  loadLunaCandidateQualityGovernanceInputs,
} from '../shared/luna-candidate-quality-governance.ts';
import { normalizeLunaPhase2Symbol } from '../shared/luna-weight-vector.ts';

export const CONFIRM = 'luna-candidate-quality-governance-shadow';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function symbolsFrom(value: any = '') {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map((symbol) => normalizeLunaPhase2Symbol(symbol)).filter(Boolean))];
}

function countBy(rows: any[] = [], key: string) {
  return rows.reduce((acc, row) => {
    const value = row?.[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

export async function runLunaCandidateQualityGovernanceShadow(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun === true || !apply;
  const fixture = options.fixture === true;
  const json = options.json === true;
  const confirm = String(options.confirm || '');
  const limit = Math.max(1, Number(options.limit || process.env.LUNA_CANDIDATE_QUALITY_GOVERNANCE_LIMIT || 50));
  const market = options.market || null;
  const requestedSymbols = symbolsFrom(options.symbols || process.env.LUNA_CANDIDATE_QUALITY_GOVERNANCE_SYMBOLS || '');

  if (apply && options.dryRun === true) {
    throw new Error('runtime:luna-candidate-quality-governance cannot combine --apply with --dry-run');
  }
  if (apply && confirm !== CONFIRM) {
    throw new Error(`runtime:luna-candidate-quality-governance apply requires --confirm=${CONFIRM}`);
  }

  const rawInputs = fixture
    ? fixtureCandidateQualityGovernanceInputs()
    : deps.loadInputs
      ? await deps.loadInputs({ limit, market, symbols: requestedSymbols })
      : await loadLunaCandidateQualityGovernanceInputs({ limit, market, symbols: requestedSymbols });
  const inputs = requestedSymbols.length
    ? rawInputs.filter((input) => requestedSymbols.includes(normalizeLunaPhase2Symbol(input.symbol)))
    : rawInputs;
  const rows = buildLunaCandidateQualityGovernanceRows(inputs, {
    quarantineCooldownHours: Number(options.quarantineCooldownHours || process.env.LUNA_CANDIDATE_QUARANTINE_COOLDOWN_HOURS || 168),
    repeatUnhealthyCooldownHours: Number(options.repeatUnhealthyCooldownHours || process.env.LUNA_CANDIDATE_REPEAT_UNHEALTHY_COOLDOWN_HOURS || 72),
    unhealthyCooldownHours: Number(options.unhealthyCooldownHours || process.env.LUNA_CANDIDATE_UNHEALTHY_COOLDOWN_HOURS || 24),
    stabilizationCooldownHours: Number(options.stabilizationCooldownHours || process.env.LUNA_CANDIDATE_BACKTEST_STABILIZATION_COOLDOWN_HOURS || 6),
  });

  if (apply && !dryRun && rows.length > 0) {
    if (deps.ensureSchema) await deps.ensureSchema();
    else {
      await db.initSchema();
      await ensureLunaCandidateQualityGovernanceSchema();
    }
    for (const row of rows) {
      if (deps.insertRow) await deps.insertRow(row);
      else await insertLunaCandidateQualityGovernanceShadow(row);
    }
  }

  const cooldownRows = rows.filter((row) => row.governanceAction === 'candidate_cooldown_shadow');
  const summary = {
    total: rows.length,
    byAction: countBy(rows, 'governanceAction'),
    cooldown: cooldownRows.length,
    replacementNeeded: rows.filter((row) => row.replacementNeeded).length,
    refreshPriority: rows.filter((row) => row.governanceAction === 'refresh_backtest_priority').length,
    backtestStabilization: rows.filter((row) => row.governanceAction === 'backtest_stabilization_shadow').length,
    strategyRepair: rows.filter((row) => row.governanceAction === 'strategy_repair_shadow').length,
    promotionMonitor: rows.filter((row) => row.governanceAction === 'promotion_monitor_shadow').length,
    liveMutation: false,
  };
  const payload = {
    ok: true,
    status: apply ? 'luna_candidate_quality_governance_shadow_written' : 'luna_candidate_quality_governance_planned',
    phase: 'luna_candidate_quality_feedback',
    dryRun,
    apply,
    fixture,
    writeMode: apply ? 'shadow-apply' : 'plan-only',
    shadowMode: true,
    confirmToken: CONFIRM,
    market: market || 'all',
    requestedSymbols,
    summary,
    rows,
  };

  if (!json) {
    console.log(`[luna-candidate-quality-governance] ${payload.status} total=${summary.total} actions=${JSON.stringify(summary.byAction)}`);
  }
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaCandidateQualityGovernanceShadow({
      json: hasFlag('json'),
      dryRun: hasFlag('dry-run'),
      apply: hasFlag('apply'),
      fixture: hasFlag('fixture'),
      limit: Number(argValue('limit', process.env.LUNA_CANDIDATE_QUALITY_GOVERNANCE_LIMIT || 50)),
      market: argValue('market', null),
      symbols: argValue('symbols', process.env.LUNA_CANDIDATE_QUALITY_GOVERNANCE_SYMBOLS || ''),
      confirm: argValue('confirm', ''),
      quarantineCooldownHours: Number(argValue('quarantine-cooldown-hours', process.env.LUNA_CANDIDATE_QUARANTINE_COOLDOWN_HOURS || 168)),
      repeatUnhealthyCooldownHours: Number(argValue('repeat-unhealthy-cooldown-hours', process.env.LUNA_CANDIDATE_REPEAT_UNHEALTHY_COOLDOWN_HOURS || 72)),
      unhealthyCooldownHours: Number(argValue('unhealthy-cooldown-hours', process.env.LUNA_CANDIDATE_UNHEALTHY_COOLDOWN_HOURS || 24)),
      stabilizationCooldownHours: Number(argValue('stabilization-cooldown-hours', process.env.LUNA_CANDIDATE_BACKTEST_STABILIZATION_COOLDOWN_HOURS || 6)),
    }),
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'runtime-luna-candidate-quality-governance error:',
  });
}
