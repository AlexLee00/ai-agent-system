#!/usr/bin/env node
// @ts-nocheck

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeCryptoGuardAutotuneReport } from './runtime-crypto-guard-autotune-report.ts';
import { buildRuntimeKisDomesticAutotuneReport } from './runtime-kis-domestic-autotune-report.ts';
import { buildRuntimeKisOverseasAutotuneReport } from './runtime-kis-overseas-autotune-report.ts';
import { getParameterGovernance } from '../shared/runtime-parameter-governance.ts';
import { getKisMarketStatus, getKisOverseasMarketStatus } from '../shared/secrets.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.yaml');
const REGIME_CAPTURE_PATH = join(__dirname, '..', 'output', 'ops', 'market-regime-capture.json');
const CONFIRM = 'luna-dynamic-policy-autotune';

function boolEnv(key, fallback = false) {
  const value = process.env[key];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    apply: argv.includes('--apply'),
    confirm: argv.find((arg) => arg.startsWith('--confirm='))?.split('=')[1] || null,
    days: Math.max(1, Number(argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 14)),
  };
}

function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function getByPath(target, path) {
  return path.reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), target);
}

function setByPath(target, path, value) {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

function toRuntimePath(key) {
  return String(key || '').replace(/^runtime_config\./, '').split('.').filter(Boolean);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function regimeFor(market, capture) {
  const normalized = market === 'crypto' ? 'crypto' : market;
  return (capture?.rows || []).find((row) => row?.normalizedMarket === normalized || row?.market === market) || null;
}

function isProbeBlockedByRegime(market, regime) {
  if (!regime) return false;
  if (boolEnv('LUNA_DYNAMIC_POLICY_ALLOW_BEARISH_PROBE', false)) return false;
  if (String(regime.bias || '').toLowerCase() === 'bearish') return true;
  if (String(regime.tradingStyle || '').toLowerCase() === 'defensive') return true;
  if (String(regime.regime || '').toLowerCase().includes('bear')) return true;
  return market !== 'crypto' && String(regime.bias || '').toLowerCase() !== 'bullish' && String(regime.regime || '').toLowerCase() === 'ranging';
}

async function buildMarketSessions(now = new Date()) {
  const domestic = await getKisMarketStatus(now).catch((error) => ({
    isOpen: false,
    reason: `domestic_market_status_error:${error?.message || error}`,
  }));
  const overseas = (() => {
    try {
      return getKisOverseasMarketStatus(now);
    } catch (error) {
      return {
        isOpen: false,
        reason: `overseas_market_status_error:${error?.message || error}`,
      };
    }
  })();
  return {
    crypto: {
      isOpen: true,
      reason: 'crypto_24h_market',
      sessionPolicy: 'continuous_24h',
    },
    domestic: {
      ...domestic,
      sessionPolicy: domestic?.isOpen ? 'live_market_open' : 'defer_entry_policy_until_market_open',
    },
    overseas: {
      ...overseas,
      sessionPolicy: overseas?.isOpen ? 'live_market_open' : 'defer_entry_policy_until_market_open',
    },
  };
}

function isMarketSessionBlockingProbe(market, session) {
  if (market === 'crypto') return false;
  return session?.isOpen !== true;
}

function buildCandidateFromDynamicPolicy({ market, report, rawConfig, regime, session }) {
  const dynamicPolicy = report?.dynamicPolicy || {};
  const hasProbeSuggestion = (dynamicPolicy.suggestions || []).some((item) => item?.action === 'allow_small_probe_when_all_runtime_guards_clear');
  if (!hasProbeSuggestion) return null;

  if (isMarketSessionBlockingProbe(market, session)) {
    return {
      blocked: true,
      market,
      reason: 'probe_deferred_until_market_open',
      session,
      dynamicPolicy,
    };
  }

  if (isProbeBlockedByRegime(market, regime)) {
    return {
      blocked: true,
      market,
      reason: 'probe_blocked_by_market_regime',
      regime,
      dynamicPolicy,
    };
  }

  const keyByMarket = {
    crypto: 'runtime_config.luna.fastPathThresholds.minCryptoConfidence',
    domestic: 'runtime_config.luna.fastPathThresholds.minStockConfidence',
    overseas: 'runtime_config.luna.minConfidence.live.kis_overseas',
  };
  const floorByMarket = {
    crypto: 0.42,
    domestic: 0.18,
    overseas: 0.18,
  };
  const key = keyByMarket[market];
  if (!key) return null;
  const path = toRuntimePath(key);
  const current = num(getByPath(rawConfig.runtime_config || {}, path), market === 'crypto' ? 0.48 : 0.22);
  const suggested = Number(clamp(current - 0.02, floorByMarket[market], current).toFixed(4));
  if (suggested >= current) return null;

  const governance = getParameterGovernance(key);
  if (governance.tier !== 'allow') {
    return {
      blocked: true,
      market,
      key,
      reason: 'governance_not_allow',
      governance,
      dynamicPolicy,
    };
  }

  return {
    market,
    key,
    path,
    current,
    suggested,
    confidence: 0.72,
    reason: `${market} 운영 epoch 표본 수집을 위한 소형 probe 임계값 완화`,
    governance,
    dynamicPolicy,
    regime,
  };
}

function renderText(result) {
  const lines = [
    '🤖 Luna Dynamic Policy Operator',
    `status: ${result.status}`,
    `applied: ${result.applied.length}`,
    `candidates: ${result.candidates.length}`,
    `blocked: ${result.blocked.length}`,
  ];
  for (const item of result.candidates) lines.push(`- candidate ${item.market}: ${item.key} ${item.current} -> ${item.suggested}`);
  for (const item of result.blocked) lines.push(`- blocked ${item.market}: ${item.reason}`);
  return lines.join('\n');
}

export async function buildLunaDynamicPolicyOperator({ days = 14, apply = false, confirm = null } = {}) {
  await db.initSchema();
  const enabled = boolEnv('LUNA_DYNAMIC_POLICY_ENABLED', true);
  const autoApplyEnabled = boolEnv('LUNA_DYNAMIC_POLICY_AUTO_APPLY_ENABLED', true);
  const rawConfig = yaml.load(readFileSync(CONFIG_PATH, 'utf8')) || {};
  if (!rawConfig.runtime_config || typeof rawConfig.runtime_config !== 'object') rawConfig.runtime_config = {};
  const regimeCapture = readJsonSafe(REGIME_CAPTURE_PATH, null);
  const marketSessions = await buildMarketSessions();

  const [crypto, domestic, overseas] = await Promise.all([
    buildRuntimeCryptoGuardAutotuneReport({ days, json: true }).catch((error) => ({ ok: false, error: String(error?.message || error) })),
    buildRuntimeKisDomesticAutotuneReport({ days, json: true }).catch((error) => ({ ok: false, error: String(error?.message || error) })),
    buildRuntimeKisOverseasAutotuneReport({ days, json: true }).catch((error) => ({ ok: false, error: String(error?.message || error) })),
  ]);

  const reports = { crypto, domestic, overseas };
  const candidates = [];
  const blocked = [];
  for (const [market, report] of Object.entries(reports)) {
    const candidate = buildCandidateFromDynamicPolicy({
      market,
      report,
      rawConfig,
      regime: regimeFor(market, regimeCapture),
      session: marketSessions[market],
    });
    if (!candidate) continue;
    if (candidate.blocked) blocked.push(candidate);
    else candidates.push(candidate);
  }

  const result = {
    ok: true,
    status: 'luna_dynamic_policy_idle',
    checkedAt: new Date().toISOString(),
    enabled,
    autoApplyEnabled,
    dryRun: !apply,
    applied: [],
    candidates,
    blocked,
    marketSessions,
    reports: Object.fromEntries(Object.entries(reports).map(([market, report]) => [
      market,
      {
        ok: report?.ok !== false,
        status: report?.dynamicPolicy?.status || report?.decision?.status || report?.status || null,
        dynamicPolicy: report?.dynamicPolicy || null,
        session: marketSessions[market],
      },
    ])),
    nextAction: 'continue_observation',
  };

  if (!enabled) {
    result.status = 'luna_dynamic_policy_disabled';
    result.nextAction = 'set LUNA_DYNAMIC_POLICY_ENABLED=true to enable operator';
    return result;
  }
  if (candidates.length > 0) {
    result.status = apply ? 'luna_dynamic_policy_apply_requested' : 'luna_dynamic_policy_ready';
    result.nextAction = `rerun with --apply --confirm=${CONFIRM}`;
  }
  if (!apply || candidates.length === 0) return result;
  if (!autoApplyEnabled) {
    result.status = 'luna_dynamic_policy_apply_blocked_disabled';
    result.nextAction = 'set LUNA_DYNAMIC_POLICY_AUTO_APPLY_ENABLED=true';
    return result;
  }
  if (confirm !== CONFIRM) {
    result.status = 'luna_dynamic_policy_apply_blocked_confirm_required';
    result.nextAction = `rerun with --confirm=${CONFIRM}`;
    result.ok = false;
    return result;
  }

  for (const candidate of candidates) {
    const before = getByPath(rawConfig.runtime_config, candidate.path);
    setByPath(rawConfig.runtime_config, candidate.path, candidate.suggested);
    result.applied.push({
      market: candidate.market,
      key: candidate.key,
      before,
      after: candidate.suggested,
    });
  }
  writeFileSync(CONFIG_PATH, yaml.dump(rawConfig, { lineWidth: 120, noRefs: true }), 'utf8');
  result.status = 'luna_dynamic_policy_applied';
  result.nextAction = 'rerun market cycle and monitor operating epoch samples';

  await db.insertRuntimeConfigSuggestionLog({
    periodDays: days,
    actionableCount: candidates.length,
    marketSummary: {
      operator: 'luna_dynamic_policy',
      candidates: candidates.map((item) => ({ market: item.market, key: item.key, current: item.current, suggested: item.suggested })),
      blocked: blocked.map((item) => ({ market: item.market, reason: item.reason })),
    },
    suggestions: candidates.map((item) => ({
      action: 'adjust',
      key: item.key,
      current: item.current,
      suggested: item.suggested,
      confidence: item.confidence,
      reason: item.reason,
    })),
    policySnapshot: { regimeCapture, reports: result.reports },
    reviewStatus: 'applied',
    reviewNote: `luna_dynamic_policy_auto_applied:${candidates.map((item) => item.key).join(',')}`,
  }).catch(() => {});

  return result;
}

async function main() {
  const args = parseArgs();
  const result = await buildLunaDynamicPolicyOperator(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
  if (args.apply && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-dynamic-policy-operator 실패:',
  });
}
