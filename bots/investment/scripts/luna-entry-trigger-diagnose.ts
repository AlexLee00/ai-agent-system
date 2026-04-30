#!/usr/bin/env node
// @ts-nocheck
/**
 * luna-entry-trigger-diagnose.ts — Phase Z1: fired=0 원인 진단 도구
 *
 * 현재 시점에 fire 가능한 시그널 후보 출력 + 차단 사유 별도 카운트.
 * 마스터 진단·의사결정 전용 도구.
 *
 * 사용법:
 *   tsx bots/investment/scripts/luna-entry-trigger-diagnose.ts
 *   tsx bots/investment/scripts/luna-entry-trigger-diagnose.ts --json
 *   tsx bots/investment/scripts/luna-entry-trigger-diagnose.ts --verbose
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import { getLunaIntelligentDiscoveryFlags } from '../shared/luna-intelligent-discovery-config.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_DIR = path.resolve(__dirname, '..');
const HEARTBEAT_PATH = path.join(INVESTMENT_DIR, 'output', 'ops', 'luna-entry-trigger-worker-heartbeat.json');

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
    exchange: argv.find((a) => a.startsWith('--exchange='))?.split('=')[1] || 'binance',
    hours: Number(argv.find((a) => a.startsWith('--hours='))?.split('=')[1] || 24),
  };
}

function readHeartbeat(file: string) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function heartbeatAgeMinutes(heartbeat: any): number | null {
  const ts = heartbeat?.checkedAt || heartbeat?.startedAt;
  if (!ts) return null;
  return Math.round((Date.now() - new Date(ts).getTime()) / 60000);
}

function getLaunchctlEnv(key: string): string | null {
  try {
    return execFileSync('launchctl', ['getenv', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function resolveEffectiveEnv(key: string): string | null {
  return process.env[key] || getLaunchctlEnv(key) || null;
}

async function getActiveEntryTriggers(exchange: string) {
  try {
    await db.initSchema();
    const rows = await db.query(
      `SELECT id, symbol, exchange, trigger_type, trigger_state, confidence,
              predictive_score, target_price, expires_at, fired_at,
              created_at, updated_at, trigger_context
         FROM entry_triggers
        WHERE exchange = $1
          AND trigger_state IN ('armed', 'waiting')
        ORDER BY created_at DESC
        LIMIT 50`,
      [exchange],
    );
    return rows || [];
  } catch (err: any) {
    return [];
  }
}

async function getRecentFiredTriggers(exchange: string, hours: number) {
  try {
    const rows = await db.query(
      `SELECT id, symbol, trigger_type, fired_at, confidence, trigger_state
         FROM entry_triggers
        WHERE exchange = $1
          AND trigger_state = 'fired'
          AND fired_at >= NOW() - INTERVAL '${Math.max(1, hours)} hours'
        ORDER BY fired_at DESC
        LIMIT 20`,
      [exchange],
    );
    return rows || [];
  } catch {
    return [];
  }
}

async function getReflexionCount() {
  try {
    const row = await db.get(
      `SELECT COUNT(*)::int AS cnt FROM investment.luna_failure_reflexions WHERE created_at >= NOW() - INTERVAL '30 days'`,
      [],
    );
    return Number(row?.cnt || 0);
  } catch {
    return 0;
  }
}

async function getReflexionPatterns() {
  try {
    const rows = await db.query(
      `SELECT avoid_pattern, trade_id, created_at
         FROM investment.luna_failure_reflexions
        ORDER BY created_at DESC
        LIMIT 10`,
      [],
    );
    return (rows || []).map((r: any) => ({
      tradeId: r.trade_id,
      pattern: r.avoid_pattern,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

async function getBudgetStatus() {
  try {
    const today = await db.get(
      `SELECT COUNT(*)::int AS cnt
         FROM investment.mapek_knowledge
        WHERE event_type IN ('quality_evaluation_result', 'reflexion_created', 'quality_evaluation_failed')
          AND created_at >= NOW()::date`,
      [],
    ).catch(() => ({ cnt: 0 }));
    return {
      todayLlmCallsEstimate: Number(today?.cnt || 0),
      estimatedCostUsd: Number(today?.cnt || 0) * 0.03,
    };
  } catch {
    return { todayLlmCallsEstimate: 0, estimatedCostUsd: 0 };
  }
}

async function getCooldownStatus(exchange: string) {
  try {
    const recentFired = await db.query(
      `SELECT symbol, fired_at
         FROM entry_triggers
        WHERE exchange = $1
          AND trigger_state = 'fired'
          AND fired_at >= NOW() - INTERVAL '60 minutes'
        ORDER BY fired_at DESC`,
      [exchange],
    );
    return {
      recentFiredCount: (recentFired || []).length,
      recentFiredSymbols: (recentFired || []).map((r: any) => r.symbol),
    };
  } catch {
    return { recentFiredCount: 0, recentFiredSymbols: [] };
  }
}

function diagnoseBlockReasons(flags: any, activeTriggers: any[], env: Record<string, string | null>) {
  const blocks: Record<string, number> = {
    predictive_blocked: 0,
    regime_blocked: 0,
    budget_blocked: 0,
    reflexion_blocked: 0,
    cooldown_blocked: 0,
    confidence_blocked: 0,
    live_gate_blocked: 0,
    no_events_blocked: 0,
    mode_shadow: 0,
  };
  const issues: string[] = [];

  // 1. shadow 모드 점검
  if (flags.shadow) {
    blocks.mode_shadow = activeTriggers.length;
    issues.push(`[mode=shadow] allowLiveFire=false → 모든 fire 차단. LUNA_INTELLIGENT_DISCOVERY_MODE=autonomous_l5 필요`);
  }

  // 2. 이벤트 소스 없음 (worker가 --derive-market-events 없이 실행)
  const workerMode = env['LUNA_INTELLIGENT_DISCOVERY_MODE'] || 'shadow';
  if (workerMode !== 'autonomous_l5' && workerMode !== 'autonomous') {
    blocks.no_events_blocked = activeTriggers.length;
    issues.push(`[mode=${workerMode}] autonomous_l5 아님 → live fire 미허용`);
  }

  // 3. predictive validation
  const predMode = env['LUNA_PREDICTIVE_VALIDATION_MODE'] || 'advisory';
  const predRequired = (env['LUNA_PREDICTIVE_REQUIRE_COMPONENTS'] || 'false').toLowerCase() === 'true';
  if (predMode === 'hard_gate') {
    if (predRequired) {
      blocks.predictive_blocked = activeTriggers.filter((t) => !t.predictive_score || Number(t.predictive_score) < 0.55).length;
      if (blocks.predictive_blocked > 0) {
        issues.push(`[predictive_hard_gate + require_components=true] predictive_score 없거나 낮음 → ${blocks.predictive_blocked}개 트리거 차단`);
      }
    } else {
      const lowScore = activeTriggers.filter((t) => t.predictive_score != null && Number(t.predictive_score) < 0.55).length;
      if (lowScore > 0) {
        blocks.predictive_blocked = lowScore;
        issues.push(`[predictive_hard_gate] predictive_score < 0.55 → ${lowScore}개 트리거 차단`);
      }
    }
  }

  // 4. 최소 confidence 점검
  const minConf = Number(env['LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE'] || 0.48);
  const lowConfTriggers = activeTriggers.filter((t) => Number(t.confidence || 0) < minConf);
  if (lowConfTriggers.length > 0) {
    blocks.confidence_blocked = lowConfTriggers.length;
    issues.push(`[min_confidence=${minConf}] confidence 부족 → ${lowConfTriggers.length}개 차단`);
  }

  // 5. fire 조건 미충족 (breakoutRetest / volumeBurst / mtfAgreement)
  const noFireCondition = activeTriggers.filter((t) => {
    const hints = t.trigger_context?.hints || {};
    const mtf = Number(hints.mtfAgreement || 0);
    const discovery = Number(hints.discoveryScore || 0);
    const volume = Number(hints.volumeBurst || 0);
    const breakout = hints.breakoutRetest === true;
    const newsMomentum = Number(hints.newsMomentum || 0);
    return !(
      (breakout && mtf >= 0.62) ||
      (volume >= 1.8 && mtf >= 0.58) ||
      (newsMomentum >= 0.6 && discovery >= 0.62) ||
      (mtf >= 0.72 && discovery >= 0.58)
    );
  });
  if (noFireCondition.length > 0) {
    blocks.live_gate_blocked = noFireCondition.length;
    issues.push(`[fire_condition_unmet] mtf/volume/breakout 조건 미충족 → ${noFireCondition.length}개 관망 중`);
  }

  return { blocks, issues };
}

function renderActiveTrigger(t: any, verbose: boolean) {
  const hints = t.trigger_context?.hints || {};
  const lines = [
    `  ${t.symbol} [${t.trigger_type}] state=${t.trigger_state} conf=${Number(t.confidence || 0).toFixed(2)} pred=${t.predictive_score != null ? Number(t.predictive_score).toFixed(2) : 'n/a'}`,
  ];
  if (verbose) {
    lines.push(`    mtf=${Number(hints.mtfAgreement || 0).toFixed(2)} disc=${Number(hints.discoveryScore || 0).toFixed(2)} vol=${Number(hints.volumeBurst || 0).toFixed(2)} breakout=${hints.breakoutRetest === true}`);
    lines.push(`    expires=${t.expires_at ? new Date(t.expires_at).toLocaleString('ko-KR') : 'n/a'} created=${t.created_at ? new Date(t.created_at).toLocaleString('ko-KR') : 'n/a'}`);
  }
  return lines.join('\n');
}

export async function runLunaEntryTriggerDiagnose({
  exchange = 'binance',
  hours = 24,
  verbose = false,
} = {}) {
  await db.initSchema();

  const flags = getLunaIntelligentDiscoveryFlags();
  const heartbeat = readHeartbeat(HEARTBEAT_PATH);
  const hbAge = heartbeatAgeMinutes(heartbeat);
  const hbResult = heartbeat?.result || {};
  const hbLastFire = heartbeat?.lastFire || null;

  const envKeys = [
    'LUNA_INTELLIGENT_DISCOVERY_MODE',
    'LUNA_ENTRY_TRIGGER_ENGINE_ENABLED',
    'LUNA_ENTRY_TRIGGER_THRESHOLD',
    'LUNA_PREDICTIVE_VALIDATION_MODE',
    'LUNA_PREDICTIVE_VALIDATION_THRESHOLD',
    'LUNA_PREDICTIVE_REQUIRE_COMPONENTS',
    'LUNA_ENTRY_TRIGGER_MIN_CONFIDENCE',
    'LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS',
    'LUNA_AGENT_REFLEXION_AUTO_AVOID',
  ];
  const env: Record<string, string | null> = {};
  for (const key of envKeys) {
    env[key] = resolveEffectiveEnv(key);
  }

  const [activeTriggers, recentFired, reflexionCount, reflexionPatterns, budgetStatus, cooldownStatus] = await Promise.allSettled([
    getActiveEntryTriggers(exchange),
    getRecentFiredTriggers(exchange, hours),
    getReflexionCount(),
    getReflexionPatterns(),
    getBudgetStatus(),
    getCooldownStatus(exchange),
  ]).then((results) => results.map((r) => (r.status === 'fulfilled' ? r.value : null)));

  const { blocks, issues } = diagnoseBlockReasons(flags, activeTriggers || [], env);
  const hasActiveTriggers = (activeTriggers || []).length > 0;
  const hasHeartbeatFire = Number(hbResult.fired || 0) > 0 || Number(hbLastFire?.fired || 0) > 0;
  const hasRecentFire = (recentFired || []).length > 0;
  const readinessStatus = issues.length > 0
    ? 'blocked'
    : hasActiveTriggers
      ? 'armed'
      : hasHeartbeatFire || hasRecentFire
        ? 'recently_fired'
        : 'waiting_for_candidate';

  const diagnosis = {
    ok: issues.length === 0,
    readinessStatus,
    checkedAt: new Date().toISOString(),
    exchange,
    mode: flags.mode,
    allowLiveFire: flags.shouldAllowLiveEntryFire?.() ?? !flags.shadow,
    heartbeat: {
      ageMinutes: hbAge,
      fired: Number(hbResult.fired || 0),
      checked: Number(hbResult.checked || 0),
      readyBlocked: Number(hbResult.readyBlocked || 0),
      eventSource: heartbeat?.eventSource || 'none',
      lastFire: hbLastFire,
    },
    activeTriggers: {
      count: (activeTriggers || []).length,
      symbols: (activeTriggers || []).map((t: any) => t.symbol),
    },
    recentFired: {
      count: (recentFired || []).length,
      hours,
      symbols: (recentFired || []).map((t: any) => t.symbol),
    },
    blockSummary: blocks,
    issues,
    env: Object.fromEntries(
      Object.entries(env).map(([k, v]) => [k, v ?? '(not set)']),
    ),
    reflexion: {
      last30dCount: reflexionCount || 0,
      patterns: verbose ? (reflexionPatterns || []) : (reflexionPatterns || []).slice(0, 3),
    },
    budget: budgetStatus || { todayLlmCallsEstimate: 0, estimatedCostUsd: 0 },
    cooldown: cooldownStatus || { recentFiredCount: 0, recentFiredSymbols: [] },
    triggers: verbose ? (activeTriggers || []) : (activeTriggers || []).slice(0, 5),
  };

  return diagnosis;
}

async function main() {
  const args = parseArgs();
  const diagnosis = await runLunaEntryTriggerDiagnose({
    exchange: args.exchange,
    hours: args.hours,
    verbose: args.verbose,
  });

  if (args.json) {
    console.log(JSON.stringify(diagnosis, null, 2));
    return;
  }

  const hb = diagnosis.heartbeat;
  const env = diagnosis.env;
  console.log('');
  console.log('🔍 Luna Entry Trigger 진단 리포트');
  console.log('='.repeat(50));
  console.log(`checkedAt: ${diagnosis.checkedAt}`);
  console.log(`exchange:  ${diagnosis.exchange}`);
  console.log(`mode:      ${diagnosis.mode}`);
  console.log(`allowLiveFire: ${diagnosis.allowLiveFire}`);
  console.log('');
  console.log('📊 Heartbeat 상태');
  console.log(`  최신 heartbeat: ${hb.ageMinutes != null ? `${hb.ageMinutes}분 전` : '없음'}`);
  console.log(`  eventSource: ${hb.eventSource}`);
  console.log(`  checked=${hb.checked} / fired=${hb.fired} / readyBlocked=${hb.readyBlocked}`);
  console.log('');
  console.log('🎯 활성 트리거');
  console.log(`  count: ${diagnosis.activeTriggers.count}`);
  if ((diagnosis.triggers || []).length > 0) {
    for (const t of diagnosis.triggers) {
      console.log(renderActiveTrigger(t, args.verbose));
    }
  } else {
    console.log('  (활성 트리거 없음)');
  }
  console.log('');
  console.log('🔥 최근 fired');
  console.log(`  last ${diagnosis.recentFired.hours}h: ${diagnosis.recentFired.count}건`);
  if (diagnosis.recentFired.symbols.length > 0) {
    console.log(`  symbols: ${diagnosis.recentFired.symbols.join(', ')}`);
  }
  console.log('');
  console.log('🚧 차단 사유 분석');
  for (const [reason, count] of Object.entries(diagnosis.blockSummary)) {
    if (count > 0) console.log(`  ${reason}: ${count}건`);
  }
  if (Object.values(diagnosis.blockSummary).every((v) => v === 0)) {
    console.log('  (명확한 차단 사유 없음 — 이벤트 발생 대기 중일 가능성)');
  }
  console.log('');
  console.log('⚠️  진단 이슈');
  if (diagnosis.issues.length === 0) {
    console.log('  없음');
  } else {
    for (const issue of diagnosis.issues) {
      console.log(`  • ${issue}`);
    }
  }
  console.log('');
  console.log('🌍 환경 변수 현황');
  for (const [key, val] of Object.entries(env)) {
    console.log(`  ${key}: ${val}`);
  }
  console.log('');
  console.log('🧠 Reflexion 상태');
  console.log(`  최근 30일 실패 기록: ${diagnosis.reflexion.last30dCount}건`);
  if (diagnosis.reflexion.patterns.length > 0) {
    for (const p of diagnosis.reflexion.patterns) {
      const pat = typeof p.pattern === 'string' ? JSON.parse(p.pattern) : (p.pattern || {});
      console.log(`  - trade#${p.tradeId}: ${pat.symbol_pattern || 'n/a'} / ${pat.avoid_action || 'n/a'}`);
    }
  }
  console.log('');
  console.log('💰 오늘 LLM 예산');
  console.log(`  호출 추정: ${diagnosis.budget.todayLlmCallsEstimate}건 (~$${diagnosis.budget.estimatedCostUsd.toFixed(3)})`);
  console.log('');
  console.log(`결론: ${diagnosis.ok ? `✅ 정상 (${diagnosis.readinessStatus})` : `⚠️  조치 필요 (${diagnosis.readinessStatus})`}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-entry-trigger-diagnose 실패:',
  });
}
