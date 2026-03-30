/**
 * markets/overseas.js — 미국주식 30분 사이클 (Phase 3-B)
 *
 * 파이프라인:
 *   1. 장중 여부 확인 (NYSE/NASDAQ, 서머타임 자동 반영)
 *   2. 30분 주기 확인
 *   3. [병렬] 아리아(TA 일봉/1h) + 헤르메스(Yahoo/MarketWatch) + 소피아(Reddit)
 *   4. 루나 오케스트레이터 (최종 신호 판단)
 *   5. 한울 실행 (KIS 해외주식, PAPER_MODE: DB + 텔레그램만)
 *
 * launchd: ai.investment.overseas (5분 주기 — 내부 30분 스로틀 + 장중 체크)
 * 실행: PAPER_MODE=true node markets/overseas.js [--symbols=AAPL,TSLA,NVDA] [--force]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadPreScreened, loadPreScreenedFallback, savePreScreened, saveResearchWatchlist } from '../scripts/pre-market-screen.js';

import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
import * as db from '../shared/db.js';
import { initHubSecrets, getKisOverseasSymbols, getKisOverseasMarketStatus, getKisExecutionModeInfo, getOverseasScreeningMaxDynamic } from '../shared/secrets.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import { tracker } from '../shared/cost-tracker.js';
import { resolveSymbolsWithFallback, appendHeldSymbols, capDynamicUniverse } from '../shared/universe-fallback.js';
import { buildCollectAlertMessage, runMarketCollectPipeline, summarizeNodeStatuses } from '../shared/pipeline-market-runner.js';
import { runDecisionExecutionPipeline } from '../shared/pipeline-decision-runner.js';
import { finishPipelineRun } from '../shared/pipeline-db.js';

import { processAllPendingKisOverseasSignals } from '../team/hanul.js';

process.env.INVESTMENT_MARKET = 'overseas';

// ─── 30분 주기 상태 파일 ────────────────────────────────────────────

const STATE_FILE     = join(homedir(), '.openclaw', 'investment-overseas-state.json');
const CYCLE_INTERVAL = 30 * 60 * 1000;  // 30분

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastCycleAt: 0 }; }
}

function saveState(state) {
  try {
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn(`  ⚠️ 상태 저장 실패: ${e.message}`);
  }
}

function shouldRunCycle(force = false) {
  if (force) return { run: true, reason: '--force 옵션' };
  const state = loadState();
  const now   = Date.now();
  if (now - state.lastCycleAt >= CYCLE_INTERVAL) {
    return { run: true, reason: '30분 정규 사이클' };
  }
  const remainMin = Math.ceil((CYCLE_INTERVAL - (now - state.lastCycleAt)) / 60000);
  const lastTime  = state.lastCycleAt > 0
    ? kst.toKST(new Date(state.lastCycleAt))
    : '없음';
  console.log(`⏳ 다음 사이클까지 ${remainMin}분 (마지막: ${lastTime})`);
  return { run: false, reason: `대기 중 (${remainMin}분 남음)` };
}

// ─── 예산 초과 리스너 ────────────────────────────────────────────────

tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  const label = type === 'daily' ? '일일' : '월간';
  const cost  = tracker.getToday();
  const msg   = `💸 [예산 초과] ${label} LLM 예산 초과 — 미국주식 사이클 중단\n일간: $${cost.usage.toFixed(4)} | 월간: $${cost.monthUsage.toFixed(4)}`;
  console.error(msg);
  publishToMainBot({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: msg });
  process.exit(1);
});

// ─── 메인 사이클 ────────────────────────────────────────────────────

/**
 * 미국주식 사이클 전체 실행
 * @param {string[]} symbols  ex) ['AAPL', 'TSLA', 'NVDA']
 */
