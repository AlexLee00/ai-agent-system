// @ts-nocheck
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
 * runtime: Elixir supervisor / Luna ops-scheduler 통합 경로 (기존 단독 launchd retired)
 * 실행: PAPER_MODE=true node markets/overseas.js [--symbols=AAPL,TSLA,NVDA] [--force]
 */

import { loadPreScreened, loadPreScreenedFallback, savePreScreened, saveResearchWatchlist } from '../scripts/pre-market-screen.ts';

import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { initHubSecrets, getKisOverseasSymbols, getKisOverseasMarketStatus, getKisExecutionModeInfo, getOverseasScreeningMaxDynamic } from '../shared/secrets.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { tracker } from '../shared/cost-tracker.ts';
import { parseUniverseCliFlags } from '../shared/screening-runtime.ts';
import { resolveSymbolsWithFallback, resolveManagedPositionUniverse, appendHeldSymbols, capDynamicUniverse } from '../shared/universe-fallback.ts';
import {
  getInvestmentStateFile,
  loadJsonState,
  saveJsonState,
  shouldRunFixedIntervalCycle,
  logMarketCycleStart,
  logMarketCycleComplete,
  logResearchCycleStart,
  logResearchCycleComplete,
} from '../shared/market-cycle-support.ts';
import { logMarketPipelineMetrics, runMarketCollectPipeline, summarizeNodeStatuses } from '../shared/pipeline-market-runner.ts';
import { runDecisionExecutionPipeline } from '../shared/pipeline-decision-runner.ts';
import { finishPipelineRun } from '../shared/pipeline-db.ts';
import { updatePipelineRunMeta } from '../shared/pipeline-db.ts';
import { inspectLunaPortfolioContext } from '../shared/luna-portfolio-context.ts';

import { processAllPendingKisOverseasSignals } from '../team/hanul.ts';

process.env.INVESTMENT_MARKET = 'overseas';

// ─── 30분 주기 상태 파일 ────────────────────────────────────────────

const STATE_FILE     = getInvestmentStateFile('investment-overseas-state.json');
const CYCLE_INTERVAL = 30 * 60 * 1000;  // 30분

function loadState() {
  return loadJsonState(STATE_FILE, { lastCycleAt: 0 });
}

function saveState(state) {
  saveJsonState(STATE_FILE, state);
}

function shouldRunCycle(force = false) {
  const state = loadState();
  return shouldRunFixedIntervalCycle({
    force,
    lastCycleAt: state.lastCycleAt,
    intervalMs: CYCLE_INTERVAL,
    toKst: (date) => kst.toKST(date),
  });
}

async function getOverseasCapitalDiscoveryHold() {
  const portfolioContext = await inspectLunaPortfolioContext('kis_overseas').catch((error) => {
    console.warn(`⚠️ [루나 자본상태] 해외주식 잔고 프리플라이트 실패: ${error?.message || error}`);
    return null;
  });
  if (
    !portfolioContext
    || portfolioContext.capitalMode === 'ACTIVE_DISCOVERY'
    || portfolioContext.balanceStatus !== 'ok'
    || Number(portfolioContext.positionCount || 0) > 0
  ) {
    return null;
  }

  const capitalSnapshot = portfolioContext.capitalSnapshot || {};
  const message = [
    `ℹ️ [루나 자본상태] 해외주식 신규 발굴 보류`,
    `mode=${portfolioContext.capitalMode || 'unknown'} reason=${portfolioContext.reasonCode || 'none'}`,
    `buyable=${Number(portfolioContext.buyableAmount || 0).toFixed(2)} / min=${Number(capitalSnapshot.minOrderAmount || 0).toFixed(2)}`,
    `positions=0 — 보유 모니터링 대상 없음`,
  ].join('\n');

  return { portfolioContext, message };
}

async function notifyOverseasCapitalDiscoveryHold(hold) {
  if (!hold?.message) return;
  console.log(hold.message);
  await publishAlert({
    from_bot: 'luna',
    event_type: 'capital_state_report',
    alert_level: 1,
    message: hold.message,
  }).catch(() => {});
}

// ─── 예산 초과 리스너 ────────────────────────────────────────────────

tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  const label = type === 'daily' ? '일일' : '월간';
  const cost  = tracker.getToday();
  const msg   = `💸 [예산 초과] ${label} LLM 예산 초과 — 미국주식 사이클 중단\n일간: $${cost.usage.toFixed(4)} | 월간: $${cost.monthUsage.toFixed(4)}`;
  console.error(msg);
  publishAlert({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: msg });
  process.exit(1);
});

// ─── 메인 사이클 ────────────────────────────────────────────────────

/**
 * 미국주식 사이클 전체 실행
 * @param {string[]} symbols  ex) ['AAPL', 'TSLA', 'NVDA']
 */
