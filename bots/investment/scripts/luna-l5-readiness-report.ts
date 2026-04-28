#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { getCapitalConfig } from '../shared/capital-manager.ts';
import { readPositionRuntimeAutopilotHistorySummary } from './runtime-position-runtime-autopilot-history-store.ts';
import {
  buildLunaAnalystWeights,
  buildRegimeAnalystBias,
} from '../shared/luna-analyst-weight-policy.ts';
import { REGIME_GUIDES } from '../shared/market-regime.ts';
import { publishAlert } from '../shared/alert-publisher.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(INVESTMENT_DIR, '..', '..');
const KILL_SWITCHES = [
  'LUNA_V2_ENABLED',
  'LUNA_MAPEK_ENABLED',
  'LUNA_VALIDATION_ENABLED',
  'LUNA_PREDICTION_ENABLED',
];
const EXCHANGES = ['binance', 'kis', 'kis_overseas'];
const EXCHANGE_REGIME_MARKET = {
  binance: ['binance', 'crypto'],
  kis: ['kis', 'domestic'],
  kis_overseas: ['kis_overseas', 'overseas'],
};

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readYaml(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return yaml.load(text);
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readPlist(file) {
  if (!fs.existsSync(file)) return null;
  const proc = spawnSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' });
  if (proc.status !== 0 || !proc.stdout) return null;
  try {
    return JSON.parse(proc.stdout);
  } catch {
    return null;
  }
}

function launchctlGetenv(key) {
  const proc = spawnSync('launchctl', ['getenv', key], { encoding: 'utf8' });
  if (proc.status !== 0) return null;
  const value = String(proc.stdout || '').trim();
  return value || null;
}

function installedLaunchAgentPath(label) {
  return path.join(process.env.HOME || '', 'Library', 'LaunchAgents', `${label}.plist`);
}

function getEnvSnapshot() {
  const repoPlist = readPlist(path.join(INVESTMENT_DIR, 'launchd', 'ai.luna.commander.plist'));
  const installedPlist = readPlist(installedLaunchAgentPath('ai.luna.commander'));
  const repoEnv = repoPlist?.EnvironmentVariables || {};
  const installedEnv = installedPlist?.EnvironmentVariables || {};

  const switches = {};
  for (const key of KILL_SWITCHES) {
    const processValue = process.env[key] ?? null;
    const launchctlValue = launchctlGetenv(key);
    const repoValue = repoEnv[key] ?? null;
    const installedValue = installedEnv[key] ?? null;
    const durableValues = [launchctlValue, installedValue, repoValue].filter((value) => value != null);
    const durableConflict = new Set(durableValues).size > 1;
    const processConflict = launchctlValue != null && processValue != null && launchctlValue !== processValue;
    switches[key] = {
      process: processValue,
      launchctl: launchctlValue,
      repoPlist: repoValue,
      installedPlist: installedValue,
      effectiveHint: launchctlValue ?? processValue ?? installedValue ?? repoValue ?? null,
      sourceConflict: durableConflict,
      durableConflict,
      processConflict,
    };
  }
  return switches;
}

function getConfigSnapshot() {
  const configPath = path.join(INVESTMENT_DIR, 'config.yaml');
  const ignored = spawnSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', configPath]);
  const raw = readYaml(configPath) || {};
  const cm = raw.capital_management || {};
  const byExchange = {};
  for (const exchange of EXCHANGES) {
    const normal = getCapitalConfig(exchange, 'normal');
    const validation = getCapitalConfig(exchange, 'validation');
    byExchange[exchange] = {
      max_concurrent_positions: Number(normal.max_concurrent_positions || 0),
      reserve_ratio: Number(normal.reserve_ratio || 0),
      min_order_usdt: Number(normal.min_order_usdt || 0),
      validation: {
        max_concurrent_positions: Number(validation.max_concurrent_positions || 0),
        reserve_ratio: Number(validation.reserve_ratio || 0),
        min_order_usdt: Number(validation.min_order_usdt || 0),
      },
    };
  }

  return {
    path: configPath,
    gitignored: ignored.status === 0,
    reserve_ratio: Number(cm.reserve_ratio || 0),
    max_concurrent_positions: Number(cm.max_concurrent_positions || 0),
    by_exchange: byExchange,
    time_profiles: cm.time_profiles || {},
  };
}

function getAutopilotSnapshot() {
  const repoPlistPath = path.join(INVESTMENT_DIR, 'launchd', 'ai.investment.runtime-autopilot.plist');
  const installedPlistPath = installedLaunchAgentPath('ai.investment.runtime-autopilot');
  const repoPlist = readPlist(repoPlistPath);
  const installedPlist = readPlist(installedPlistPath);
  const history = readPositionRuntimeAutopilotHistorySummary();
  const lines = history.current ? [history.previous, history.current].filter(Boolean) : [];
  const current = history.current || null;

  return {
    repoPlist: {
      path: repoPlistPath,
      exists: !!repoPlist,
      startIntervalSeconds: Number(repoPlist?.StartInterval || 0) || null,
      programArguments: repoPlist?.ProgramArguments || [],
    },
    installedPlist: {
      path: installedPlistPath,
      exists: !!installedPlist,
      startIntervalSeconds: Number(installedPlist?.StartInterval || 0) || null,
      programArguments: installedPlist?.ProgramArguments || [],
    },
    history: {
      file: history.file,
      historyCount: history.historyCount,
      latestRecordedAt: current?.recordedAt || null,
      latestStatus: current?.status || null,
      latestExchangeSummary: current?.exchangeSummary || {},
      latestDispatchByExchange: current?.dispatchByExchange || {},
      latestCadenceRecommendationByExchange: current?.cadenceRecommendationByExchange || {},
      lastTwoRecordedAt: lines.map((item) => item.recordedAt || null),
    },
  };
}

async function getRegimeRows() {
  const capture = readJson(path.join(INVESTMENT_DIR, 'output', 'ops', 'market-regime-capture.json'));
  const opsRows = (capture?.rows || []).map((row) => ({
    source: 'ops_file',
    market: row.market,
    regime: row.regime,
    confidence: Number(row.confidence || 0),
    capturedAt: row.capturedAt || null,
    reason: row.reason || null,
    tradingStyle: row.tradingStyle || null,
  }));

  try {
    const rows = await pgPool.query('investment', `
      SELECT market, regime, confidence, captured_at, indicators
      FROM investment.market_regime_snapshots
      WHERE captured_at >= NOW() - INTERVAL '24 hours'
      ORDER BY market, captured_at ASC
      LIMIT 200
    `, []);
    if (Array.isArray(rows) && rows.length > 0) {
      const dbRows = rows.map((row) => ({
        source: 'db',
        market: row.market,
        regime: row.regime,
        confidence: Number(row.confidence || 0),
        capturedAt: row.captured_at || row.capturedAt || null,
      }));
      const observedMarkets = new Set(dbRows.map((row) => row.market));
      const missingOpsRows = opsRows.filter((row) => !observedMarkets.has(row.market));
      return [...dbRows, ...missingOpsRows];
    }
  } catch {}

  return opsRows;
}

function summarizeRegimeTransitions(rows = []) {
  const byMarket = new Map();
  for (const row of rows) {
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market).push(row);
  }

  const transitions = [];
  for (const [market, marketRows] of byMarket.entries()) {
    let prev = null;
    for (const row of marketRows) {
      if (prev && prev.regime !== row.regime) {
        transitions.push({
          market,
          from: prev.regime,
          to: row.regime,
          at: row.capturedAt,
          confidence: row.confidence,
        });
      }
      prev = row;
    }
  }
  return transitions;
}