export async function runOverseasCycle(symbols) {
  await initHubSecrets();
  const { paper: paperMode, tag } = getKisExecutionModeInfo('해외주식');
  const startTime = Date.now();
  let sessionId = null;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🗽 ${tag} 미국주식 사이클 시작 — ${kst.toKST(new Date())}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // ── 단계 1: 노드 기반 수집 실행 ──
    console.log('\n📊 [분석 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'kis_overseas',
      symbols,
      triggerType: 'cycle',
      meta: { market_script: 'overseas' },
    });
    sessionId = collect.sessionId;
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logPipelineMetrics('미국주식 수집', collect.metrics);

    // ── 단계 2: 루나 오케스트레이터 ──
    console.log('\n🌙 [판단 단계] 루나 오케스트레이터 실행...');
    const decision = await runDecisionExecutionPipeline({
      sessionId: collect.sessionId,
      symbols,
      exchange: 'kis_overseas',
    });
    const results = decision.results;
    const executedResults = results.filter(item => !item.skipped);
    await logPipelineMetrics('미국주식 판단', decision.metrics);

    // ── 단계 3: 한울 실행 (PAPER_MODE: 신호만 저장) ──
    // 항상 실행 — 이전 사이클 pending 신호도 처리
    console.log(`\n⚡ [실행 단계] 한울 실행 (이번 사이클: ${executedResults.length}개 신호)...`);
    await processAllPendingKisOverseasSignals();

    // ── 상태 저장 ──
    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost    = tracker.getToday();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ ${tag} 미국주식 사이클 완료 — ${elapsed}초 | ${executedResults.length}개 신호 | LLM $${cost.usage.toFixed(4)}/일`);
    console.log(`${'═'.repeat(60)}\n`);

    // ── 사이클 요약 알람 (신호 있을 때만) ──
    if (executedResults.length > 0) {
      const signalLines = executedResults.map(r => `  • ${r.symbol} ${r.action} (${((r.confidence || 0) * 100).toFixed(0)}%)`).join('\n');
      publishToMainBot({
        from_bot: 'luna', event_type: 'trade', alert_level: 2,
        message: `🗽 ${tag} 미국주식 사이클\n심볼: ${symbols.join(', ')}\n신호: ${executedResults.length}개\n${signalLines}`,
      });
    }

    return results;

  } catch (e) {
    if (sessionId) {
      await finishPipelineRun(sessionId, {
        status: 'failed',
        meta: {
          bridge_status: 'market_cycle_failed',
          market_script: 'overseas',
          cycle_error: e.message,
        },
      }).catch(() => {});
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 미국주식 사이클 오류 (${elapsed}초): ${e.message}`);
    console.error(e.stack);
    publishToMainBot({ from_bot: 'luna', event_type: 'system_error', alert_level: 3, message: `❌ 미국주식 사이클 오류\n${e.message}` });
    throw e;
  }
}

export async function runOverseasResearchCycle(symbols) {
  await initHubSecrets();
  const startTime = Date.now();
  let sessionId = null;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📚 [RESEARCH] 미국주식 장외 분석 시작 — ${kst.toKST(new Date())}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    console.log('\n📊 [연구 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'kis_overseas',
      symbols,
      triggerType: 'research',
      meta: { market_script: 'overseas', research_only: true },
    });
    sessionId = collect.sessionId;
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logPipelineMetrics('미국주식 연구수집', collect.metrics);

    saveResearchWatchlist('overseas', symbols, {
      label: '미국주식',
      research: {
        phase: 'analysis_only',
        session: 'off_hours',
      },
    });

    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ [RESEARCH] 미국주식 장외 분석 완료 — ${elapsed}초`);

    publishToMainBot({
      from_bot: 'luna',
      event_type: 'report',
      alert_level: 1,
      message: `📚 미국주식 장외 연구 완료\n심볼: ${symbols.join(', ')}\n다음 장 watchlist 갱신 완료\n소요: ${elapsed}초`,
    });

    await finishPipelineRun(sessionId, {
      status: 'completed',
      meta: {
        bridge_status: 'research_collect_completed',
        market_script: 'overseas',
        research_only: true,
      },
    });

    return [];
  } catch (e) {
    if (sessionId) {
      await finishPipelineRun(sessionId, {
        status: 'failed',
        meta: {
          bridge_status: 'research_collect_failed',
          market_script: 'overseas',
          research_only: true,
          cycle_error: e.message,
        },
      }).catch(() => {});
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 미국주식 장외 연구 오류 (${elapsed}초): ${e.message}`);
    publishToMainBot({ from_bot: 'luna', event_type: 'system_error', alert_level: 2, message: `❌ 미국주식 장외 연구 오류\n${e.message}` });
    throw e;
  }
}