export async function runOverseasCycle(symbols, universeMeta = {}) {
  // Phase 5c Kill Switch — LUNA_LIVE_OVERSEAS=true 이어야 실행
  if (process.env.LUNA_LIVE_OVERSEAS !== 'true') {
    console.log('[overseas] LIVE OFF — 사이클 스킵 (LUNA_LIVE_OVERSEAS 미설정)');
    return { ok: false, mode: 'mock', reason: 'kill_switch_off' };
  }

  await initHubSecrets();
  const { paper: paperMode, tag } = getKisExecutionModeInfo('해외주식');
  const startTime = Date.now();
  let sessionId = null;

  logMarketCycleStart({
    icon: '🗽',
    tag,
    marketLabel: '미국주식',
    now: kst.toKST(new Date()),
    symbols,
  });

  try {
    const capitalHold = await getOverseasCapitalDiscoveryHold();
    if (capitalHold) {
      await notifyOverseasCapitalDiscoveryHold(capitalHold);
      saveState({ lastCycleAt: Date.now() });
      return [];
    }

    // ── 단계 1: 노드 기반 수집 실행 ──
    console.log('\n📊 [분석 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'kis_overseas',
      symbols,
      triggerType: 'cycle',
      meta: { market_script: 'overseas', collect_mode: 'screening_with_maintenance' },
      universeMeta,
    });
    sessionId = collect.sessionId;
    await updatePipelineRunMeta(collect.sessionId, {
      collect_metrics: collect.metrics,
      collect_quality: collect.metrics?.collectQuality || null,
      collect_warnings: collect.metrics?.warnings || [],
    }).catch(() => {});
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logMarketPipelineMetrics('미국주식 수집', collect.metrics);

    // ── 단계 2: 루나 오케스트레이터 ──
    console.log('\n🌙 [판단 단계] 루나 오케스트레이터 실행...');
    const decision = await runDecisionExecutionPipeline({
      sessionId: collect.sessionId,
      symbols,
      exchange: 'kis_overseas',
    });
    const results = decision.results;
    const executedResults = results.filter(item => !item.skipped);
    await logMarketPipelineMetrics('미국주식 판단', decision.metrics);

    // ── 단계 3: 한울 실행 (PAPER_MODE: 신호만 저장) ──
    // 항상 실행 — 이전 사이클 pending 신호도 처리
    console.log(`\n⚡ [실행 단계] 한울 실행 (이번 사이클: ${executedResults.length}개 신호)...`);
    await processAllPendingKisOverseasSignals();

    // ── 상태 저장 ──
    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost    = tracker.getToday();
    logMarketCycleComplete({
      tag,
      marketLabel: '미국주식',
      elapsedSec: elapsed,
      signalCount: executedResults.length,
      dailyCost: cost.usage,
    });

    // ── 사이클 요약 알람 (신호 있을 때만) ──
    if (executedResults.length > 0) {
      const signalLines = executedResults.map(r => `  • ${r.symbol} ${r.action} (${((r.confidence || 0) * 100).toFixed(0)}%)`).join('\n');
      publishAlert({
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
    publishAlert({ from_bot: 'luna', event_type: 'system_error', alert_level: 3, message: `❌ 미국주식 사이클 오류\n${e.message}` });
    throw e;
  }
}

export async function runOverseasResearchCycle(symbols, universeMeta = {}) {
  await initHubSecrets();
  const startTime = Date.now();
  let sessionId = null;

  logResearchCycleStart({
    marketLabel: '미국주식',
    now: kst.toKST(new Date()),
    symbols,
  });

  try {
    console.log('\n📊 [연구 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'kis_overseas',
      symbols,
      triggerType: 'research',
      meta: { market_script: 'overseas', research_only: true, collect_mode: 'screening' },
      universeMeta,
    });
    sessionId = collect.sessionId;
    await updatePipelineRunMeta(collect.sessionId, {
      collect_metrics: collect.metrics,
      collect_quality: collect.metrics?.collectQuality || null,
      collect_warnings: collect.metrics?.warnings || [],
    }).catch(() => {});
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logMarketPipelineMetrics('미국주식 연구수집', collect.metrics);

    saveResearchWatchlist('overseas', symbols, {
      label: '미국주식',
      research: {
        phase: 'analysis_only',
        session: 'off_hours',
      },
    });

    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logResearchCycleComplete({ marketLabel: '미국주식', elapsedSec: elapsed });

    publishAlert({
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
    publishAlert({ from_bot: 'luna', event_type: 'system_error', alert_level: 2, message: `❌ 미국주식 장외 연구 오류\n${e.message}` });
    throw e;
  }
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {
      await initHubSecrets();
      await db.initSchema();
    },
    run: async () => {
      const args = process.argv.slice(2);
      const { symbols: cliSymbols, force, noDynamic, researchOnly } = parseUniverseCliFlags(args);

      let symbols;
      const universeMeta = {
        screeningSymbolCount: 0,
        heldSymbolCount: 0,
        heldAddedCount: 0,
        maintenanceSymbolCount: 0,
        maintenanceProfiledCount: 0,
        maintenanceDustSkippedCount: 0,
        maintenanceLifecycleCounts: {},
      };

      if ((!Array.isArray(cliSymbols) || cliSymbols.length === 0) && !noDynamic) {
        const capitalHold = await getOverseasCapitalDiscoveryHold();
        if (capitalHold) {
          await notifyOverseasCapitalDiscoveryHold(capitalHold);
          saveState({ lastCycleAt: Date.now() });
          return [];
        }
      }

      if (Array.isArray(cliSymbols) && cliSymbols.length > 0) {
        symbols = cliSymbols;
        universeMeta.screeningSymbolCount = symbols.length;
      } else if (noDynamic) {
        symbols = getKisOverseasSymbols();
        universeMeta.screeningSymbolCount = symbols.length;
      } else {
        const overseasMaxDynamic = getOverseasScreeningMaxDynamic();
        const preScreened = loadPreScreened('overseas');
        if (preScreened?.symbols?.length > 0) {
          symbols = capDynamicUniverse(preScreened.symbols, overseasMaxDynamic, 'overseas-prescreened');
          universeMeta.screeningSymbolCount = symbols.length;
          const ageMin = Math.floor((Date.now() - preScreened.savedAt) / 60000);
          console.log(`📋 [장전 스크리닝] 종목 로드 (${ageMin}분 전): ${symbols.join(', ')}`);
        } else {
          const resolved = await resolveSymbolsWithFallback({
            market: 'overseas',
            screen: async () => {
              const { screenOverseasSymbols } = await import('../team/argos.ts');
              return screenOverseasSymbols();
            },
            loadCache: () => loadPreScreenedFallback('overseas'),
            defaultSymbols: getKisOverseasSymbols(),
            screenLabel: '아르고스 해외주식 스크리닝',
            cacheLabel: 'RAG 폴백',
          });
          symbols = capDynamicUniverse(resolved.symbols, overseasMaxDynamic, `overseas-${resolved.source || 'dynamic'}`);
          universeMeta.screeningSymbolCount = symbols.length;
          if (resolved.source === 'screening') {
            savePreScreened('overseas', symbols);
            const { recordScreeningSuccess } = await import('../scripts/screening-monitor.ts');
            await recordScreeningSuccess('overseas');
          } else if (resolved.error && resolved.shouldCountFailure !== false) {
            const { recordScreeningFailure } = await import('../scripts/screening-monitor.ts');
            await recordScreeningFailure('overseas', resolved.error.message);
          } else if (symbols.length > 0) {
            const { recordScreeningSuccess } = await import('../scripts/screening-monitor.ts');
            await recordScreeningSuccess('overseas');
          }
        }
      }

      const maintenanceUniverse = await resolveManagedPositionUniverse('kis_overseas').catch(() => ({ symbols: [], managedCount: 0, profiledCount: 0, dustSymbols: [], lifecycleCounts: {} }));
      const heldSymbols = maintenanceUniverse.symbols || [];
      universeMeta.heldSymbolCount = heldSymbols.length;
      universeMeta.heldAddedCount = heldSymbols.filter((symbol) => !symbols.includes(symbol)).length;
      universeMeta.maintenanceSymbolCount = Number(maintenanceUniverse.managedCount || heldSymbols.length || 0);
      universeMeta.maintenanceProfiledCount = Number(maintenanceUniverse.profiledCount || 0);
      universeMeta.maintenanceDustSkippedCount = Array.isArray(maintenanceUniverse.dustSymbols) ? maintenanceUniverse.dustSymbols.length : 0;
      universeMeta.maintenanceLifecycleCounts = maintenanceUniverse.lifecycleCounts || {};
      symbols = await appendHeldSymbols(symbols, 'kis_overseas', heldSymbols);
      console.log(getKisExecutionModeInfo('해외주식').logLine);

      const marketStatus = force
        ? { isOpen: true, reason: '--force 옵션' }
        : getKisOverseasMarketStatus();
      const marketOpen = marketStatus.isOpen;
      const check = researchOnly
        ? { run: true, reason: '--research-only 옵션' }
        : shouldRunCycle(force);
      if (!check.run) {
        console.log(`⏳ 사이클 스킵: ${check.reason}`);
        return [];
      }

      if (symbols.length === 0) {
        console.log('⏭️ 처리할 종목 없음 (아르고스 스크리닝 필요) — 사이클 스킵');
        return [];
      }

      console.log(`🔄 ${check.reason}`);

      if (researchOnly) {
        console.log('🧪 강제 연구 모드 실행');
        await runOverseasResearchCycle(symbols, universeMeta);
        return [];
      }

      if (!force && !marketOpen) {
        console.log(`📚 ${marketStatus.reason} — 연구 모드 전환`);
        await runOverseasResearchCycle(symbols, universeMeta);
        return [];
      }

      return runOverseasCycle(symbols, universeMeta);
    },
    onSuccess: async (results) => {
      console.log(`\n최종 결과: ${results.length}개 신호 승인`);
    },
    errorPrefix: '❌ 종료 오류:',
  });
}
