'use strict';

/**
 * scripts/backtest.js — 루나 백테스팅 엔진 (LU-037)
 *
 * 기존 TA 전략(RSI/MACD/BB/MA/Stoch/ATR/Volume)을 역사적 데이터에 적용해
 * 가상 트레이딩 성과를 측정합니다.
 *
 * 실행:
 *   node scripts/backtest.js [옵션]
 *   node scripts/backtest.js --symbol=BTC/USDT --timeframe=1d --days=365
 *   node scripts/backtest.js --symbol=ETH/USDT --timeframe=4h --days=180 --amount=200
 *   node scripts/backtest.js --all                              (4개 심볼 모두)
 *   node scripts/backtest.js --symbol=BTC/USDT --send          (텔레그램 발송)
 */

const ccxt = require('ccxt');
const {
  calcRSI, calcMACD, calcBB,
  calcMovingAverages, calcStochastic, calcATR, analyzeVolume,
  judgeSignal,
} = require('../src/analysts/ta-analyst');
const { loadSecrets, getSymbols } = require('../lib/secrets');
const { sendTelegram }            = require('../lib/telegram');

// ─── 기본 파라미터 ──────────────────────────────────────────────────

const DEFAULTS = {
  timeframe:     '1d',
  days:          365,
  amountUsdt:    100,    // 거래당 고정 금액
  commission:    0.001,  // 0.1% 바이낸스 수수료
  stopLossPct:   0.03,   // 손절 -3%
  takeProfitPct: 0.06,   // 익절 +6%
  minConfidence: 0.50,   // 신호 최소 확신도
  warmupBars:    120,    // 지표 워밍업 (MA120 등)
};

// ─── 역사적 OHLCV 조회 ─────────────────────────────────────────────

async function fetchHistory(symbol, timeframe, days) {
  const secrets = loadSecrets();
  const ex = new ccxt.binance({
    apiKey: secrets.binance_api_key,
    secret: secrets.binance_api_secret,
  });

  const msPerBar = {
    '1h': 3600000, '4h': 14400000, '1d': 86400000,
  }[timeframe] || 86400000;

  const since = Date.now() - days * 86400000;
  const limit = Math.ceil((days * 86400000) / msPerBar) + 50;

  const ohlcv = await ex.fetchOHLCV(symbol, timeframe, since, Math.min(limit, 1000));
  return ohlcv; // [[ts, open, high, low, close, volume], ...]
}

// ─── 시뮬레이션 ─────────────────────────────────────────────────────

/**
 * 단일 심볼 백테스트
 */
function simulate(ohlcv, params = {}) {
  const {
    amountUsdt    = DEFAULTS.amountUsdt,
    commission    = DEFAULTS.commission,
    stopLossPct   = DEFAULTS.stopLossPct,
    takeProfitPct = DEFAULTS.takeProfitPct,
    minConfidence = DEFAULTS.minConfidence,
    warmupBars    = DEFAULTS.warmupBars,
  } = params;

  const trades    = [];
  let   cash      = 1000;       // 초기 가상 USDT
  let   position  = null;       // { entryPrice, qty, entryIdx }
  let   peakValue = cash;       // 최대 자산 (drawdown 계산용)
  let   maxDD     = 0;

  for (let i = warmupBars; i < ohlcv.length; i++) {
    const window = ohlcv.slice(0, i + 1);

    const closes  = window.map(c => c[4]);
    const highs   = window.map(c => c[2]);
    const lows    = window.map(c => c[3]);
    const volumes = window.map(c => c[5]);
    const price   = closes[closes.length - 1];

    // TA 지표
    const rsi   = calcRSI(closes);
    const macd  = calcMACD(closes);
    const bb    = calcBB(closes);
    const mas   = calcMovingAverages(closes);
    const stoch = calcStochastic(highs, lows, closes);
    const atr   = calcATR(highs, lows, closes);
    const vol   = analyzeVolume(volumes);

    const { signal, confidence } = judgeSignal({ rsi, macd, bb, currentPrice: price, mas, stoch, atr, vol });

    // 포지션 보유 중: 손절/익절/SELL 체크
    if (position) {
      const pnlPct = (price - position.entryPrice) / position.entryPrice;

      const shouldExit =
        pnlPct <= -stopLossPct         ||  // 손절
        pnlPct >=  takeProfitPct       ||  // 익절
        (signal === 'SELL' && confidence >= minConfidence);  // 신호 매도

      if (shouldExit) {
        const revenue  = position.qty * price * (1 - commission);
        const cost     = position.qty * position.entryPrice * (1 + commission);
        const realPnl  = revenue - cost;
        cash += revenue;

        const exitReason = pnlPct <= -stopLossPct ? 'STOP_LOSS'
          : pnlPct >= takeProfitPct              ? 'TAKE_PROFIT'
          : 'SIGNAL_SELL';

        trades.push({
          entryIdx:   position.entryIdx,
          exitIdx:    i,
          entryPrice: position.entryPrice,
          exitPrice:  price,
          qty:        position.qty,
          pnl:        realPnl,
          pnlPct:     pnlPct * 100,
          reason:     exitReason,
          holdBars:   i - position.entryIdx,
        });
        position = null;
      }
    }

    // 포지션 없음: BUY 신호 확인
    if (!position && signal === 'BUY' && confidence >= minConfidence) {
      const useAmount = Math.min(amountUsdt, cash);
      if (useAmount >= 10) {
        const cost = useAmount * (1 + commission);
        if (cash >= cost) {
          const qty = useAmount / price;
          cash -= cost;
          position = { entryPrice: price, qty, entryIdx: i };
        }
      }
    }

    // Drawdown 계산
    const totalValue = cash + (position ? position.qty * price : 0);
    if (totalValue > peakValue) peakValue = totalValue;
    const dd = (peakValue - totalValue) / peakValue;
    if (dd > maxDD) maxDD = dd;
  }

  // 미체결 포지션 강제 청산 (마지막 가격으로)
  if (position && ohlcv.length > 0) {
    const lastPrice = ohlcv[ohlcv.length - 1][4];
    const revenue   = position.qty * lastPrice * (1 - commission);
    const cost      = position.qty * position.entryPrice * (1 + commission);
    cash += revenue;
    trades.push({
      entryIdx: position.entryIdx, exitIdx: ohlcv.length - 1,
      entryPrice: position.entryPrice, exitPrice: lastPrice,
      qty: position.qty, pnl: revenue - cost,
      pnlPct: ((lastPrice - position.entryPrice) / position.entryPrice) * 100,
      reason: 'END_OF_DATA', holdBars: ohlcv.length - 1 - position.entryIdx,
    });
  }

  return { trades, finalCash: cash, maxDrawdown: maxDD };
}

