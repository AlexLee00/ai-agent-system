#!/usr/bin/env node
/**
 * unrealized_pnl 갱신 스크립트
 * LIVE 포지션의 현재가를 조회하여 미실현 PnL 업데이트
 * 
 * launchd로 10분 주기 실행 권장
 */
import pg from 'pg';
import ccxt from 'ccxt';
import { initHubSecrets } from '../shared/secrets.js';
import { getDomesticPrice, getOverseasPrice } from '../shared/kis-client.js';

const { Pool } = pg;
const pool = new Pool({ database: 'jay', user: process.env.USER || 'alexlee' });

async function main() {
  await initHubSecrets();
  console.log(`\n=== unrealized_pnl 갱신 (${new Date().toLocaleString('ko-KR')}) ===\n`);

  // LIVE 포지션 조회
  const { rows: positions } = await pool.query(`
    SELECT symbol, exchange, amount, avg_price, trade_mode
    FROM investment.positions 
    WHERE paper = false AND amount > 0
    ORDER BY exchange, symbol
  `);

  if (positions.length === 0) {
    console.log('LIVE 포지션 없음');
    await pool.end();
    return;
  }

  // 바이낸스 현재가 조회
  const binancePositions = positions.filter(p => p.exchange === 'binance');
  let binancePrices = {};
  if (binancePositions.length > 0) {
    try {
      const exchange = new ccxt.binance({ enableRateLimit: true });
      const tickers = await exchange.fetchTickers(binancePositions.map(p => p.symbol));
      for (const [sym, ticker] of Object.entries(tickers)) {
        binancePrices[sym] = ticker.last;
      }
    } catch (e) {
      console.error('바이낸스 시세 조회 실패:', e.message);
    }
  }

  async function updatePosition(pos, currentPrice, label, priceDisplay, decimals = 4) {
    if (!currentPrice || pos.avg_price <= 0) {
      console.log(`⏸️ ${pos.symbol} (${label}): 시세 미조회`);
      return 0;
    }

    const unrealizedPnl = (currentPrice - pos.avg_price) * pos.amount;
    const pnlPct = ((currentPrice - pos.avg_price) / pos.avg_price * 100).toFixed(2);

    await pool.query(`
      UPDATE investment.positions
      SET unrealized_pnl = $1, updated_at = now()
      WHERE symbol = $2 AND exchange = $3 AND paper = false AND trade_mode = $4
    `, [unrealizedPnl, pos.symbol, pos.exchange, pos.trade_mode]);

    console.log(`✅ ${pos.symbol} (${label}): ${priceDisplay} (${pnlPct > 0 ? '+' : ''}${pnlPct}%) unrealized=${unrealizedPnl.toFixed(decimals)}`);
    return 1;
  }

  let updated = 0;

  for (const pos of binancePositions) {
    updated += await updatePosition(
      pos,
      binancePrices[pos.symbol],
      'binance',
      String(binancePrices[pos.symbol] || ''),
      4,
    );
  }

  const kisPositions = positions.filter((p) => p.exchange === 'kis');
  for (const pos of kisPositions) {
    try {
      const price = await getDomesticPrice(pos.symbol, false);
      updated += await updatePosition(pos, price, 'KIS', `${price}원`, 0);
    } catch (e) {
      console.log(`⚠️ ${pos.symbol} (KIS): ${e.message}`);
    }
  }

  const kisOverseasPositions = positions.filter((p) => p.exchange === 'kis_overseas');
  for (const pos of kisOverseasPositions) {
    try {
      const { price } = await getOverseasPrice(pos.symbol);
      updated += await updatePosition(pos, price, 'KIS해외', `$${price}`, 4);
    } catch (e) {
      console.log(`⚠️ ${pos.symbol} (KIS해외): ${e.message}`);
    }
  }

  console.log(`\n${positions.length}건 중 ${updated}건 갱신 완료`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
