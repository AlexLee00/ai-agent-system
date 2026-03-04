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
import { fileURLToPath } from 'url';

import * as db from '../shared/db.js';
import { getSymbols, isPaperMode } from '../shared/secrets.js';
import { publishToMainBot } from '../shared/mainbot-client.js';
import { tracker } from '../shared/cost-tracker.js';
import { getLunaParams } from '../shared/time-mode.js';

import { analyzeCryptoMTF }         from '../team/aria.js';
import { analyzeOnchain }           from '../team/oracle.js';
import { analyzeNews }              from '../team/hermes.js';
import { analyzeSentiment }         from '../team/sophia.js';
import { orchestrate }              from '../team/luna.js';
import { processAllPendingSignals } from '../team/hephaestos.js';

// ─── 30분 주기 상태 파일 ────────────────────────────────────────────

const STATE_FILE    = join(homedir(), '.openclaw', 'investment-state.json');
const EMERGENCY_CHG = 0.03;  // BTC ±3% 긴급 트리거

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastCycleAt: 0, lastBtcPrice: 0 }; }
}

function saveState(state) {
  try {
    mkdirSync(join(homedir(), '.openclaw'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn(`  ⚠️ 상태 저장 실패: ${e.message}`);
  }
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
    ? new Date(state.lastCycleAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })
    : '없음';
  console.log(`⏳ [${params.mode}] 다음 사이클까지 ${remainMin}분 (마지막: ${lastTime})`);
  return { run: false, reason: `대기 중 (${remainMin}분 남음)` };
}

async function updateState(symbols) {
  let lastBtcPrice = loadState().lastBtcPrice;
  if (symbols.some(s => s.startsWith('BTC'))) {
    try { lastBtcPrice = await fetchBtcPrice(); } catch {}
  }
  saveState({ lastCycleAt: Date.now(), lastBtcPrice });
}

// ─── 예산 초과 리스너 ────────────────────────────────────────────────

tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  const label = type === 'daily' ? '일일' : '월간';
  const cost  = tracker.getToday();
  const msg   = `💸 [예산 초과] ${label} LLM 예산 초과 — 암호화폐 사이클 중단\n일간: $${cost.usage.toFixed(4)} | 월간: $${cost.monthUsage.toFixed(4)}`;
  console.error(msg);
  publishToMainBot({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: msg });
  process.exit(1);
});

// ─── 사이클 단계별 병렬 분석 ────────────────────────────────────────

