#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getInvestmentSyncRuntimeConfig } from '../shared/runtime-config.ts';

const CONFIRM = 'retire-dust-strategy-profiles';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function getDustThresholdUsdt() {
  const syncRuntime = getInvestmentSyncRuntimeConfig();
  const threshold = Number(syncRuntime?.cryptoMinNotionalUsdt);
  return Number.isFinite(threshold) && threshold > 0 ? threshold : 10;
}

function profileKey(position = {}) {
  return [
    position.exchange,
    position.symbol,
    position.trade_mode || position.tradeMode || 'normal',
  ].join('|');
}

export function buildDustStrategyProfileCandidatesFromSnapshots({
  livePositions = [],
  profilesByKey = {},
  dustThresholdUsdt = 10,
} = {}) {
  const rows = [];
  for (const position of livePositions || []) {
    const notionalUsdt = Number(position.amount || 0) * Number(position.avg_price || 0);
    if (!(notionalUsdt > 0) || notionalUsdt >= Number(dustThresholdUsdt || 10)) continue;
    const key = profileKey(position);
    const profile = profilesByKey[key] || null;
    if (!profile) continue;
    rows.push({
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: position.trade_mode || position.tradeMode || 'normal',
      notionalUsdt,
      thresholdUsdt: Number(dustThresholdUsdt || 10),
      strategyName: profile.strategy_name || profile.strategyName || null,
      profileId: profile.id || null,
    });
  }
  return rows;
}

export function buildRetireDustStrategyProfilesPlan({
  candidates = [],
  apply = false,
  confirm = '',
  errors = [],
} = {}) {
  const confirmationOk = !apply || confirm === CONFIRM;
  const blockers = [];
  if (apply && !confirmationOk) blockers.push('confirmation_required');
  for (const error of errors || []) blockers.push(`retire_failed:${error.symbol || 'unknown'}:${error.error || 'unknown'}`);
  const retired = apply && confirmationOk ? candidates.length - (errors || []).length : 0;
  return {
    ok: blockers.length === 0,
    status: blockers.length > 0
      ? 'dust_strategy_profiles_blocked'
      : retired > 0
        ? 'dust_strategy_profiles_retired'
        : candidates.length > 0
          ? 'dust_strategy_profiles_candidates'
          : 'dust_strategy_profiles_clear',
    apply: apply === true,
    confirmRequired: apply && !confirmationOk,
    confirmValue: CONFIRM,
    dustThresholdUsdt: candidates[0]?.thresholdUsdt || null,
    candidates: candidates.length,
    retired,
    blockers,
    errors,
    rows: candidates,
    nextCommand: candidates.length > 0 && !apply
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run -s runtime:retire-dust-strategy-profiles -- --apply --confirm=${CONFIRM} --json`
      : null,
  };
}

async function loadDustCandidates({ dustThresholdUsdt = getDustThresholdUsdt() } = {}) {
  const livePositions = await db.getAllPositions('binance', false);
  const rows = [];
  for (const position of livePositions) {
    const notionalUsdt = Number(position.amount || 0) * Number(position.avg_price || 0);
    if (!(notionalUsdt > 0) || notionalUsdt >= dustThresholdUsdt) continue;
    const profile = await db.getPositionStrategyProfile(position.symbol, {
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      status: 'active',
    }).catch(() => null);
    if (!profile) continue;
    rows.push({
      symbol: position.symbol,
      exchange: position.exchange,
      tradeMode: position.trade_mode || 'normal',
      notionalUsdt,
      thresholdUsdt: dustThresholdUsdt,
      strategyName: profile.strategy_name || null,
      profileId: profile.id || null,
    });
  }
  return rows;
}

export async function runRetireDustStrategyProfiles({
  apply = false,
  confirm = '',
  dustThresholdUsdt = getDustThresholdUsdt(),
} = {}) {
  await db.initSchema();
  const candidates = await loadDustCandidates({ dustThresholdUsdt });
  const confirmationOk = !apply || confirm === CONFIRM;
  const errors = [];
  if (apply && confirmationOk) {
    for (const row of candidates) {
      try {
        await db.closePositionStrategyProfile(row.symbol, {
          exchange: row.exchange,
          tradeMode: row.tradeMode,
        });
      } catch (error) {
        errors.push({
          symbol: row.symbol,
          exchange: row.exchange,
          tradeMode: row.tradeMode,
          error: error?.message || String(error),
        });
      }
    }
  }
  return buildRetireDustStrategyProfilesPlan({ candidates, apply, confirm, errors });
}

function renderText(result = {}) {
  return [
    '🧹 Retire dust strategy profiles',
    `status: ${result.status || 'unknown'} / apply=${result.apply === true}`,
    `candidates=${result.candidates ?? 0} / retired=${result.retired ?? 0}`,
    `blockers: ${(result.blockers || []).join(' / ') || 'none'}`,
    result.nextCommand ? `next: ${result.nextCommand}` : 'next: none',
  ].join('\n');
}

async function main() {
  const json = hasFlag('--json');
  const apply = hasFlag('--apply');
  const confirm = argValue('--confirm', '');
  const result = await runRetireDustStrategyProfiles({ apply, confirm });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
  if (result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ retire-dust-strategy-profiles 실패:',
  });
}
