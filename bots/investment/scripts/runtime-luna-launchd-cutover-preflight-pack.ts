#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaFullIntegrationClosureGate } from './runtime-luna-full-integration-closure-gate.ts';
import { buildPosttradeFeedbackL5Gate } from './runtime-posttrade-feedback-l5-gate.ts';
import { buildAgentMemoryDashboard } from './runtime-agent-memory-dashboard.ts';
import { runAgentMemoryRouteQuality } from './runtime-agent-memory-route-quality.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function launchctlList() {
  try {
    return execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 });
  } catch {
    return '';
  }
}

function telegramReadiness(env = process.env) {
  const hasHub = Boolean(env.HUB_BASE_URL || env.AI_AGENT_HUB_URL);
  const hasTelegramRoute = Boolean(env.TELEGRAM_BOT_TOKEN || env.HUB_ALARM_TELEGRAM_ENABLED || env.TELEGRAM_ALARM_TOPIC_MAP);
  return {
    ok: hasHub || hasTelegramRoute,
    status: hasHub || hasTelegramRoute ? 'telegram_route_config_detected' : 'telegram_route_config_missing',
    checkedSecrets: false,
    evidence: {
      hubUrlConfigured: hasHub,
      telegramRouteConfigured: hasTelegramRoute,
    },
  };
}

export function buildLunaLaunchdCutoverPreflightPackFromReports({
  closure = {},
  launchdListText = '',
  llmRoute = {},
  telegram = telegramReadiness({}),
  posttrade = {},
  memory = {},
} = {}) {
  const requiredLabels = ['ai.luna.tradingview-ws', 'ai.investment.commander'];
  const visible = requiredLabels.filter((label) => String(launchdListText || '').includes(label));
  const missing = requiredLabels.filter((label) => !visible.includes(label));
  const blockers = [
    ...(closure.hardBlockers || []).map((item) => `closure:${item}`),
    ...missing.map((label) => `launchd_missing:${label}`),
    ...(llmRoute.ok === false ? ['llm_route_quality_blocked'] : []),
    ...(telegram.ok === false ? ['telegram_route_missing'] : []),
    ...(posttrade.ok === false ? (posttrade.blockers || ['posttrade_l5_blocked']).map((item) => `posttrade:${item}`) : []),
    ...(memory.readiness?.blockers || []).map((item) => `agent_memory:${item}`),
  ];
  const warnings = [
    ...(closure.pendingObservation || []).map((item) => `pending:${item}`),
    ...(llmRoute.suggestions || []).map((item) => `llm_route:${item.code || item.reason || 'suggestion'}`),
    ...(memory.readiness?.warnings || []).map((item) => `agent_memory:${item}`),
  ];
  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'launchd_cutover_preflight_clear' : 'launchd_cutover_preflight_blocked',
    cutoverApplied: false,
    liveTradeCommandsExecuted: false,
    requiredLabels,
    visible,
    missing,
    blockers,
    warnings,
    nextActions: blockers.length === 0
      ? ['cutover is technically clear but still requires separate master approval']
      : ['resolve blockers; do not unload/load launchd services yet'],
    evidence: {
      closure: {
        ok: closure.ok === true,
        operationalStatus: closure.operationalStatus || null,
        hardBlockers: closure.hardBlockers || [],
      },
      llmRoute: {
        status: llmRoute.status || null,
        ok: llmRoute.ok ?? null,
      },
      telegram,
      posttrade: {
        status: posttrade.status || null,
        ok: posttrade.ok ?? null,
      },
      memory: {
        status: memory.status || null,
        readiness: memory.readiness || {},
      },
    },
  };
}

export async function buildLunaLaunchdCutoverPreflightPack({ validationFixture = false } = {}) {
  const [closure, llmRoute, posttrade, memory] = await Promise.all([
    buildLunaFullIntegrationClosureGate({ includeValidationFixture: validationFixture }),
    runAgentMemoryRouteQuality({ dryRun: true, days: 3, market: 'all', minCalls: 3 }).catch((error) => ({
      ok: false,
      status: 'llm_route_quality_failed',
      suggestions: [{ code: `error:${error?.message || String(error)}` }],
    })),
    buildPosttradeFeedbackL5Gate({ strict: false }).catch((error) => ({
      ok: false,
      status: 'posttrade_l5_gate_failed',
      blockers: [`error:${error?.message || String(error)}`],
    })),
    buildAgentMemoryDashboard({ days: 7, market: 'all' }).catch((error) => ({
      ok: false,
      status: 'agent_memory_dashboard_failed',
      readiness: { blockers: [`error:${error?.message || String(error)}`], warnings: [] },
    })),
  ]);
  return buildLunaLaunchdCutoverPreflightPackFromReports({
    closure,
    launchdListText: launchctlList(),
    llmRoute,
    telegram: telegramReadiness(),
    posttrade,
    memory,
  });
}

export async function runLunaLaunchdCutoverPreflightPackSmoke() {
  const blocked = buildLunaLaunchdCutoverPreflightPackFromReports({
    closure: { ok: false, operationalStatus: 'blocked', hardBlockers: ['reconcile:LUNC/USDT'] },
    launchdListText: '123\t0\tai.luna.tradingview-ws\n',
    llmRoute: { ok: true, status: 'ok', suggestions: [] },
    telegram: { ok: false, status: 'missing' },
    posttrade: { ok: true, status: 'ok', blockers: [] },
    memory: { status: 'attention', readiness: { blockers: [], warnings: ['curriculum_state_empty'] } },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.cutoverApplied, false);
  assert.ok(blocked.blockers.includes('launchd_missing:ai.investment.commander'));
  assert.ok(blocked.blockers.includes('telegram_route_missing'));
  assert.ok(blocked.blockers.some((item) => item.includes('reconcile:LUNC/USDT')));

  const clear = buildLunaLaunchdCutoverPreflightPackFromReports({
    closure: { ok: true, operationalStatus: 'operational_complete', hardBlockers: [] },
    launchdListText: '123\t0\tai.luna.tradingview-ws\n456\t0\tai.investment.commander\n',
    llmRoute: { ok: true, status: 'ok', suggestions: [] },
    telegram: { ok: true, status: 'ok' },
    posttrade: { ok: true, status: 'ok', blockers: [] },
    memory: { status: 'ready', readiness: { blockers: [], warnings: [] } },
  });
  assert.equal(clear.ok, true);
  assert.equal(clear.status, 'launchd_cutover_preflight_clear');
  assert.equal(clear.liveTradeCommandsExecuted, false);
  return { ok: true, blocked, clear };
}

async function main() {
  const smoke = hasFlag('--smoke');
  const result = smoke ? await runLunaLaunchdCutoverPreflightPackSmoke() : await buildLunaLaunchdCutoverPreflightPack({
    validationFixture: hasFlag('--validation-fixture'),
  });
  if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
  else if (smoke) console.log('luna launchd cutover preflight pack smoke ok');
  else console.log(`${result.status} blockers=${result.blockers.length}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna launchd cutover preflight pack 실패:',
  });
}