function getAnalystWeightSnapshot() {
  const weights = {};
  for (const exchange of EXCHANGES) {
    weights[exchange] = {
      ranging: buildLunaAnalystWeights(exchange, { marketRegime: { regime: 'ranging' } }),
      trending_bull: buildLunaAnalystWeights(exchange, { marketRegime: { regime: 'trending_bull' } }),
      trending_bear: buildLunaAnalystWeights(exchange, { marketRegime: { regime: 'trending_bear' } }),
      volatile: buildLunaAnalystWeights(exchange, { marketRegime: { regime: 'volatile' } }),
    };
  }
  return {
    weights,
    regimeBiases: {
      ranging: buildRegimeAnalystBias({ regime: 'ranging' }),
      trending_bull: buildRegimeAnalystBias({ regime: 'trending_bull' }),
      trending_bear: buildRegimeAnalystBias({ regime: 'trending_bear' }),
      volatile: buildRegimeAnalystBias({ regime: 'volatile' }),
    },
  };
}

function getHephaestosModuleReview() {
  const file = path.join(INVESTMENT_DIR, 'team', 'hephaestos.ts');
  const text = readText(file) || '';
  const bytes = Buffer.byteLength(text, 'utf8');
  const lineCount = text ? text.split('\n').length : 0;
  return {
    file,
    bytes,
    lineCount,
    splitRecommended: bytes >= 200_000 || lineCount >= 4_000,
    suggestedModules: [
      'execution-normalizer',
      'pending-reconcile-queue',
      'btc-pair-execution',
      'manual-reconcile-alerts',
    ],
  };
}

function getNewFundsObservation(autopilot) {
  const exchangeSummary = autopilot?.history?.latestExchangeSummary || {};
  const dispatchByExchange = autopilot?.history?.latestDispatchByExchange || {};
  return {
    mode: 'observation_only',
    contract: '신규 입금은 capital snapshot의 buyableAmount/remainingSlots 회복 후 discovery/dispatch 후보가 재개되는지 관찰한다.',
    latestExchangeSummary: exchangeSummary,
    latestDispatchByExchange: dispatchByExchange,
    observedBuyCandidateMarkets: Object.fromEntries(
      EXCHANGES.map((exchange) => [
        exchange,
        Number(dispatchByExchange?.[exchange]?.candidates || 0),
      ]),
    ),
  };
}

