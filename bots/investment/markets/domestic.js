/**
 * markets/domestic.js — 국내주식 30분 사이클 (Skeleton)
 *
 * 파이프라인 (Phase 3-B에서 구현):
 *   1. 장중 여부 확인 (KST 09:00~15:30)
 *   2. [병렬] 아리아(TA) + 헤르메스(Naver뉴스+DART) + 소피아(네이버증권 토론실)
 *   3. 루나 오케스트레이터
 *   4. 한울 실행 (KIS 국내주식)
 *
 * launchd: ai.investment.domestic (30분 주기, 장중만)
 * 실행: node markets/domestic.js [--symbols=005930,000660]
 */

import { fileURLToPath } from 'url';
import * as db from '../shared/db.js';
import { getKisSymbols, isKisMarketOpen, isPaperMode } from '../shared/secrets.js';
import { orchestrate } from '../team/luna.js';
import { processAllPendingKisSignals } from '../team/hanul.js';

/**
 * 국내주식 30분 사이클 실행 (Skeleton)
 * @param {string[]} symbols  ex) ['005930', '000660']
 */
export async function runDomesticCycle(symbols) {
  const paperMode = isPaperMode();
  const tag       = paperMode ? '[PAPER]' : '[LIVE]';

  if (!isKisMarketOpen()) {
    const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(11, 16);
    console.log(`⏰ [국내장] 장외 시간 (KST ${now}) — 스킵`);
    return [];
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🏦 ${tag} 국내주식 사이클 시작 — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  console.log(`   심볼: ${symbols.join(', ')}`);
  console.log(`${'═'.repeat(60)}`);

  // TODO: Phase 3-B
  // 1. runAria(symbols, 'kis')
  // 2. runHermes(symbols, 'kis')
  // 3. runSophia(symbols, 'kis')
  // 4. orchestrate(symbols, 'kis')
  // 5. processAllPendingKisSignals()

  console.log('  ℹ️ 국내주식 사이클 Skeleton — Phase 3-B에서 구현 예정');

  try {
    const results = await orchestrate(symbols, 'kis');
    if (results.length > 0) {
      await processAllPendingKisSignals();
    }
    return results;
  } catch (e) {
    console.error(`❌ 국내주식 사이클 오류: ${e.message}`);
    return [];
  }
}

// CLI 실행
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args    = process.argv.slice(2);
  const symArg  = args.find(a => a.startsWith('--symbols='));
  const symbols = symArg
    ? symArg.split('=')[1].split(',').map(s => s.trim())
    : getKisSymbols();

  await db.initSchema();
  try {
    const r = await runDomesticCycle(symbols);
    console.log(`완료: ${r.length}개 신호`);
    process.exit(0);
  } catch (e) {
    console.error('❌:', e.message);
    process.exit(1);
  }
}