// ─── 성과 지표 계산 ─────────────────────────────────────────────────

function calcMetrics(trades, initialCash, finalCash, maxDrawdown, ohlcv, params) {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netPnl      = grossProfit - grossLoss;
  const totalReturn = (finalCash - initialCash) / initialCash * 100;

  // 샤프 지수 (일간 수익률 표준편차 기반)
  const pnlPcts   = trades.map(t => t.pnlPct);
  const avgPnl    = pnlPcts.reduce((s, v) => s + v, 0) / (pnlPcts.length || 1);
  const variance  = pnlPcts.reduce((s, v) => s + (v - avgPnl) ** 2, 0) / (pnlPcts.length || 1);
  const stdDev    = Math.sqrt(variance);
  const sharpe    = stdDev > 0 ? (avgPnl / stdDev) * Math.sqrt(252) : 0;

  const avgHold   = trades.length > 0
    ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length
    : 0;

  return {
    totalTrades:  trades.length,
    winCount:     wins.length,
    lossCount:    losses.length,
    winRate:      trades.length > 0 ? wins.length / trades.length * 100 : 0,
    grossProfit,
    grossLoss,
    netPnl,
    totalReturn,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    maxDrawdown:  maxDrawdown * 100,
    sharpe,
    avgHoldBars:  avgHold,
  };
}

// ─── 리포트 포매터 ──────────────────────────────────────────────────

function formatReport(symbol, timeframe, days, metrics, trades) {
  const sign = (v) => v >= 0 ? '+' : '';
  const L = [];

  L.push(`📊 백테스트 — ${symbol} (${timeframe}, ${days}일)`);
  L.push('');
  L.push(`💱 총 거래: ${metrics.totalTrades}건 (${metrics.winCount}승 ${metrics.lossCount}패)`);
  L.push(`🎯 승률: ${metrics.winRate.toFixed(1)}%`);
  L.push(`💰 순손익: ${sign(metrics.netPnl)}$${metrics.netPnl.toFixed(2)} (${sign(metrics.totalReturn)}${metrics.totalReturn.toFixed(2)}%)`);
  L.push(`📈 수익 팩터: ${metrics.profitFactor.toFixed(2)}`);
  L.push(`📉 최대 낙폭: -${metrics.maxDrawdown.toFixed(2)}%`);
  L.push(`⚡ 샤프 지수: ${metrics.sharpe.toFixed(2)}`);
  L.push(`⏱ 평균 보유: ${metrics.avgHoldBars.toFixed(1)} 봉`);

  // 최근 5건 거래
  if (trades.length > 0) {
    L.push('');
    L.push('최근 거래 5건:');
    trades.slice(-5).forEach(t => {
      const icon   = t.pnl >= 0 ? '🟢' : '🔴';
      const reason = t.reason === 'STOP_LOSS' ? '손절' : t.reason === 'TAKE_PROFIT' ? '익절' : t.reason === 'SIGNAL_SELL' ? '신호' : '종료';
      L.push(`  ${icon} ${sign(t.pnlPct)}${t.pnlPct.toFixed(2)}% [${reason}] $${t.entryPrice.toFixed(0)}→$${t.exitPrice.toFixed(0)}`);
    });
  }

  return L.join('\n');
}

