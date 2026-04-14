// @ts-nocheck
/**
 * markets/domestic.js — 국내주식 30분 사이클 (Phase 3-B)
 *
 * 파이프라인:
 *   1. 장중 여부 확인 (KST 09:00~15:30, 주말 제외)
 *   2. 30분 주기 확인
 *   3. [병렬] 아리아(TA 일봉/1h) + 헤르메스(Naver뉴스+DART) + 소피아(네이버 토론실)
 *   4. 루나 오케스트레이터 (최종 신호 판단)
 *   5. 한울 실행 (KIS 국내주식, PAPER_MODE: DB + 텔레그램만)
 *
 * launchd: ai.investment.domestic (5분 주기 — 내부 30분 스로틀 + 장중 체크)
 * 실행: PAPER_MODE=true node markets/domestic.js [--symbols=005930,000660] [--force]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { loadPreScreened, loadPreScreenedFallback, savePreScreened, saveResearchWatchlist } from '../scripts/pre-market-screen.ts';

import { createRequire } from 'module';
const kst = createRequire(import.meta.url)('../../../packages/core/lib/kst');
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { initHubSecrets, getKisSymbols, getKisMarketStatus, getKisExecutionModeInfo, getDomesticScreeningMaxDynamic, getInvestmentTradeMode } from '../shared/secrets.ts';
import { publishAlert } from '../shared/mainbot-client.ts';
import { tracker } from '../shared/cost-tracker.ts';
import { parseUniverseCliFlags } from '../shared/screening-runtime.ts';
import { resolveSymbolsWithFallback, appendHeldSymbols, capDynamicUniverse } from '../shared/universe-fallback.ts';
import {
  getOpenClawStateFile,
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
import { getMockUntradableSymbolCooldownMinutes } from '../shared/runtime-config.ts';

import { processAllPendingKisSignals } from '../team/hanul.ts';

process.env.INVESTMENT_MARKET = 'domestic';

// ─── 30분 주기 상태 파일 ────────────────────────────────────────────

const STATE_FILE     = getOpenClawStateFile('investment-domestic-state.json');
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

// ─── 예산 초과 리스너 ────────────────────────────────────────────────

tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  const label = type === 'daily' ? '일일' : '월간';
  const cost  = tracker.getToday();
  const msg   = `💸 [예산 초과] ${label} LLM 예산 초과 — 국내주식 사이클 중단\n일간: $${cost.usage.toFixed(4)} | 월간: $${cost.monthUsage.toFixed(4)}`;
  console.error(msg);
  publishAlert({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: msg });
  process.exit(1);
});

async function filterMockUntradableDomesticCandidates(symbols, tradeMode = getInvestmentTradeMode()) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];
  try {
    await db.initSchema();
  } catch (error) {
    console.warn(`  ⚠️ [mock 불가 제외] DB 미연결로 쿨다운 검사 생략: ${error.message}`);
    return symbols;
  }
  const cooldownMinutes = getMockUntradableSymbolCooldownMinutes();
  const checks = await Promise.all(
    symbols.map(async (symbol) => ({
      symbol,
      blocked: await db.getRecentBlockedSignalByCode({
        symbol,
        action: 'BUY',
        exchange: 'kis',
        tradeMode,
        blockCode: 'mock_untradable_symbol',
        minutesBack: cooldownMinutes,
      }),
    })),
  );
  const filtered = checks.filter((item) => !item.blocked).map((item) => item.symbol);
  const skipped = checks.filter((item) => item.blocked).map((item) => item.symbol);
  if (skipped.length > 0) {
    const cooldownHours = (cooldownMinutes / 60).toFixed(cooldownMinutes % 60 === 0 ? 0 : 1);
    console.log(`  🚫 [mock 불가 제외] ${skipped.join(', ')} (${cooldownHours}시간 쿨다운)`);
  }
  return filtered;
}

// ─── 메인 사이클 ────────────────────────────────────────────────────

/**
 * 국내주식 사이클 전체 실행
 * @param {string[]} symbols  ex) ['005930', '000660']
 */
