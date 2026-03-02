'use strict';
const ccxt = require('ccxt');
const secrets = JSON.parse(require('fs').readFileSync('./secrets.json'));

(async () => {
  const ex = new ccxt.upbit({ apiKey: secrets.upbit_access_key, secret: secrets.upbit_secret_key });
  await ex.loadMarkets();

  // USDT 출금 네트워크 목록 확인
  const currencies = await ex.fetchCurrencies();
  const usdt = currencies['USDT'];
  console.log('=== USDT 출금 네트워크 ===');
  console.log(JSON.stringify(usdt?.networks, null, 2));
  console.log('\n=== USDT 전체 정보 ===');
  console.log('withdraw fee:', usdt?.fee);
  console.log('withdraw limits:', JSON.stringify(usdt?.limits?.withdraw));
})().catch(e => console.error('❌', e.message));