// ─── 메인 ──────────────────────────────────────────────────────────

async function runBacktest(symbol, options = {}) {
  const timeframe = options.timeframe || DEFAULTS.timeframe;
  const days      = options.days      || DEFAULTS.days;
  const send      = options.send      || false;

  console.log(`\n🔬 [백테스트] ${symbol} | ${timeframe} | ${days}일`);

  const ohlcv = await fetchHistory(symbol, timeframe, days);
  if (ohlcv.length < DEFAULTS.warmupBars + 20) {
    console.log(`  ⚠️ 데이터 부족 (${ohlcv.length}봉) → 스킵`);
    return null;
  }
  console.log(`  데이터: ${ohlcv.length}봉 로드 완료`);

  const initialCash = 1000;
  const params = {
    amountUsdt:    options.amount    || DEFAULTS.amountUsdt,
    stopLossPct:   options.stopLoss  || DEFAULTS.stopLossPct,
    takeProfitPct: options.takeProfit|| DEFAULTS.takeProfitPct,
    minConfidence: DEFAULTS.minConfidence,
    warmupBars:    DEFAULTS.warmupBars,
  };

  const { trades, finalCash, maxDrawdown } = simulate(ohlcv, params);
  const metrics = calcMetrics(trades, initialCash, finalCash, maxDrawdown, ohlcv, params);

  const report = formatReport(symbol, timeframe, days, metrics, trades);
  console.log('\n' + '─'.repeat(50));
  console.log(report);
  console.log('─'.repeat(50));

  if (send) {
    await sendTelegram(report);
    console.log('📱 텔레그램 전송 완료');
  }

  return { symbol, timeframe, days, metrics, trades };
}

async function runAll(options = {}) {
  const symbols = getSymbols();
  const results = [];

  for (const symbol of symbols) {
    try {
      const r = await runBacktest(symbol, options);
      if (r) results.push(r);
      await new Promise(res => setTimeout(res, 500)); // rate limit
    } catch (e) {
      console.error(`  ❌ ${symbol}: ${e.message}`);
    }
  }

  // 요약 비교표
  if (results.length > 1) {
    console.log('\n📋 심볼별 성과 비교:');
    console.log('  심볼         | 승률   | 수익률     | 팩터 | 낙폭   | 샤프');
    console.log('  -------------|--------|-----------|------|--------|------');
    results.forEach(r => {
      const m = r.metrics;
      console.log(
        `  ${r.symbol.padEnd(13)}| ${m.winRate.toFixed(0).padStart(5)}%` +
        ` | ${(m.totalReturn >= 0 ? '+' : '')}${m.totalReturn.toFixed(1).padStart(7)}%` +
        ` | ${m.profitFactor.toFixed(2).padStart(4)}` +
        ` | -${m.maxDrawdown.toFixed(1).padStart(5)}%` +
        ` | ${m.sharpe.toFixed(2)}`
      );
    });

    if (options.send) {
      const summaryLines = [
        '📊 백테스트 심볼별 비교',
        '',
        ...results.map(r => {
          const m  = r.metrics;
          const s  = m.totalReturn >= 0 ? '+' : '';
          return `${r.symbol}: 승률${m.winRate.toFixed(0)}% | ${s}${m.totalReturn.toFixed(1)}% | 낙폭-${m.maxDrawdown.toFixed(1)}% | 샤프${m.sharpe.toFixed(2)}`;
        }),
      ];
      await sendTelegram(summaryLines.join('\n'));
    }
  }

  return results;
}

// CLI
if (require.main === module) {
  const args        = process.argv.slice(2);
  const symbolArg   = args.find(a => a.startsWith('--symbol='))?.split('=')[1];
  const tfArg       = args.find(a => a.startsWith('--timeframe='))?.split('=')[1];
  const daysArg     = args.find(a => a.startsWith('--days='))?.split('=')[1];
  const amountArg   = args.find(a => a.startsWith('--amount='))?.split('=')[1];
  const slArg       = args.find(a => a.startsWith('--stop-loss='))?.split('=')[1];
  const tpArg       = args.find(a => a.startsWith('--take-profit='))?.split('=')[1];
  const all         = args.includes('--all');
  const send        = args.includes('--send');

  const options = {
    timeframe:  tfArg     || '1d',
    days:       parseInt(daysArg  || '365'),
    amount:     parseFloat(amountArg || '100'),
    stopLoss:   parseFloat(slArg  || '0.03'),
    takeProfit: parseFloat(tpArg  || '0.06'),
    send,
  };

  const run = all
    ? runAll(options)
    : runBacktest(symbolArg || 'BTC/USDT', options);

  run
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ 백테스트 오류:', e.message); process.exit(1); });
}

module.exports = { runBacktest, runAll };