export async function runDomesticCycle(symbols) {
  await initHubSecrets();
  const { paper: paperMode, tag } = getKisExecutionModeInfo('국내주식');
  const startTime = Date.now();
  let sessionId = null;

  logMarketCycleStart({
    icon: '🏦',
    tag,
    marketLabel: '국내주식',
    now: kst.toKST(new Date()),
    symbols,
  });

  try {
    // ── 단계 1: 노드 기반 수집 실행 ──
    console.log('\n📊 [분석 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'kis',
      symbols,
      triggerType: 'cycle',
      meta: { market_script: 'domestic' },
    });
    sessionId = collect.sessionId;
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logMarketPipelineMetrics('국내주식 수집', collect.metrics);

    // ── 단계 2: 루나 오케스트레이터 ──
    console.log('\n🌙 [판단 단계] 루나 오케스트레이터 실행...');
    const decision = await runDecisionExecutionPipeline({
      sessionId: collect.sessionId,
      symbols,
      exchange: 'kis',
    });
    const results = decision.results;
    const executedResults = results.filter(item => !item.skipped);
    await logMarketPipelineMetrics('국내주식 판단', decision.metrics);

    // ── 단계 3: 한울 실행 (PAPER_MODE: 신호만 저장) ──
    // 항상 실행 — 이전 사이클 pending 신호도 처리
    console.log(`\n⚡ [실행 단계] 한울 실행 (이번 사이클: ${executedResults.length}개 신호)...`);
    await processAllPendingKisSignals();

    // ── 상태 저장 ──
    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost    = tracker.getToday();
    logMarketCycleComplete({
      tag,
      marketLabel: '국내주식',
      elapsedSec: elapsed,
      signalCount: executedResults.length,
      dailyCost: cost.usage,
    });

    // ── 사이클 요약 알람 (신호 있을 때만) ──
    if (executedResults.length > 0) {
      const signalLines = executedResults.map(r => `  • ${r.symbol} ${r.action} (${((r.confidence || 0) * 100).toFixed(0)}%)`).join('\n');
      publishAlert({
        from_bot: 'luna', event_type: 'trade', alert_level: 2,
        message: `🏦 ${tag} 국내주식 사이클\n심볼: ${symbols.join(', ')}\n신호: ${executedResults.length}개\n${signalLines}`,
      });
    }

    return results;

  } catch (e) {
    if (sessionId) {
      await finishPipelineRun(sessionId, {
        status: 'failed',
        meta: {
          bridge_status: 'market_cycle_failed',
          market_script: 'domestic',
          cycle_error: e.message,
        },
      }).catch(() => {});
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 국내주식 사이클 오류 (${elapsed}초): ${e.message}`);
    console.error(e.stack);
    publishAlert({ from_bot: 'luna', event_type: 'system_error', alert_level: 3, message: `❌ 국내주식 사이클 오류\n${e.message}` });
    throw e;
  }
}

export async function runDomesticResearchCycle(symbols) {
  await initHubSecrets();
  const startTime = Date.now();
  let sessionId = null;

  logResearchCycleStart({
    marketLabel: '국내주식',
    now: kst.toKST(new Date()),
    symbols,
  });

  try {
    console.log('\n📊 [연구 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'kis',
      symbols,
      triggerType: 'research',
      meta: { market_script: 'domestic', research_only: true },
    });
    sessionId = collect.sessionId;
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logMarketPipelineMetrics('국내주식 연구수집', collect.metrics);

    saveResearchWatchlist('domestic', symbols, {
      label: '국내주식',
      research: {
        phase: 'analysis_only',
        session: 'off_hours',
      },
    });

    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logResearchCycleComplete({ marketLabel: '국내주식', elapsedSec: elapsed });

    publishAlert({
      from_bot: 'luna',
      event_type: 'report',
      alert_level: 1,
      message: `📚 국내주식 장외 연구 완료\n심볼: ${symbols.join(', ')}\n다음 장 watchlist 갱신 완료\n소요: ${elapsed}초`,
    });

    await finishPipelineRun(sessionId, {
      status: 'completed',
      meta: {
        bridge_status: 'research_collect_completed',
        market_script: 'domestic',
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
          market_script: 'domestic',
          research_only: true,
          cycle_error: e.message,
        },
      }).catch(() => {});
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 국내주식 장외 연구 오류 (${elapsed}초): ${e.message}`);
    publishAlert({ from_bot: 'luna', event_type: 'system_error', alert_level: 2, message: `❌ 국내주식 장외 연구 오류\n${e.message}` });
    throw e;
  }
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: async () => {
      await initHubSecrets();
    },
    run: async () => {
      const args = process.argv.slice(2);
      const { symbols: cliSymbols, force, noDynamic, researchOnly } = parseUniverseCliFlags(args);
      const marketStatus = !force
        ? await getKisMarketStatus()
        : { isOpen: true, reason: '--force 옵션', holiday: { isHoliday: false, name: '' }, isWeekend: false };
      const check = researchOnly
        ? { run: true, reason: '--research-only 옵션' }
        : shouldRunCycle(force);

      if (!check.run) {
        console.log(`⏳ 사이클 스킵: ${check.reason}`);
        return [];
      }

      if (!force && !researchOnly && !marketStatus.isOpen && (marketStatus.isWeekend || marketStatus.holiday?.isHoliday)) {
        console.log(`⏭️ ${marketStatus.reason} — 주말/휴장 스킵`);
        return [];
      }

      let symbols;
      if (Array.isArray(cliSymbols) && cliSymbols.length > 0) {
        symbols = cliSymbols;
      } else if (noDynamic) {
        symbols = getKisSymbols();
      } else {
        const domesticMaxDynamic = getDomesticScreeningMaxDynamic();
        const preScreened = loadPreScreened('domestic');
        if (preScreened?.symbols?.length > 0) {
          symbols = capDynamicUniverse(preScreened.symbols, domesticMaxDynamic, 'domestic-prescreened');
          symbols = await filterMockUntradableDomesticCandidates(symbols);
          const ageMin = Math.floor((Date.now() - preScreened.savedAt) / 60000);
          console.log(`📋 [장전 스크리닝] 종목 로드 (${ageMin}분 전): ${symbols.join(', ')}`);
        } else {
          const resolved = await resolveSymbolsWithFallback({
            market: 'domestic',
            screen: async () => {
              const { screenDomesticSymbols } = await import('../team/argos.ts');
              return screenDomesticSymbols();
            },
            loadCache: () => loadPreScreenedFallback('domestic'),
            defaultSymbols: getKisSymbols(),
            screenLabel: '아르고스 국내주식 스크리닝',
            cacheLabel: 'RAG 폴백',
          });
          symbols = capDynamicUniverse(resolved.symbols, domesticMaxDynamic, `domestic-${resolved.source || 'dynamic'}`);
          symbols = await filterMockUntradableDomesticCandidates(symbols);
          if (resolved.source === 'screening') {
            savePreScreened('domestic', symbols);
            const { recordScreeningSuccess } = await import('../scripts/screening-monitor.ts');
            await recordScreeningSuccess('domestic');
          } else if (resolved.error && resolved.shouldCountFailure !== false) {
            const { recordScreeningFailure } = await import('../scripts/screening-monitor.ts');
            await recordScreeningFailure('domestic', resolved.error.message);
          } else if (symbols.length > 0) {
            const { recordScreeningSuccess } = await import('../scripts/screening-monitor.ts');
            await recordScreeningSuccess('domestic');
          }
        }
      }

      symbols = await appendHeldSymbols(symbols, 'kis');
      console.log(getKisExecutionModeInfo('국내주식').logLine);
      const marketOpen = marketStatus.isOpen;

      if (symbols.length === 0) {
        console.log('⏭️ 처리할 종목 없음 (아르고스 스크리닝 필요) — 사이클 스킵');
        return [];
      }

      console.log(`🔄 ${check.reason}`);

      if (researchOnly) {
        console.log('🧪 강제 연구 모드 실행');
        await runDomesticResearchCycle(symbols);
        return [];
      }

      if (!force && !marketOpen) {
        console.log(`📚 ${marketStatus.reason} — 연구 모드 전환`);
        await runDomesticResearchCycle(symbols);
        return [];
      }

      return runDomesticCycle(symbols);
    },
    onSuccess: async (results) => {
      console.log(`\n최종 결과: ${results.length}개 신호 승인`);
    },
    errorPrefix: '❌ 종료 오류:',
  });
}
