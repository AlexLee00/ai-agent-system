// @ts-nocheck
/**
 * markets/crypto.js — 암호화폐 사이클 (30분 주기 + 긴급 트리거)
 *
 * 파이프라인:
 *   1. DB 초기화
 *   2. 30분 주기 또는 BTC ±3% 긴급 트리거 확인
 *   3. [병렬] 아리아(TA MTF) + 오라클(온체인) + 헤르메스(뉴스) + 소피아(감성)
 *   4. 루나 오케스트레이터 (강세/약세 토론 + 최종 신호 판단)
 *   5. 헤파이스토스 실행 (PAPER_MODE: DB + 텔레그램만)
 *
 * launchd: ai.investment.crypto (5분 주기 — 내부 30분 스로틀)
 * 실행: PAPER_MODE=true node markets/crypto.js [--symbols=BTC/USDT,ETH/USDT] [--force]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import https from 'https';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const kst = require('../../../packages/core/lib/kst');
const { writeHeartbeat } = require('../../../packages/core/lib/agent-heartbeats');
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { initHubSecrets, getSymbols, getMarketExecutionModeInfo, getInvestmentTradeMode, getCryptoScreeningMaxDynamic } from '../shared/secrets.ts';
import { publishAlert } from '../shared/mainbot-client.ts';
import { tracker } from '../shared/cost-tracker.ts';
import { getLunaParams } from '../shared/time-mode.ts';
import { parseUniverseCliFlags } from '../shared/screening-runtime.ts';
import { resolveSymbolsWithFallback, appendHeldSymbols, capDynamicUniverse } from '../shared/universe-fallback.ts';
import {
  getOpenClawStateFile,
  loadJsonState,
  saveJsonState,
  logMarketCycleStart,
  logMarketCycleComplete,
} from '../shared/market-cycle-support.ts';
import { logMarketPipelineMetrics, runMarketCollectPipeline, summarizeNodeStatuses } from '../shared/pipeline-market-runner.ts';
import { runDecisionExecutionPipeline } from '../shared/pipeline-decision-runner.ts';
import { finishPipelineRun } from '../shared/pipeline-db.ts';

import { processAllPendingSignals, fetchUsdtBalance } from '../team/hephaestos.ts';

process.env.INVESTMENT_MARKET = 'crypto';

// ─── 30분 주기 상태 파일 ────────────────────────────────────────────

const EMERGENCY_CHG = 0.03;  // BTC ±3% 긴급 트리거

function getStateFile() {
  const tradeMode = getInvestmentTradeMode();
  const suffix = tradeMode === 'validation' ? '-validation' : '';
  return getOpenClawStateFile(`investment-state${suffix}.json`);
}

function loadState() {
  const stateFile = getStateFile();
  return loadJsonState(stateFile, { lastCycleAt: 0, lastBtcPrice: 0 });
}

function saveState(state) {
  const stateFile = getStateFile();
  saveJsonState(stateFile, state);
}

function getHeldMergeStats(baseSymbols = [], heldSymbols = []) {
  const seen = new Set(baseSymbols);
  let heldAddedCount = 0;
  for (const symbol of heldSymbols) {
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    heldAddedCount += 1;
  }
  return { heldAddedCount };
}

function fetchBtcPrice() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.binance.com', path: '/api/v3/ticker/price?symbol=BTCUSDT', method: 'GET' },
      (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try { resolve(parseFloat(JSON.parse(raw).price)); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('BTC 가격 조회 타임아웃')); });
    req.end();
  });
}

async function shouldRunCycle(symbols) {
  const state  = loadState();
  const now    = Date.now();
  const params = getLunaParams();
  const cycleMs = params.cycleSec * 1000;

  // 정규 사이클 (시간대별 간격 적용)
  if (now - state.lastCycleAt >= cycleMs) {
    const cycleMin = params.cycleSec / 60;
    return { run: true, emergency: false, reason: `${cycleMin}분 정규 사이클 (${params.mode})` };
  }

  // BTC 긴급 트리거 (시간대별 활성 여부)
  if (params.emergencyTrigger && symbols.some(s => s.startsWith('BTC')) && state.lastBtcPrice > 0) {
    try {
      const currentPrice = await fetchBtcPrice();
      const changePct    = Math.abs((currentPrice - state.lastBtcPrice) / state.lastBtcPrice);
      if (changePct >= EMERGENCY_CHG) {
        const dir = currentPrice > state.lastBtcPrice ? '급등' : '급락';
        return {
          run: true, emergency: true,
          reason: `BTC ${dir} 긴급 트리거 (${(changePct * 100).toFixed(1)}%)`,
          currentBtcPrice: currentPrice,
        };
      }
    } catch (e) {
      console.warn(`  ⚠️ BTC 가격 확인 실패: ${e.message}`);
    }
  }

  const remainMin = Math.ceil((cycleMs - (now - state.lastCycleAt)) / 60000);
  const lastTime  = state.lastCycleAt > 0
    ? kst.toKST(new Date(state.lastCycleAt))
    : '없음';
  console.log(`⏳ [${params.mode}] 다음 사이클까지 ${remainMin}분 (마지막: ${lastTime})`);
  return { run: false, reason: `대기 중 (${remainMin}분 남음)` };
}

async function updateState(symbols) {
  const prev = loadState();
  let lastBtcPrice = prev.lastBtcPrice;
  if (symbols.some(s => s.startsWith('BTC'))) {
    try { lastBtcPrice = await fetchBtcPrice(); } catch {}
  }
  saveState({ ...prev, lastCycleAt: Date.now(), lastBtcPrice });
}

// ─── LU-004: USDT 잔고 부족 알림 ────────────────────────────────────

const USDT_LOW_THRESHOLD    = 20;                    // $20 이하 경고
const USDT_ALERT_INTERVAL   = 6 * 3600 * 1000;      // 6시간마다 1회

async function checkLowUsdtBalance() {
  try {
    const state = loadState();
    const now   = Date.now();
    if (state.lastUsdtAlertAt && (now - state.lastUsdtAlertAt) < USDT_ALERT_INTERVAL) return;

    const usdtFree = await fetchUsdtBalance();
    if (usdtFree < USDT_LOW_THRESHOLD) {
      const msg = `⚠️ [루나팀] USDT 잔고 부족\n현재: $${usdtFree.toFixed(2)} (권장 $${USDT_LOW_THRESHOLD}↑)\n바이낸스 입금이 필요합니다.`;
      publishAlert({ from_bot: 'luna', event_type: 'alert', alert_level: 2, message: msg });
      console.warn(`⚠️ USDT 잔고 부족: $${usdtFree.toFixed(2)}`);
      saveState({ ...state, lastUsdtAlertAt: now });
    }
  } catch (e) {
    console.warn(`  ⚠️ USDT 잔고 확인 실패: ${e.message}`);
  }
}

// ─── 예산 초과 리스너 ────────────────────────────────────────────────

tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  const label = type === 'daily' ? '일일' : '월간';
  const cost  = tracker.getToday();
  const msg   = `💸 [예산 초과] ${label} LLM 예산 초과 — 암호화폐 사이클 중단\n일간: $${cost.usage.toFixed(4)} | 월간: $${cost.monthUsage.toFixed(4)}`;
  console.error(msg);
  publishAlert({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: msg });
  process.exit(1);
});

// ─── 메인 사이클 ────────────────────────────────────────────────────

/**
 * 암호화폐 사이클 전체 실행
 * @param {string[]} symbols  ex) ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT']
 */
