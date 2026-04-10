// @ts-nocheck
/**
 * manual/transfer/market-status.js — 시장 현황 조회
 * 사용: node manual/transfer/market-status.js
 */

function isKisMarketOpen() {
  const now        = new Date();
  const kstOffset  = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
  const kstDay     = new Date(now.getTime() + kstOffset * 60000).getUTCDay();
  if (kstDay === 0 || kstDay === 6) return false;
  return kstMinutes >= 9 * 60 && kstMinutes < 15 * 60 + 30;
}

function isKisOverseasMarketOpen() {
  const now        = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const utcDay     = now.getUTCDay();
  if (utcDay === 0 || utcDay === 6) return false;
  const month    = now.getUTCMonth() + 1;
  const isDST    = month >= 4 && month <= 10;
  const openUtc  = isDST ? 13 * 60 + 30 : 14 * 60 + 30;
  const closeUtc = isDST ? 20 * 60       : 21 * 60;
  return utcMinutes >= openUtc && utcMinutes < closeUtc;
}

const now        = new Date();
const kstOffset  = 9 * 60;
const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
const kstMinutes = (utcMinutes + kstOffset) % (24 * 60);
const kstH       = Math.floor(kstMinutes / 60);
const kstM       = kstMinutes % 60;
const kstTimeStr = `${String(kstH).padStart(2,'0')}:${String(kstM).padStart(2,'0')} KST`;

const month  = now.getUTCMonth() + 1;
const isDST  = month >= 4 && month <= 10;
const d      = isKisMarketOpen();
const o      = isKisOverseasMarketOpen();

const openKst  = isDST ? '22:30' : '23:30';
const closeKst = isDST ? '05:00+1' : '06:00+1';

const lines = [`📊 시장 현황 (${kstTimeStr})`];
lines.push(`${d ? '🟢' : '🔴'} 국내주식 (KOSPI/KOSDAQ): ${d ? '장중 ▶' : '장외 ■'}`);
if (!d) lines.push(`   개장 09:00 / 마감 15:30 KST (평일)`);
lines.push(`${o ? '🟢' : '🔴'} 미국주식 (NYSE/NASDAQ): ${o ? '장중 ▶' : '장외 ■'}`);
if (!o) lines.push(`   개장 ${openKst} / 마감 ${closeKst} KST (평일${isDST ? ', 서머타임' : ''})`);
lines.push(`🟢 암호화폐 (바이낸스/업비트): 24/7 거래 중`);

console.log(lines.join('\n'));
