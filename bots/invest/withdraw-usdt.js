'use strict';
const ccxt = require('ccxt');
const secrets = JSON.parse(require('fs').readFileSync('./secrets.json'));

const TEST_AMOUNT   = 1;          // 테스트 전송량 (USDT)
const POLL_INTERVAL = 10_000;     // 상태 확인 주기 (ms)
const POLL_TIMEOUT  = 10 * 60_000; // 최대 대기 시간 (10분)

function getExchange() {
  return new ccxt.upbit({
    apiKey: secrets.upbit_access_key,
    secret: secrets.upbit_secret_key,
    options: { createMarketBuyOrderRequiresPrice: false },
  });
}

// 업비트 USDT 출금 (net_type=TRX, 소수점 6자리 버림)
async function upbitWithdraw(ex, amount, addr) {
  const truncated = Math.floor(amount * 1e6) / 1e6;
  return ex.withdraw('USDT', truncated, addr, undefined, { network: 'TRX' });
}

// 출금 완료 폴링 (state: DONE=성공, FAILED/CANCELLED=실패)
async function waitForCompletion(ex, withdrawId) {
  const deadline = Date.now() + POLL_TIMEOUT;
  let elapsed = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    elapsed += POLL_INTERVAL;

    const wd = await ex.fetchWithdrawal(withdrawId, 'USDT');
    const state = wd.info?.state ?? '';
    console.log(`  [${Math.floor(elapsed / 1000)}s] 상태: ${state} | txid: ${wd.info?.txid ?? '대기 중'}`);

    if (state === 'DONE') return { ok: true, txid: wd.info?.txid };
    if (state === 'FAILED' || state === 'CANCELLED') return { ok: false, state };
  }

  return { ok: false, state: 'TIMEOUT' };
}

(async () => {
  const ex = getExchange();
  const addr = secrets.binance_deposit_address_usdt;

  // 잔고 확인
  const bal = await ex.fetchBalance();
  const usdtFree = bal.free.USDT || 0;
  console.log(`업비트 USDT 잔고: ${usdtFree} USDT`);
  console.log(`바이낸스 입금 주소 (TRC20): ${addr}\n`);

  if (usdtFree < TEST_AMOUNT + 1) {
    console.log(`❌ USDT 부족 (최소 ${TEST_AMOUNT + 1} USDT 필요)`);
    process.exit(1);
  }

  // ── STEP 1: 테스트 전송 ──────────────────────────────────────
  console.log(`▶ [1/2] 테스트 전송: ${TEST_AMOUNT} USDT → ${addr}`);
  const testResult = await upbitWithdraw(ex, TEST_AMOUNT, addr);
  console.log(`  출금 ID: ${testResult.id}`);
  console.log(`  금액:   ${testResult.amount} USDT`);
  console.log(`  수수료: ${testResult.fee?.cost ?? 0} USDT`);
  console.log(`\n  ⏳ 완료 대기 중 (최대 10분)...`);

  const testCheck = await waitForCompletion(ex, testResult.id);

  if (!testCheck.ok) {
    console.log(`\n❌ 테스트 전송 실패 — 상태: ${testCheck.state}`);
    console.log('   본 전송을 중단합니다.');
    process.exit(1);
  }
  console.log(`\n✅ 테스트 전송 완료 | txid: ${testCheck.txid}`);

  // ── STEP 2: 나머지 전송 ──────────────────────────────────────
  const balAfter = await ex.fetchBalance();
  const remaining = balAfter.free.USDT || 0;
  console.log(`\n▶ [2/2] 나머지 전송: ${remaining} USDT → ${addr}`);

  if (remaining < 1) {
    console.log('❌ 나머지 잔고 부족 — 전송 생략');
    process.exit(0);
  }

  const mainResult = await upbitWithdraw(ex, remaining, addr);
  console.log(`  출금 ID: ${mainResult.id}`);
  console.log(`  금액:   ${mainResult.amount} USDT`);
  console.log(`  수수료: ${mainResult.fee?.cost ?? 0} USDT`);
  console.log(`\n  ⏳ 완료 대기 중 (최대 10분)...`);

  const mainCheck = await waitForCompletion(ex, mainResult.id);

  if (!mainCheck.ok) {
    console.log(`\n❌ 나머지 전송 실패 — 상태: ${mainCheck.state}`);
    process.exit(1);
  }

  console.log(`\n✅ 전체 전송 완료`);
  console.log(`   테스트: ${TEST_AMOUNT} USDT | txid: ${testCheck.txid}`);
  console.log(`   나머지: ${mainResult.amount} USDT | txid: ${mainCheck.txid}`);
})().catch(e => {
  console.error('❌', e.message);
  process.exit(1);
});