async function runAria(symbols) {
  console.log(`\n🎵 [아리아] ${symbols.length}개 심볼 MTF TA 분석 시작`);
  const results = await Promise.allSettled(symbols.map(sym => analyzeCryptoMTF(sym)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const v = r.value;
      console.log(`  ✅ [아리아] ${symbols[i]}: ${v?.signal || 'HOLD'} (${((v?.confidence || 0) * 100).toFixed(0)}%)`);
    } else {
      console.warn(`  ⚠️ [아리아] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

async function runOracle(symbols) {
  console.log(`\n🔮 [오라클] 온체인·매크로 분석 시작`);
  try {
    const primary = symbols.find(s => s.startsWith('BTC')) || symbols[0];
    const result  = await analyzeOnchain(primary, 'binance');
    if (result) {
      const fgDisplay = result.fearGreed
        ? `${result.fearGreed.value} (${result.fearGreed.classification})`
        : 'N/A';
      console.log(`  ✅ [오라클] 공포탐욕지수: ${fgDisplay} | ${result.signal}`);
    }
  } catch (e) {
    console.warn(`  ⚠️ [오라클] 분석 실패: ${e.message}`);
  }
}

async function runHermes(symbols) {
  console.log(`\n📰 [헤르메스] ${symbols.length}개 심볼 뉴스 분석 시작`);
  const results = await Promise.allSettled(symbols.map(sym => analyzeNews(sym, 'binance')));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`  ✅ [헤르메스] ${symbols[i]}: ${r.value?.signal || 'HOLD'}`);
    } else {
      console.warn(`  ⚠️ [헤르메스] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

async function runSophia(symbols) {
  console.log(`\n💭 [소피아] ${symbols.length}개 심볼 감성 분석 시작`);
  const results = await Promise.allSettled(symbols.map(sym => analyzeSentiment(sym, 'binance')));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`  ✅ [소피아] ${symbols[i]}: ${r.value?.signal || 'HOLD'}`);
    } else {
      console.warn(`  ⚠️ [소피아] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

// ─── 메인 사이클 ────────────────────────────────────────────────────

/**
 * 암호화폐 사이클 전체 실행
 * @param {string[]} symbols  ex) ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT']
 */
export async function runCryptoCycle(symbols) {
  const paperMode = isPaperMode();
  const startTime = Date.now();
  const tag       = paperMode ? '[PAPER]' : '[LIVE]';
  const params    = getLunaParams();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 ${tag} 암호화폐 사이클 시작 — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
  console.log(`   시간대: ${params.mode} | 최소신호점수: ${params.minSignalScore} | 최대포지션: ${params.maxOpenPositions}개`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // ── 단계 1: 분석가 병렬 실행 (아리아·오라클·헤르메스·소피아) ──
    console.log('\n📊 [분석 단계] 4개 분석가 병렬 실행...');
    await Promise.allSettled([
      runAria(symbols),
      runOracle(symbols),
      runHermes(symbols),
      runSophia(symbols),
    ]);

    // ── 단계 2: 루나 오케스트레이터 ──
    console.log('\n🌙 [판단 단계] 루나 오케스트레이터 실행...');
    const results = await orchestrate(symbols, 'binance', params);

    // ── 단계 3: 헤파이스토스 실행 (PAPER_MODE: 신호만 저장) ──
    if (results.length > 0) {
      console.log(`\n⚡ [실행 단계] 헤파이스토스 ${results.length}개 신호 처리...`);
      await processAllPendingSignals();
    } else {
      console.log('\n  ℹ️ [실행 단계] 실행할 신호 없음');
    }

    // ── 상태 저장 ──
    await updateState(symbols);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost    = tracker.getToday();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ ${tag} 사이클 완료 — ${elapsed}초 | ${results.length}개 신호 | LLM $${cost.usage.toFixed(4)}/일`);
    console.log(`${'═'.repeat(60)}\n`);

    return results;

  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 사이클 오류 (${elapsed}초): ${e.message}`);
    console.error(e.stack);
    publishToMainBot({ from_bot: 'luna', event_type: 'system_error', alert_level: 3, message: `❌ 암호화폐 사이클 오류\n${e.message}` });
    throw e;
  }
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args    = process.argv.slice(2);
  const symArg  = args.find(a => a.startsWith('--symbols='));
  const force   = args.includes('--force');
  const symbols = symArg
    ? symArg.split('=')[1].split(',').map(s => s.trim())
    : getSymbols();

  if (isPaperMode()) {
    console.log('📄 PAPER_MODE=true — 실주문 없이 신호 생성만 (Phase 3-A)');
  } else {
    console.log('🔴 PAPER_MODE=false — 실주문 실행 모드 (주의!)');
  }

  // 거래 일시정지 플래그 확인 (luna-commander가 제어)
  const PAUSE_FLAG = join(homedir(), '.openclaw', 'workspace', 'luna-paused.flag');
  if (!force && existsSync(PAUSE_FLAG)) {
    console.log('⏸ 거래 일시정지 플래그 감지 — 사이클 스킵 (재개: resume_trading 명령)');
    process.exit(0);
  }

  // 30분 주기 또는 긴급 트리거 확인
  const check = force ? { run: true, emergency: false, reason: '--force 옵션' } : await shouldRunCycle(symbols);

  if (!check.run) {
    console.log(`⏳ 사이클 스킵: ${check.reason}`);
    process.exit(0);
  }

  if (check.emergency) {
    console.log(`🚨 긴급 트리거: ${check.reason}`);
    publishToMainBot({ from_bot: 'luna', event_type: 'alert', alert_level: 3, message: `🚨 암호화폐 긴급 트리거\n${check.reason}` });
  } else {
    console.log(`🔄 ${check.reason}`);
  }

  await db.initSchema();

  try {
    const r = await runCryptoCycle(symbols);
    console.log(`\n최종 결과: ${r.length}개 신호 승인`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 종료 오류:', e.message);
    process.exit(1);
  }
}