function getRegimeExpansionReview() {
  const currentRegimes = Object.keys(REGIME_GUIDES || {});
  const optionalEightWay = [
    'low_volatility_bull',
    'low_volatility_bear',
    'high_volatility_bull',
    'high_volatility_bear',
  ];
  return {
    currentRegimeCount: currentRegimes.length,
    currentRegimes,
    eightWayExpansionRequiredNow: false,
    optionalAdditions: optionalEightWay,
    note: '현재 운영 회귀는 4-way regime 기준으로 고정한다. 저/고변동 세분화는 관측 데이터가 충분해진 뒤 별도 전환한다.',
  };
}

export async function buildLunaL5ReadinessReport() {
  const regimeRows = await getRegimeRows();
  const warnings = [];
  const killSwitches = getEnvSnapshot();
  const autopilot = getAutopilotSnapshot();
  const config = getConfigSnapshot();

  for (const key of ['LUNA_MAPEK_ENABLED', 'LUNA_VALIDATION_ENABLED', 'LUNA_PREDICTION_ENABLED']) {
    if (killSwitches[key]?.effectiveHint !== 'true') {
      warnings.push(`${key} is not fully enabled`);
    }
  }
  if (!config.gitignored) warnings.push('bots/investment/config.yaml is not gitignored');
  if (!autopilot.repoPlist.startIntervalSeconds) warnings.push('runtime-autopilot launchd StartInterval not found');
  if (regimeRows.length === 0) warnings.push('no regime capture rows found for last 24h or ops fallback');

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    warnings,
    G1_killSwitches: killSwitches,
    G2_runtimeAutopilot: autopilot,
    G3_config: config,
    G4_regimeCapture24h: {
      rowCount: regimeRows.length,
      latestByMarket: Object.fromEntries(
        EXCHANGES.map((exchange) => [
          exchange,
          regimeRows
            .filter((row) => (EXCHANGE_REGIME_MARKET[exchange] || [exchange]).includes(row.market))
            .at(-1) || null,
        ]),
      ),
      transitions: summarizeRegimeTransitions(regimeRows),
    },
    G5_analystWeights: getAnalystWeightSnapshot(),
    R2_hephaestosModuleSplitReview: getHephaestosModuleReview(),
    R4_newFundsObservation: getNewFundsObservation(autopilot),
    R5_regimeExpansionReview: getRegimeExpansionReview(),
  };
}

export function renderLunaL5ReadinessReport(report) {
  const switches = report.G1_killSwitches || {};
  const autopilot = report.G2_runtimeAutopilot || {};
  const config = report.G3_config || {};
  const regimes = report.G4_regimeCapture24h || {};
  const hephaestos = report.R2_hephaestosModuleSplitReview || {};
  const warnings = report.warnings || [];
  return [
    '🌙 루나 L5 readiness',
    `checkedAt: ${report.checkedAt}`,
    `warnings: ${warnings.length ? warnings.join(' / ') : 'none'}`,
    '',
    `kill-switch: V2=${switches.LUNA_V2_ENABLED?.effectiveHint || 'unset'} / MAPEK=${switches.LUNA_MAPEK_ENABLED?.effectiveHint || 'unset'} / validation=${switches.LUNA_VALIDATION_ENABLED?.effectiveHint || 'unset'} / prediction=${switches.LUNA_PREDICTION_ENABLED?.effectiveHint || 'unset'}`,
    `autopilot: interval=${autopilot.repoPlist?.startIntervalSeconds || 'n/a'}s / latest=${autopilot.history?.latestRecordedAt || 'n/a'} / status=${autopilot.history?.latestStatus || 'n/a'}`,
    `capital: reserve=${config.reserve_ratio ?? 'n/a'} / binance max=${config.by_exchange?.binance?.max_concurrent_positions ?? 'n/a'} / kis max=${config.by_exchange?.kis?.max_concurrent_positions ?? 'n/a'} / overseas max=${config.by_exchange?.kis_overseas?.max_concurrent_positions ?? 'n/a'}`,
    `regime: rows=${regimes.rowCount || 0} / transitions=${(regimes.transitions || []).length}`,
    `hephaestos: ${hephaestos.lineCount || 'n/a'} lines / splitRecommended=${hephaestos.splitRecommended === true}`,
  ].join('\n');
}

export async function publishLunaL5ReadinessReport(report) {
  const message = renderLunaL5ReadinessReport(report);
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: (report.warnings || []).length > 0 ? 2 : 1,
    message,
    payload: {
      checkedAt: report.checkedAt,
      warnings: report.warnings || [],
      killSwitches: Object.fromEntries(Object.entries(report.G1_killSwitches || {}).map(([key, value]) => [
        key,
        value?.effectiveHint ?? null,
      ])),
      autopilot: {
        latestRecordedAt: report.G2_runtimeAutopilot?.history?.latestRecordedAt || null,
        latestStatus: report.G2_runtimeAutopilot?.history?.latestStatus || null,
      },
    },
  });
}

async function main() {
  const result = await buildLunaL5ReadinessReport();
  if (process.argv.includes('--telegram')) {
    await publishLunaL5ReadinessReport(result);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (!process.argv.includes('--telegram')) {
    console.log(`luna L5 readiness report ok (${result.warnings.length} warning(s))`);
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna L5 readiness report 실패:',
  });
}
