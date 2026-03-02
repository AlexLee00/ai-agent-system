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
import { fileURLToPath } from 'url';

import * as db from '../shared/db.js';
import { getKisSymbols, isKisMarketOpen, isPaperMode } from '../shared/secrets.js';
import { sendTelegram } from '../shared/report.js';
import { tracker } from '../shared/cost-tracker.js';

import { analyzeKisMTF }               from '../team/aria.js';
import { analyzeNews }                 from '../team/hermes.js';
import { analyzeSentiment }            from '../team/sophia.js';
import { orchestrate }                 from '../team/luna.js';
import { processAllPendingKisSignals } from '../team/hanul.js';

// ─── 30분 주기 상태 파일 ────────────────────────────────────────────

const STATE_FILE     = join(homedir(), '.openclaw', 'investment-domestic-state.json');
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
    ? new Date(state.lastCycleAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul' })
    : '없음';
  console.log(`⏳ 다음 사이클까지 ${remainMin}분 (마지막: ${lastTime})`);
  return { run: false, reason: `대기 중 (${remainMin}분 남음)` };
}

// ─── 예산 초과 리스너 ────────────────────────────────────────────────

tracker.once('BUDGET_EXCEEDED', async ({ type }) => {
  const label = type === 'daily' ? '일일' : '월간';
  const cost  = tracker.getToday();
  const msg   = `💸 [예산 초과] ${label} LLM 예산 초과 — 국내주식 사이클 중단\n일간: $${cost.usage.toFixed(4)} | 월간: $${cost.monthUsage.toFixed(4)}`;
  console.error(msg);
  await sendTelegram(msg).catch(() => {});
  process.exit(1);
});

// ─── 분석가 래퍼 (국내주식) ──────────────────────────────────────────

async function runAria(symbols) {
  console.log(`\n🎵 [아리아] ${symbols.length}개 국내주식 TA 분석 (일봉/1h)`);
  const results = await Promise.allSettled(symbols.map(sym => analyzeKisMTF(sym)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const v = r.value;
      console.log(`  ✅ [아리아] ${symbols[i]}: ${v?.signal || 'HOLD'} (${((v?.confidence || 0) * 100).toFixed(0)}%)`);
    } else {
      console.warn(`  ⚠️ [아리아] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

async function runHermes(symbols) {
  console.log(`\n📰 [헤르메스] ${symbols.length}개 심볼 국내 뉴스·공시 분석`);
  const results = await Promise.allSettled(symbols.map(sym => analyzeNews(sym, 'kis')));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`  ✅ [헤르메스] ${symbols[i]}: ${r.value?.signal || 'HOLD'}`);
    } else {
      console.warn(`  ⚠️ [헤르메스] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

async function runSophia(symbols) {
  console.log(`\n💭 [소피아] ${symbols.length}개 심볼 네이버 증권 토론실 감성 분석`);
  const results = await Promise.allSettled(symbols.map(sym => analyzeSentiment(sym, 'kis')));
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
 * 국내주식 사이클 전체 실행
 * @param {string[]} symbols  ex) ['005930', '000660']
 */
export async function runDomesticCycle(symbols) {
  const paperMode = isPaperMode();
  const startTime = Date.now();
  const tag       = paperMode ? '[PAPER]' : '[LIVE]';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏦 ${tag} 국내주식 사이클 시작 — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
  console.log(`${'═'.repeat(60)}`);

  try {
    // ── 단계 1: 분석가 병렬 실행 (아리아·헤르메스·소피아) ──
    console.log('\n📊 [분석 단계] 3개 분석가 병렬 실행...');
    await Promise.allSettled([
      runAria(symbols),
      runHermes(symbols),
      runSophia(symbols),
    ]);

    // ── 단계 2: 루나 오케스트레이터 ──
    console.log('\n🌙 [판단 단계] 루나 오케스트레이터 실행...');
    const results = await orchestrate(symbols, 'kis');

    // ── 단계 3: 한울 실행 (PAPER_MODE: 신호만 저장) ──
    if (results.length > 0) {
      console.log(`\n⚡ [실행 단계] 한울 ${results.length}개 신호 처리...`);
      await processAllPendingKisSignals();
    } else {
      console.log('\n  ℹ️ [실행 단계] 실행할 신호 없음');
    }

    // ── 상태 저장 ──
    saveState({ lastCycleAt: Date.now() });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const cost    = tracker.getToday();
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ ${tag} 국내주식 사이클 완료 — ${elapsed}초 | ${results.length}개 신호 | LLM $${cost.usage.toFixed(4)}/일`);
    console.log(`${'═'.repeat(60)}\n`);

    return results;

  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 국내주식 사이클 오류 (${elapsed}초): ${e.message}`);
    console.error(e.stack);
    await sendTelegram(`❌ 국내주식 사이클 오류\n${e.message}`).catch(() => {});
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
    : getKisSymbols();

  if (isPaperMode()) {
    console.log('📄 PAPER_MODE=true — 실주문 없이 신호 생성만 (Phase 3-B)');
  } else {
    console.log('🔴 PAPER_MODE=false — 실주문 실행 모드 (주의!)');
  }

  // 장중 체크
  if (!force && !isKisMarketOpen()) {
    const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
    console.log(`⏰ 장외 시간 (KST ${now}) — 스킵`);
    process.exit(0);
  }

  // 30분 주기 체크
  const check = shouldRunCycle(force);
  if (!check.run) {
    console.log(`⏳ 사이클 스킵: ${check.reason}`);
    process.exit(0);
  }

  console.log(`🔄 ${check.reason}`);

  await db.initSchema();
  try {
    const r = await runDomesticCycle(symbols);
    console.log(`\n최종 결과: ${r.length}개 신호 승인`);
    process.exit(0);
  } catch (e) {
    console.error('❌ 종료 오류:', e.message);
    process.exit(1);
  }
}
