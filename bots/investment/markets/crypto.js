'use strict';

/**
 * markets/crypto.js — 암호화폐 5분 사이클 (메인 진입점)
 *
 * 파이프라인:
 *   1. DB 초기화
 *   2. [병렬] 아리아(TA MTF) + 오라클(온체인) + 헤르메스(뉴스) + 소피아(감성)
 *   3. 루나 오케스트레이터 (강세/약세 토론 + 최종 신호 판단)
 *   4. 헤파이스토스 실행 (PAPER_MODE: DB + 텔레그램만)
 *
 * launchd: ai.investment.crypto (5분 주기)
 * 실행: PAPER_MODE=true node markets/crypto.js [--symbols=BTC/USDT,ETH/USDT]
 */

const db             = require('../shared/db');
const { getSymbols, isPaperMode } = require('../shared/secrets');
const { sendTelegram }            = require('../shared/report');

const { analyzeCryptoMTF }  = require('../team/aria');
const { analyzeOnchain }    = require('../team/oracle');
const { analyzeNews }       = require('../team/hermes');
const { analyzeSentiment }  = require('../team/sophia');
const { orchestrate }       = require('../team/luna');
const { processAllPendingSignals } = require('../team/hephaestos');

// ─── 사이클 단계별 병렬 분석 ────────────────────────────────────────

/**
 * 심볼 배열에 대해 TA MTF 병렬 실행
 */
async function runAria(symbols) {
  console.log(`\n🎵 [아리아] ${symbols.length}개 심볼 MTF TA 분석 시작`);
  const results = await Promise.allSettled(
    symbols.map(sym => analyzeCryptoMTF(sym))
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const v = r.value;
      console.log(`  ✅ [아리아] ${symbols[i]}: ${v?.signal || 'HOLD'} (${((v?.confidence || 0) * 100).toFixed(0)}%)`);
    } else {
      console.warn(`  ⚠️ [아리아] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

/**
 * 온체인 분석 (심볼 무관 — 시장 전체 지표)
 */
async function runOracle(symbols) {
  console.log(`\n🔮 [오라클] 온체인·매크로 분석 시작`);
  try {
    // 첫 번째 심볼로 대표 분석 (온체인은 BTC 위주)
    const primary = symbols.find(s => s.startsWith('BTC')) || symbols[0];
    const result  = await analyzeOnchain(primary, 'binance');
    if (result) {
      const fgDisplay = result.fearGreed ? `${result.fearGreed.value} (${result.fearGreed.classification})` : 'N/A';
      console.log(`  ✅ [오라클] 공포탐욕지수: ${fgDisplay} | ${result.signal}`);
    }
  } catch (e) {
    console.warn(`  ⚠️ [오라클] 분석 실패: ${e.message}`);
  }
}

/**
 * 뉴스 분석 병렬 실행
 */
async function runHermes(symbols) {
  console.log(`\n📰 [헤르메스] ${symbols.length}개 심볼 뉴스 분석 시작`);
  const results = await Promise.allSettled(
    symbols.map(sym => analyzeNews(sym, 'binance'))
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.log(`  ✅ [헤르메스] ${symbols[i]}: ${r.value?.signal || 'HOLD'}`);
    } else {
      console.warn(`  ⚠️ [헤르메스] ${symbols[i]}: ${r.reason?.message}`);
    }
  });
}

/**
 * 감성 분석 병렬 실행
 */
async function runSophia(symbols) {
  console.log(`\n💭 [소피아] ${symbols.length}개 심볼 감성 분석 시작`);
  const results = await Promise.allSettled(
    symbols.map(sym => analyzeSentiment(sym, 'binance'))
  );
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
 * 암호화폐 5분 사이클 전체 실행
 * @param {string[]} symbols  ex) ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT']
 */
async function runCryptoCycle(symbols) {
  const paperMode = isPaperMode();
  const startTime = Date.now();
  const tag       = paperMode ? '[PAPER]' : '[LIVE]';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 ${tag} 암호화폐 사이클 시작 — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
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
    const results = await orchestrate(symbols, 'binance');

    // ── 단계 3: 헤파이스토스 실행 (PAPER_MODE: 신호만 저장) ──
    if (results.length > 0) {
      console.log(`\n⚡ [실행 단계] 헤파이스토스 ${results.length}개 신호 처리...`);
      await processAllPendingSignals();
    } else {
      console.log('\n  ℹ️ [실행 단계] 실행할 신호 없음');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ ${tag} 사이클 완료 — ${elapsed}초 | ${results.length}개 신호`);
    console.log(`${'═'.repeat(60)}\n`);

    return results;

  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`\n❌ 사이클 오류 (${elapsed}초): ${e.message}`);
    console.error(e.stack);

    await sendTelegram(`❌ 암호화폐 사이클 오류\n${e.message}`).catch(() => {});
    throw e;
  }
}

// ─── CLI 실행 ───────────────────────────────────────────────────────

if (require.main === module) {
  const args     = process.argv.slice(2);
  const symArg   = args.find(a => a.startsWith('--symbols='));
  const symbols  = symArg
    ? symArg.split('=')[1].split(',').map(s => s.trim())
    : getSymbols();

  // PAPER_MODE 환경변수 안내
  if (isPaperMode()) {
    console.log('📄 PAPER_MODE=true — 실주문 없이 신호 생성만 (Phase 3-A)');
  } else {
    console.log('🔴 PAPER_MODE=false — 실주문 실행 모드 (주의!)');
  }

  db.initSchema()
    .then(() => runCryptoCycle(symbols))
    .then(r => {
      console.log(`\n최종 결과: ${r.length}개 신호 승인`);
      process.exit(0);
    })
    .catch(e => {
      console.error('❌ 종료 오류:', e.message);
      process.exit(1);
    });
}

module.exports = { runCryptoCycle };
