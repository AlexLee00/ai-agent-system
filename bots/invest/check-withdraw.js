'use strict';
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const secrets = JSON.parse(require('fs').readFileSync('./secrets.json'));

function makeToken(queryString = '') {
  const payload = { access_key: secrets.upbit_access_key, nonce: uuidv4() };
  if (queryString) {
    const crypto = require('crypto');
    payload.query_hash = crypto.createHash('sha512').update(queryString).digest('hex');
    payload.query_hash_alg = 'SHA512';
  }
  return jwt.sign(payload, secrets.upbit_secret_key, { algorithm: 'HS256' });
}

function httpsGet(path) {
  return new Promise((resolve, reject) => {
    const token = makeToken();
    const options = {
      hostname: 'api.upbit.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // 입출금 현황 조회 (USDT 네트워크 확인)
  console.log('=== 업비트 USDT 서비스 상태 ===');
  const status = await httpsGet('/v1/status/wallet');
  const usdtEntries = Array.isArray(status)
    ? status.filter(s => s.currency === 'USDT')
    : [];
  console.log(JSON.stringify(usdtEntries, null, 2));

  // 출금 가능 주소 목록
  console.log('\n=== 등록된 출금 주소 목록 ===');
  const addrs = await httpsGet('/v1/withdraws/coin_addresses');
  const usdtAddrs = Array.isArray(addrs)
    ? addrs.filter(a => a.currency === 'USDT')
    : addrs;
  console.log(JSON.stringify(usdtAddrs, null, 2));
})().catch(e => console.error('❌', e.message));
