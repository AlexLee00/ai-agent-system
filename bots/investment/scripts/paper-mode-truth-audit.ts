#!/usr/bin/env node
// @ts-nocheck
/**
 * scripts/paper-mode-truth-audit.ts — Paper 모드 진실 감사
 *
 * getMarketExecutionModeInfo() 호출 결과 + 환경변수 + DB 데이터를 종합해
 * "진짜 실매매가 일어나고 있는가"를 판정한다.
 *
 * 실행:
 *   node scripts/paper-mode-truth-audit.ts
 *   node scripts/paper-mode-truth-audit.ts --dry-run   (텔레그램 발송 X)
 *   node scripts/paper-mode-truth-audit.ts --verbose
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const path = require('path');
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const { query, closeAll } = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool'));
const telegramSender      = require(path.join(PROJECT_ROOT, 'packages/core/lib/telegram-sender'));

import { getMarketExecutionModeInfo, getTradingMode, getInvestmentTradeMode } from '../shared/secrets.ts';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');
const SEP = '────────────────────';

// ─── 1. 모드 정보 수집 ──────────────────────────────────────────────

function collectModeInfo() {
  const tradingMode       = getTradingMode();
  const investmentMode    = getInvestmentTradeMode();
  const cryptoInfo        = getMarketExecutionModeInfo('crypto', '바이낸스');
  const stockInfo         = getMarketExecutionModeInfo('stocks', '국내주식');
  const overseasInfo      = getMarketExecutionModeInfo('kis_overseas', '해외주식');

  return {
    env: {
      PAPER_MODE:              process.env.PAPER_MODE ?? '(미설정)',
      INVESTMENT_TRADE_MODE:   process.env.INVESTMENT_TRADE_MODE ?? '(미설정)',
      NODE_ENV:                process.env.NODE_ENV ?? '(미설정)',
    },
    tradingMode,
    investmentMode,
    markets: { cryptoInfo, stockInfo, overseasInfo },
  };
}

// ─── 2. DB 진실 분석 ────────────────────────────────────────────────

async function analyzeTradesTable() {
  // 전체 분포
  const dist = await query('investment', `
    SELECT
      paper,
      trade_mode,
      COUNT(*) AS cnt
    FROM investment.trades
    GROUP BY paper, trade_mode
    ORDER BY paper ASC, trade_mode ASC
  `);

  // paper=false 중 거래소 주문 있는지 여부
  const orderCheck = await query('investment', `
    SELECT
      paper,
      trade_mode,
      COUNT(*) AS total,
      COUNT(tp_order_id)  AS has_tp,
      COUNT(sl_order_id)  AS has_sl,
      COUNT(CASE WHEN tp_order_id IS NOT NULL OR sl_order_id IS NOT NULL THEN 1 END) AS has_any_order
    FROM investment.trades
    WHERE paper = false
    GROUP BY paper, trade_mode
    ORDER BY trade_mode
  `);

  // 진짜 실매매 후보: paper=false + normal + tp_order_id 있음
  const trueReal = await query('investment', `
    SELECT COUNT(*) AS cnt
    FROM investment.trades
    WHERE paper = false
      AND trade_mode = 'normal'
      AND tp_order_id IS NOT NULL
  `);

  // PnL 분석 (paper=false 전체)
  const pnlByMarket = await query('investment', `
    SELECT
      exchange,
      trade_mode,
      COUNT(*) AS trades,
      ROUND(SUM(pnl_usdt)::numeric, 2) AS total_pnl_usdt,
      COUNT(CASE WHEN pnl_usdt > 0 THEN 1 END) AS wins
    FROM investment.trades
    WHERE paper = false
      AND pnl_usdt IS NOT NULL
    GROUP BY exchange, trade_mode
    ORDER BY exchange, trade_mode
  `);

  // validation 매매 상세
  const validationDetail = await query('investment', `
    SELECT
      exchange,
      COUNT(*) AS cnt,
      ROUND(SUM(pnl_usdt)::numeric, 2) AS pnl_usdt
    FROM investment.trades
    WHERE paper = false AND trade_mode = 'validation'
    GROUP BY exchange
    ORDER BY cnt DESC
  `);

  return { dist, orderCheck, trueReal, pnlByMarket, validationDetail };
}

// ─── 3. paper=false + NULL tp_order 샘플 ────────────────────────────

async function sampleNullOrderTrades() {
  return query('investment', `
    SELECT id, exchange, symbol, side, trade_mode, tp_order_id, sl_order_id,
           pnl_usdt, created_at
    FROM investment.trades
    WHERE paper = false
      AND tp_order_id IS NULL
      AND trade_mode = 'normal'
    ORDER BY created_at DESC
    LIMIT 5
  `);
}

// ─── 4. 보고서 생성 ─────────────────────────────────────────────────

function buildReport(modeInfo, dbResult, samples) {
  const { env, tradingMode, investmentMode, markets } = modeInfo;
  const { dist, orderCheck, trueReal, pnlByMarket, validationDetail } = dbResult;

  const isPaperForced   = tradingMode === 'paper';
  const isValidation    = investmentMode === 'validation';
  const trueRealCount   = Number(trueReal[0]?.cnt ?? 0);

  const statusEmoji = trueRealCount > 0 ? '✅' : '🚨';

  let msg = `${SEP}\n🔍 루나 Paper 모드 진실 감사\n${SEP}\n\n`;

  // 환경변수
  msg += `📌 환경변수\n`;
  msg += `  PAPER_MODE:            ${env.PAPER_MODE}\n`;
  msg += `  INVESTMENT_TRADE_MODE: ${env.INVESTMENT_TRADE_MODE}\n`;
  msg += `  NODE_ENV:              ${env.NODE_ENV}\n\n`;

  // 실행 모드
  msg += `⚙️ 실행 모드\n`;
  msg += `  getTradingMode():      ${tradingMode.toUpperCase()}  ${isPaperForced ? '← 🚨 PAPER 강제!' : '← ✅ LIVE'}\n`;
  msg += `  getInvestmentTradeMode(): ${investmentMode.toUpperCase()}  ${isValidation ? '← ⚠️ VALIDATION' : ''}\n\n`;

  // 시장별 모드
  msg += `📊 시장별 모드\n`;
  for (const [label, info] of [
    ['바이낸스(crypto)', markets.cryptoInfo],
    ['국내주식(stocks)', markets.stockInfo],
    ['해외주식(overseas)', markets.overseasInfo],
  ]) {
    msg += `  ${label}:\n`;
    msg += `    executionMode:   ${info.executionMode}  ${info.paper ? '🚨PAPER' : '✅LIVE'}\n`;
    msg += `    brokerAcctMode: ${info.brokerAccountMode}\n`;
    msg += `    investTradeMode: ${info.investmentTradeMode}\n`;
  }
  msg += '\n';

  // DB 분포
  msg += `📋 trades 테이블 분포\n`;
  for (const row of dist) {
    msg += `  paper=${String(row.paper).padEnd(5)} | mode=${String(row.trade_mode).padEnd(12)} | ${row.cnt}건\n`;
  }
  msg += '\n';

  // 거래소 주문 분석
  msg += `🔎 paper=false 거래소 주문 분석\n`;
  for (const row of orderCheck) {
    const hasOrderPct = Math.round((Number(row.has_any_order) / Number(row.total)) * 100);
    msg += `  mode=${String(row.trade_mode).padEnd(12)} | total=${row.total} | TP/SL있음=${row.has_any_order}건(${hasOrderPct}%)\n`;
  }
  msg += '\n';

  // 진짜 실매매
  msg += `${statusEmoji} 진짜 실매매 (paper=false + normal + tp_order 있음)\n`;
  msg += `  ${trueRealCount}건\n\n`;

  // PnL
  msg += `💰 paper=false PnL 분석\n`;
  for (const row of pnlByMarket) {
    const winRate = Math.round((Number(row.wins) / Number(row.trades)) * 100);
    msg += `  ${String(row.exchange).padEnd(14)} | ${row.trade_mode.padEnd(12)} | ${row.trades}건 | PnL=${row.total_pnl_usdt} USDT | 승률=${winRate}%\n`;
  }
  msg += '\n';

  // validation 상세
  if (validationDetail.length > 0) {
    msg += `⚠️ validation 매매 상세 (실거래 X)\n`;
    for (const row of validationDetail) {
      msg += `  ${String(row.exchange).padEnd(14)} | ${row.cnt}건 | PnL=${row.pnl_usdt} USDT\n`;
    }
    msg += '\n';
  }

  // 결론
  msg += `${SEP}\n`;
  if (isPaperForced) {
    msg += `🚨 결론: PAPER 모드 강제 — 실거래소 매매 없음\n`;
    msg += `  trading_mode 또는 PAPER_MODE 환경변수 확인 필요\n`;
  } else if (trueRealCount === 0) {
    msg += `🚨 결론: live 모드지만 진짜 실매매 0건\n`;
    msg += `  tp_order_id NULL = 거래소 TP/SL 주문 미발생\n`;
  } else {
    msg += `✅ 결론: 진짜 실매매 ${trueRealCount}건 확인됨\n`;
  }

  if (VERBOSE && samples.length > 0) {
    msg += `\n📌 paper=false+normal+tp_order_NULL 샘플 (최근 5건)\n`;
    for (const s of samples) {
      msg += `  [${s.id}] ${s.exchange} ${s.symbol} ${s.side} ${s.trade_mode} tp=${s.tp_order_id ?? 'NULL'} pnl=${s.pnl_usdt}\n`;
    }
  }

  msg += `${SEP}`;
  return msg;
}

// ─── main ────────────────────────────────────────────────────────────

async function main() {
  console.log('[paper-audit] 시작...');

  const modeInfo  = collectModeInfo();
  const dbResult  = await analyzeTradesTable();
  const samples   = await sampleNullOrderTrades();
  const report    = buildReport(modeInfo, dbResult, samples);

  console.log(report);

  if (!DRY_RUN) {
    await telegramSender.send('luna', report);
    console.log('[paper-audit] 텔레그램 발송 완료');
  } else {
    console.log('[paper-audit] --dry-run: 텔레그램 발송 생략');
  }

  await closeAll();
}

main().catch((err) => {
  console.error('[paper-audit] 오류:', err);
  closeAll().finally(() => process.exit(1));
});
