'use strict';

/**
 * markets/overseas.js — 해외주식(미국) 30분 사이클 (Skeleton)
 *
 * 파이프라인 (Phase 3-B에서 구현):
 *   1. 장중 여부 확인 (NYSE/NASDAQ, 서머타임 자동 반영)
 *   2. [병렬] 아리아(TA) + 헤르메스(Yahoo/MarketWatch) + 소피아(Reddit+AlphaVantage+xAI)
 *   3. 루나 오케스트레이터
 *   4. 한울 실행 (KIS 해외주식)
 *
 * launchd: ai.investment.overseas (30분 주기, 장중만)
 * 실행: node markets/overseas.js [--symbols=AAPL,TSLA,NVDA]
 */

const db         = require('../shared/db');
const { getKisOverseasSymbols, isKisOverseasMarketOpen, isPaperMode } = require('../shared/secrets');

const { orchestrate }                          = require('../team/luna');
const { processAllPendingKisOverseasSignals }  = require('../team/hanul');

/**
 * 미국주식 30분 사이클 실행 (Skeleton)
 * @param {string[]} symbols  ex) ['AAPL', 'TSLA', 'NVDA']
 */
async function runOverseasCycle(symbols) {
  const paperMode = isPaperMode();
  const tag       = paperMode ? '[PAPER]' : '[LIVE]';

  if (!isKisOverseasMarketOpen()) {
    const now = new Date().toISOString().slice(11, 16);
    console.log(`⏰ [미국장] 장외 시간 (UTC ${now}) — 스킵`);
    return [];
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🗽 ${tag} 미국주식 사이클 시작 — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
  console.log(`${'═'.repeat(60)}`);

  // TODO: Phase 3-B
  // 1. runAria(symbols, 'kis_overseas')
  // 2. runHermes(symbols, 'kis_overseas')
  // 3. runSophia(symbols, 'kis_overseas') — xAI X Search 30분 주기 포함
  // 4. orchestrate(symbols, 'kis_overseas')
  // 5. processAllPendingKisOverseasSignals()

  console.log('  ℹ️ 미국주식 사이클 Skeleton — Phase 3-B에서 구현 예정');

  try {
    const results = await orchestrate(symbols, 'kis_overseas');
    if (results.length > 0) {
      await processAllPendingKisOverseasSignals();
    }
    return results;
  } catch (e) {
    console.error(`❌ 미국주식 사이클 오류: ${e.message}`);
    return [];
  }
}

// CLI 실행
if (require.main === module) {
  const args    = process.argv.slice(2);
  const symArg  = args.find(a => a.startsWith('--symbols='));
  const symbols = symArg
    ? symArg.split('=')[1].split(',').map(s => s.trim())
    : getKisOverseasSymbols();

  db.initSchema()
    .then(() => runOverseasCycle(symbols))
    .then(r => { console.log(`완료: ${r.length}개 신호`); process.exit(0); })
    .catch(e => { console.error('❌:', e.message); process.exit(1); });
}

module.exports = { runOverseasCycle };