async function logPipelineMetrics(label, metrics = {}) {
  if (!metrics || typeof metrics !== 'object') return;
  const parts = [
    `duration=${((metrics.durationMs || 0) / 1000).toFixed(1)}s`,
    metrics.symbolCount != null ? `symbols=${metrics.symbolCount}` : null,
    metrics.totalTasks != null ? `tasks=${metrics.totalTasks}` : null,
    metrics.concurrencyLimit != null ? `concurrency=${metrics.concurrencyLimit}` : null,
    metrics.failedTasks != null ? `failed=${metrics.failedTasks}` : null,
    metrics.failedCoreTasks != null ? `coreFailed=${metrics.failedCoreTasks}` : null,
    metrics.failedEnrichmentTasks != null ? `enrichFailed=${metrics.failedEnrichmentTasks}` : null,
    metrics.debateCount != null ? `debate=${metrics.debateCount}/${metrics.debateLimit}` : null,
    metrics.weakSignalSkipped != null ? `weakSkipped=${metrics.weakSignalSkipped}` : null,
    metrics.riskRejected != null ? `riskRejected=${metrics.riskRejected}` : null,
    metrics.savedExecutionWork != null ? `savedNodes=${metrics.savedExecutionWork}` : null,
  ].filter(Boolean);
  console.log(`  📈 [메트릭] ${label} | ${parts.join(' | ')}`);
  if (metrics.warnings?.length) {
    console.warn(`  ⚠️ [경고] ${label} | ${metrics.warnings.join(', ')}`);
    const escalated = metrics.warnings.filter(w =>
      [
        'collect_overload_detected',
        'collect_failure_rate_high',
        'core_collect_failure_rate_high',
        'enrichment_collect_failure_rate_high',
        'collect_blocked_by_llm_guard',
        'debate_capacity_hot',
        'weak_signal_pressure',
      ].includes(w),
    );
    if (escalated.length) {
      await publishToMainBot({
        from_bot: 'argos',
        event_type: 'alert',
        alert_level: 2,
        message: buildCollectAlertMessage(label, escalated, metrics),
        payload: metrics,
      });
    }
  }
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initHubSecrets();
  const args      = process.argv.slice(2);
  const symArg    = args.find(a => a.startsWith('--symbols='));
  const force     = args.includes('--force');
  const noDynamic = args.includes('--no-dynamic');
  const researchOnly = args.includes('--research-only');

  let symbols;
  if (symArg) {
    symbols = symArg.split('=')[1].split(',').map(s => s.trim());
  } else if (noDynamic) {
    symbols = getKisOverseasSymbols();
  } else {
    const overseasMaxDynamic = getOverseasScreeningMaxDynamic();
    const preScreened = loadPreScreened('overseas');
    if (preScreened?.symbols?.length > 0) {
      symbols = capDynamicUniverse(preScreened.symbols, overseasMaxDynamic, 'overseas-prescreened');
      const ageMin = Math.floor((Date.now() - preScreened.savedAt) / 60000);
      console.log(`📋 [장전 스크리닝] 종목 로드 (${ageMin}분 전): ${symbols.join(', ')}`);
    } else {
      const resolved = await resolveSymbolsWithFallback({
        market: 'overseas',
        screen: async () => {
          const { screenOverseasSymbols } = await import('../team/argos.js');
          return screenOverseasSymbols();
        },
        loadCache: () => loadPreScreenedFallback('overseas'),
        defaultSymbols: getKisOverseasSymbols(),
        screenLabel: '아르고스 해외주식 스크리닝',
        cacheLabel: 'RAG 폴백',
      });
      symbols = capDynamicUniverse(resolved.symbols, overseasMaxDynamic, `overseas-${resolved.source || 'dynamic'}`);
      if (resolved.source === 'screening') {
        savePreScreened('overseas', symbols);
        const { recordScreeningSuccess } = await import('../scripts/screening-monitor.js');
        await recordScreeningSuccess('overseas');
      } else if (resolved.error && resolved.shouldCountFailure !== false) {
        const { recordScreeningFailure } = await import('../scripts/screening-monitor.js');
        await recordScreeningFailure('overseas', resolved.error.message);
      } else if (symbols.length > 0) {
        const { recordScreeningSuccess } = await import('../scripts/screening-monitor.js');
        await recordScreeningSuccess('overseas');
      }
    }
  }

  symbols = await appendHeldSymbols(symbols, 'kis_overseas');

  console.log(getKisExecutionModeInfo('해외주식').logLine);

  const marketStatus = force
    ? { isOpen: true, reason: '--force 옵션' }
    : getKisOverseasMarketStatus();
  const marketOpen = marketStatus.isOpen;

  // 30분 주기 체크
  const check = researchOnly
    ? { run: true, reason: '--research-only 옵션' }
    : shouldRunCycle(force);
  if (!check.run) {
    console.log(`⏳ 사이클 스킵: ${check.reason}`);
    process.exit(0);
  }

  // 보유 포지션 포함 후에도 종목 없으면 스킵
  if (symbols.length === 0) {
    console.log('⏭️ 처리할 종목 없음 (아르고스 스크리닝 필요) — 사이클 스킵');
    process.exit(0);
  }

  console.log(`🔄 ${check.reason}`);

  await db.initSchema();
  try {
    if (researchOnly) {
      console.log('🧪 강제 연구 모드 실행');
      await runOverseasResearchCycle(symbols);
      process.exit(0);
    }

    if (!force && !marketOpen) {
      console.log(`📚 ${marketStatus.reason} — 연구 모드 전환`);
      await runOverseasResearchCycle(symbols);
      process.exit(0);
    }

    const r = await runOverseasCycle(symbols);
    console.log(`\n최종 결과: ${r.length}개 신호 승인`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 종료 오류:', e.message);
    process.exit(1);
  }
}