export async function runCryptoCycle(symbols, universeMeta = {}) {
  await initHubSecrets();
  const { paper: paperMode, tag } = getMarketExecutionModeInfo('crypto', '암호화폐');
  const startTime = Date.now();
  const params    = getLunaParams();
  let sessionId   = null;

  logMarketCycleStart({
    icon: '🚀',
    tag,
    marketLabel: '암호화폐',
    now: kst.toKST(new Date()),
    symbols,
    extraLines: [
      `   시간대: ${params.mode} | 최소신호점수: ${params.minSignalScore} | 최대포지션: ${params.maxOpenPositions}개`,
    ],
  });

  try {
    // ── 단계 1: 노드 기반 수집 실행 ──
    console.log('\n📊 [분석 단계] 노드 기반 수집 실행...');
    const collect = await runMarketCollectPipeline({
      market: 'binance',
      symbols,
      triggerType: 'cycle',
      meta: { market_script: 'crypto' },
      universeMeta: {
        screeningSymbolCount: Number(universeMeta.screeningSymbolCount || 0),
        heldSymbolCount: Number(universeMeta.heldSymbolCount || 0),
        heldAddedCount: Number(universeMeta.heldAddedCount || 0),
      },
    });
    sessionId = collect.sessionId;
    console.log(`  🧩 [노드] session=${collect.sessionId}`);
    console.log(`  🧩 [노드] ${summarizeNodeStatuses(collect.summaries)}`);
    await logMarketPipelineMetrics('암호화폐 수집', collect.metrics);

    // ── 단계 2: 루나 오케스트레이터 ──
    console.log('\n🌙 [판단 단계] 루나 오케스트레이터 실행...');
    const decision = await runDecisionExecutionPipeline({
      sessionId: collect.sessionId,
      symbols,
      exchange: 'binance',
      params,
    });
    const results = decision.results;
    await logMarketPipelineMetrics('암호화폐 판단', decision.metrics);

    // ── 단계 3: 헤파이스토스 실행 (PAPER_MODE: 신호만 저장) ──
    // 항상 실행 — 이전 사이클 pending 신호도 처리
    console.log(`\n⚡ [실행 단계] 헤파이스토스 실행 (이번 사이클: ${results.length}개 신호)...`);
    await processAllPendingSignals();

    // ── 상태 저장 ──
    await updateState(symbols);

    // LU-004: USDT 잔고 부족 알림 (LIVE 모드만)
    if (!paperMode) await checkLowUsdtBalance();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost    = tracker.getToday();
    await writeHeartbeat('luna-crypto', 'ok', {
      sessionId,
      symbolCount: symbols.length,
      durationSec: Number(elapsed),
      exitPhaseExecuted: Number(decision.metrics?.exitPhaseExecuted || 0),
      approvedSignals: Number(decision.metrics?.approvedSignals || 0),
    }).catch(() => {});
    logMarketCycleComplete({
      tag,
      marketLabel: '암호화폐',
      elapsedSec: elapsed,
      signalCount: results.length,
      dailyCost: cost.usage,
    });

    return results;

  } catch (e) {
    await writeHeartbeat('luna-crypto', 'error', {
      sessionId,
      symbolCount: symbols.length,
      error: e.message,
    }).catch(() => {});
    if (sessionId) {
      await finishPipelineRun(sessionId, {
        status: 'failed',
        meta: {
          bridge_status: 'market_cycle_failed',
          market_script: 'crypto',
          cycle_error: e.message,
        },
      }).catch(() => {});
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 사이클 오류 (${elapsed}초): ${e.message}`);
    console.error(e.stack);
    publishAlert({ from_bot: 'luna', event_type: 'system_error', alert_level: 3, message: `❌ 암호화폐 사이클 오류\n${e.message}` });
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
      const { symbols: cliSymbols, force, noDynamic } = parseUniverseCliFlags(args);

      let symbols;
      const cryptoMaxDynamic = getCryptoScreeningMaxDynamic();
      let universeMeta = {
        screeningSymbolCount: 0,
        heldSymbolCount: 0,
        heldAddedCount: 0,
      };
      if (Array.isArray(cliSymbols) && cliSymbols.length > 0) {
        symbols = cliSymbols;
        universeMeta.screeningSymbolCount = symbols.length;
      } else if (noDynamic) {
        symbols = getSymbols();
        universeMeta.screeningSymbolCount = symbols.length;
      } else {
        const { loadPreScreenedFallback, savePreScreened } = await import('../scripts/pre-market-screen.ts');
        const resolved = await resolveSymbolsWithFallback({
          market: 'crypto',
          screen: async () => {
            const { screenCryptoSymbols } = await import('../team/argos.ts');
            return screenCryptoSymbols();
          },
          loadCache: () => loadPreScreenedFallback('crypto'),
          defaultSymbols: getSymbols(),
          screenLabel: '아르고스 스크리닝',
          cacheLabel: 'RAG 폴백',
        });
        symbols = capDynamicUniverse(resolved.symbols, cryptoMaxDynamic, resolved.source || 'dynamic');
        universeMeta.screeningSymbolCount = symbols.length;
        if (resolved.source === 'screening') {
          savePreScreened('crypto', symbols);
          const { recordScreeningSuccess } = await import('../scripts/screening-monitor.ts');
          await recordScreeningSuccess('crypto');
        } else if (resolved.error && resolved.shouldCountFailure !== false) {
          const { recordScreeningFailure } = await import('../scripts/screening-monitor.ts');
          await recordScreeningFailure('crypto', resolved.error.message);
        } else if (symbols.length > 0) {
          const { recordScreeningSuccess } = await import('../scripts/screening-monitor.ts');
          await recordScreeningSuccess('crypto');
        }
      }

      const heldSymbols = (await db.getAllPositions('binance', false)).map((row) => row.symbol);
      universeMeta.heldSymbolCount = heldSymbols.length;
      universeMeta.heldAddedCount = getHeldMergeStats(symbols, heldSymbols).heldAddedCount;
      symbols = await appendHeldSymbols(symbols, 'binance');

      console.log(getMarketExecutionModeInfo('crypto', '암호화폐').logLine);

      const PAUSE_FLAG = join(homedir(), '.openclaw', 'workspace', 'luna-paused.flag');
      if (!force && existsSync(PAUSE_FLAG)) {
        console.log('⏸ 거래 일시정지 플래그 감지 — 사이클 스킵 (재개: resume_trading 명령)');
        return [];
      }

      const check = force ? { run: true, emergency: false, reason: '--force 옵션' } : await shouldRunCycle(symbols);
      if (!check.run) {
        console.log(`⏳ 사이클 스킵: ${check.reason}`);
        return [];
      }

      if (check.emergency) {
        console.log(`🚨 긴급 트리거: ${check.reason}`);
        publishAlert({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: `🚨 암호화폐 긴급 트리거\n${check.reason}` });
      } else {
        console.log(`🔄 ${check.reason}`);
      }

      return runCryptoCycle(symbols, universeMeta);
    },
    onSuccess: async (results) => {
      console.log(`\n최종 결과: ${results.length}개 신호 승인`);
    },
    errorPrefix: '❌ 종료 오류:',
  });
}
